'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveFileReferences } = require('../src/file-content');

function createStore(entries) {
  return {
    async read(id) {
      return entries[id] || null;
    }
  };
}

test('resolves PDF and plain-text document file IDs before provider conversion', async () => {
  const store = createStore({
    file_pdf: {
      metadata: { filename: 'report.pdf', mime_type: 'application/pdf' },
      content: Buffer.from('%PDF-1.7')
    },
    file_text: {
      metadata: { filename: 'notes.txt', mime_type: 'text/plain' },
      content: Buffer.from('hello from file')
    }
  });
  const body = await resolveFileReferences({
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'file', file_id: 'file_pdf' } },
        { type: 'document', context: 'Keep this note.', source: { type: 'file', file_id: 'file_text' } }
      ]
    }]
  }, {
    async read(id) {
      const key = id === 'file_pdf' ? 'file_pdf' : id === 'file_text' ? 'file_text' : null;
      return key ? store.read(key) : null;
    }
  });

  assert.equal(body.messages[0].content[0].title, 'report.pdf');
  assert.equal(body.messages[0].content[0].source.media_type, 'application/pdf');
  assert.equal(Buffer.from(body.messages[0].content[0].source.data, 'base64').toString('utf8'), '%PDF-1.7');
  assert.deepEqual(body.messages[0].content[1], {
    type: 'text',
    text: '[File: notes.txt]\nKeep this note.\n\nhello from file'
  });
});

test('resolves stored image files and recursively resolves tool-result attachments', async () => {
  const entries = {
    file_image: {
      metadata: { filename: 'photo.png', mime_type: 'image/png' },
      content: Buffer.from('image-bytes')
    },
    file_text: {
      metadata: { filename: 'tool.txt', mime_type: 'text/plain' },
      content: Buffer.from('tool output')
    }
  };
  const body = await resolveFileReferences({
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: [
          { type: 'image', source: { type: 'file', file_id: 'file_image' } },
          { type: 'document', source: { type: 'file', file_id: 'file_text' } }
        ]
      }]
    }]
  }, { read: async (id) => entries[id] || null });

  const content = body.messages[0].content[0].content;
  assert.equal(content[0].source.type, 'base64');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(Buffer.from(content[0].source.data, 'base64').toString('utf8'), 'image-bytes');
  assert.deepEqual(content[1], { type: 'text', text: '[File: tool.txt]\ntool output' });
});

test('rejects unknown, oversized, mismatched, and unsupported container-upload files', async () => {
  await assert.rejects(
    resolveFileReferences({ messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'file', file_id: 'missing' } }
    ] }] }, { read: async () => null }),
    (error) => error.code === 'FILE_NOT_FOUND' && error.statusCode === 404
  );

  await assert.rejects(
    resolveFileReferences({ messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'file', file_id: 'big' } }
    ] }] }, { read: async () => ({ metadata: { mime_type: 'application/pdf' }, content: Buffer.alloc(90 * 1024 * 1024 + 1) }) }),
    (error) => error.code === 'FILE_EXCEEDS_PROVIDER_INLINE_LIMIT' && error.statusCode === 413
  );

  await assert.rejects(
    resolveFileReferences({ messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'file', file_id: 'image' } }
    ] }] }, { read: async () => ({ metadata: { filename: 'x.png', mime_type: 'image/png' }, content: Buffer.from('x') }) }),
    (error) => error.code === 'UNSUPPORTED_DOCUMENT_FILE_TYPE' && error.statusCode === 400
  );

  await assert.rejects(
    resolveFileReferences({ messages: [{ role: 'user', content: [
      { type: 'container_upload', file_id: 'dataset' }
    ] }] }, { read: async () => null }),
    (error) => error.code === 'UNSUPPORTED_CONTAINER_UPLOAD' && error.statusCode === 400
  );
});
