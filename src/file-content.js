'use strict';

const MAX_PROVIDER_INLINE_FILE_BYTES = 90 * 1024 * 1024;

function fileError(message, statusCode, code) {
  return Object.assign(new Error(message), {
    statusCode,
    type: 'invalid_request_error',
    code
  });
}

function documentAsText(block, data, fallbackTitle) {
  const title = typeof block.title === 'string' && block.title.trim()
    ? block.title.trim()
    : fallbackTitle || 'document.txt';
  const context = typeof block.context === 'string' && block.context.trim()
    ? block.context.trim() + '\n\n'
    : '';
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  return {
    type: 'text',
    text: '[File: ' + title + ']\n' + context + text
  };
}

async function readStoredFile(fileStore, fileId) {
  const stored = await fileStore.read(fileId);
  if (!stored) {
    throw fileError('The referenced file_id was not found or has expired.', 404, 'FILE_NOT_FOUND');
  }
  if (stored.content.length > MAX_PROVIDER_INLINE_FILE_BYTES) {
    throw fileError(
      'This provider adapter inlines files into an OpenAI-compatible JSON request. The stored file is too large for safe inline forwarding; reduce it below 90 MiB or split it into smaller files.',
      413,
      'FILE_EXCEEDS_PROVIDER_INLINE_LIMIT'
    );
  }
  return stored;
}

async function resolveBlock(block, fileStore) {
  if (!block || typeof block !== 'object') return block;

  if (block.type === 'image' && block.source && block.source.type === 'file') {
    const stored = await readStoredFile(fileStore, block.source.file_id);
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(stored.metadata.mime_type)) {
      throw fileError('The referenced file is not a supported image for an image block.', 400, 'FILE_TYPE_MISMATCH');
    }
    return {
      ...block,
      source: {
        type: 'base64',
        media_type: stored.metadata.mime_type,
        data: stored.content.toString('base64')
      }
    };
  }

  if (block.type === 'document' && block.source) {
    const source = block.source;
    if (source.type === 'file') {
      const stored = await readStoredFile(fileStore, source.file_id);
      if (stored.metadata.mime_type === 'application/pdf') {
        return {
          ...block,
          title: block.title || stored.metadata.filename,
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: stored.content.toString('base64')
          }
        };
      }
      if (stored.metadata.mime_type === 'text/plain') {
        return documentAsText({ ...block, title: block.title || stored.metadata.filename }, stored.content);
      }
      throw fileError(
        'This MIME type is not supported by Anthropic document blocks. Use PDF or text/plain; convert DOCX/XLSX to text or PDF. Datasets require Code Execution container_upload, which this gateway does not provide.',
        400,
        'UNSUPPORTED_DOCUMENT_FILE_TYPE'
      );
    }
    if (source.type === 'base64' && source.media_type === 'text/plain') {
      const decoded = Buffer.from(source.data, 'base64');
      if (decoded.length > MAX_PROVIDER_INLINE_FILE_BYTES) {
        throw fileError('The text document is too large to forward safely.', 413, 'FILE_EXCEEDS_PROVIDER_INLINE_LIMIT');
      }
      return documentAsText(block, decoded);
    }
    if (source.type === 'text') {
      return documentAsText(block, source.data);
    }
  }

  if (block.type === 'container_upload') {
    throw fileError(
      'container_upload is part of Anthropic Code Execution. This OpenAI-compatible gateway does not implement a code-execution sandbox; send a supported PDF or text document instead.',
      400,
      'UNSUPPORTED_CONTAINER_UPLOAD'
    );
  }

  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    const content = [];
    for (const nested of block.content) content.push(await resolveBlock(nested, fileStore));
    return { ...block, content };
  }

  return block;
}

async function resolveFileReferences(body, fileStore) {
  if (!fileStore || !body || !Array.isArray(body.messages)) return body;
  const messages = [];
  for (const message of body.messages) {
    if (!message || !Array.isArray(message.content)) {
      messages.push(message);
      continue;
    }
    const content = [];
    for (const block of message.content) content.push(await resolveBlock(block, fileStore));
    messages.push({ ...message, content });
  }
  return { ...body, messages };
}

module.exports = {
  MAX_PROVIDER_INLINE_FILE_BYTES,
  documentAsText,
  resolveFileReferences
};
