'use strict';

const { compileJsonSchema } = require('./tools/json-schema');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
]);

function validImageSource(source) {
  if (!isPlainObject(source)) return false;
  if (source.type === 'base64') {
    return IMAGE_MEDIA_TYPES.has(source.media_type) &&
      typeof source.data === 'string' &&
      source.data.length > 0 &&
      source.data.length % 4 === 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data);
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    try {
      const url = new URL(source.url);
      return ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password;
    } catch {
      return false;
    }
  }
  return false;
}

function validDocumentSource(source) {
  if (!isPlainObject(source)) return false;
  if (source.type === 'base64') {
    return typeof source.media_type === 'string' &&
      /^[a-z0-9!#$&^_.+-]+\\/[a-z0-9!#$&^_.+-]+$/i.test(source.media_type) &&
      !/^(?:image|audio|video)\\//i.test(source.media_type) &&
      typeof source.data === 'string' &&
      source.data.length > 0 &&
      source.data.length % 4 === 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data);
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    try {
      const url = new URL(source.url);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }
  if (source.type === 'file') {
    return typeof source.file_id === 'string' && source.file_id.trim().length > 0;
  }
  return false;
}

function validContent(content, allowedTypes) {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.every((block) => {
    if (!isPlainObject(block) ||
        typeof block.type !== 'string' ||
        !allowedTypes.includes(block.type)) return false;
    if (block.type === 'image') return validImageSource(block.source);
    if (block.type === 'document') {
      return validDocumentSource(block.source) &&
        (block.title === undefined || typeof block.title === 'string') &&
        (block.context === undefined || typeof block.context === 'string');
    }
    if (block.type === 'container_upload') {
      return typeof block.file_id === 'string' && block.file_id.trim().length > 0;
    }
    if (block.type === 'text') return typeof block.text === 'string';
    return true;
  });
}

function validToolResultContent(content) {
  if (content === undefined) return false;
  if (typeof content === 'string') return true;
  // Some tool integrations return structured JSON values rather than the
  // Anthropic string/array form. The provider adapter serializes these as JSON.
  if (!Array.isArray(content)) return true;
  return content.every((block) => {
    if (!isPlainObject(block) || typeof block.type !== 'string') return false;
    if (block.type === 'image') return validImageSource(block.source);
    if (block.type === 'document') {
      if (block.source && block.source.type === 'text') return typeof block.source.data === 'string';
      return validDocumentSource(block.source);
    }
    if (block.type === 'container_upload') return typeof block.file_id === 'string' && block.file_id.trim().length > 0;
    if (block.type === 'text') return typeof block.text === 'string';
    // Tool results may contain additional Anthropic/MCP content block types
    // (for example document, resource, or search-result blocks). Preserve
    // these as structured context instead of rejecting the whole request.
    return true;
  });
}

function validateMessagesRequest(body, options = {}) {
  const countTokens = options.countTokens === true;
  const allowedBlocks = ['text', 'image', 'document', 'container_upload', 'tool_use', 'tool_result'];

  if (!isPlainObject(body)) {
    return { type: 'invalid_request_error', message: 'Request body must be a JSON object.' };
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    return { type: 'invalid_request_error', message: 'Field model must be a non-empty string.' };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { type: 'invalid_request_error', message: 'Field messages must be a non-empty array.' };
  }
  if (!countTokens && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) {
    return { type: 'invalid_request_error', message: 'Field max_tokens must be a positive integer.' };
  }
  if (body.system !== undefined && !validContent(body.system, ['text'])) {
    return { type: 'invalid_request_error', message: 'Field system must be a string or an array of text blocks.' };
  }

  for (let i = 0; i < body.messages.length; i++) {
    const message = body.messages[i];
    if (!isPlainObject(message)) {
      return { type: 'invalid_request_error', message: 'messages[' + i + '] must be an object.' };
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      return { type: 'invalid_request_error', message: 'messages[' + i + '].role must be user or assistant.' };
    }
    if (!validContent(message.content, allowedBlocks)) {
      return { type: 'invalid_request_error', message: 'messages[' + i + '].content contains an unsupported block type.' };
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (message.role === 'assistant' && block.type === 'tool_result') {
        return { type: 'invalid_request_error', message: 'tool_result blocks must appear in user messages.' };
      }
      if (message.role === 'assistant' && ['image', 'document', 'container_upload'].includes(block.type)) {
        return { type: 'invalid_request_error', message: block.type + ' blocks must appear in user messages.' };
      }
      if (message.role === 'user' && block.type === 'tool_use') {
        return { type: 'invalid_request_error', message: 'tool_use blocks must appear in assistant messages.' };
      }
      if (block.type === 'text' && typeof block.text !== 'string') {
        return { type: 'invalid_request_error', message: 'Text blocks require a string text field.' };
      }
      if (block.type === 'document' && !validDocumentSource(block.source)) {
        return { type: 'invalid_request_error', message: 'Document blocks require a valid base64, URL, or file_id source.' };
      }
      if (block.type === 'container_upload' &&
          (typeof block.file_id !== 'string' || !block.file_id.trim())) {
        return { type: 'invalid_request_error', message: 'container_upload blocks require a non-empty file_id.' };
      }
      if (block.type === 'tool_use' &&
          (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !isPlainObject(block.input))) {
        return { type: 'invalid_request_error', message: 'tool_use blocks require id, name, and object input fields.' };
      }
      if (block.type === 'tool_result' &&
          (typeof block.tool_use_id !== 'string' || !block.tool_use_id || block.content === undefined)) {
        return { type: 'invalid_request_error', message: 'tool_result blocks require tool_use_id and content.' };
      }
      if (block.type === 'tool_result' && !validToolResultContent(block.content)) {
        return { type: 'invalid_request_error', message: 'tool_result content must be a JSON value or an array of content blocks.' };
      }
    }
  }

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return { type: 'invalid_request_error', message: 'Field tools must be an array.' };
    }
    const names = new Set();
    for (let i = 0; i < body.tools.length; i++) {
      const tool = body.tools[i];
      if (!isPlainObject(tool) || typeof tool.name !== 'string' || !tool.name.trim()) {
        return { type: 'invalid_request_error', message: 'tools[' + i + '] must have a non-empty name.' };
      }
      if (names.has(tool.name)) {
        return { type: 'invalid_request_error', message: 'Tool names must be unique: ' + tool.name };
      }
      names.add(tool.name);
      if (!isPlainObject(tool.input_schema)) {
        return { type: 'invalid_request_error', message: 'tools[' + i + '].input_schema must be an object.' };
      }
      try {
        compileJsonSchema(tool.input_schema);
      } catch (error) {
        return { type: 'invalid_request_error', message: 'tools[' + i + '].input_schema is invalid: ' + error.message };
      }
    }
  }

  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    const validString = typeof choice === 'string' && ['auto', 'any', 'none'].includes(choice);
    const validObject = isPlainObject(choice) && (
      ['auto', 'any', 'none'].includes(choice.type) ||
      (choice.type === 'tool' && typeof choice.name === 'string' && choice.name.trim())
    );
    if (!validString && !validObject) {
      return { type: 'invalid_request_error', message: 'Field tool_choice is invalid.' };
    }
    if ((choice === 'any' || (isPlainObject(choice) && choice.type === 'any')) &&
        (!Array.isArray(body.tools) || body.tools.length === 0)) {
      return { type: 'invalid_request_error', message: 'tool_choice any requires at least one declared tool.' };
    }
    if (isPlainObject(choice) && choice.type === 'tool' &&
        (!Array.isArray(body.tools) || !body.tools.some((tool) => tool.name === choice.name))) {
      return { type: 'invalid_request_error', message: 'tool_choice references an unavailable tool: ' + choice.name };
    }
  }

  if (body.output_config !== undefined && body.output_config !== null) {
    if (!isPlainObject(body.output_config)) {
      return { type: 'invalid_request_error', message: 'Field output_config must be an object or null.' };
    }
    const effort = body.output_config.effort;
    if (effort !== undefined && effort !== null &&
        !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      return { type: 'invalid_request_error', message: 'output_config.effort must be low, medium, high, xhigh, or max.' };
    }
  }

  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return { type: 'invalid_request_error', message: 'Field stream must be a boolean.' };
  }
  for (const field of ['temperature', 'top_p']) {
    if (body[field] !== undefined &&
        (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0 || body[field] > 1)) {
      return { type: 'invalid_request_error', message: 'Field ' + field + ' must be a finite number between 0 and 1.' };
    }
  }
  if (body.stop_sequences !== undefined &&
      (!Array.isArray(body.stop_sequences) || !body.stop_sequences.every((item) => typeof item === 'string'))) {
    return { type: 'invalid_request_error', message: 'Field stop_sequences must be an array of strings.' };
  }

  return null;
}

function normalizeAnthropicMessagesRequest(body) {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) {
    return { body, normalizedInstructionMessages: 0 };
  }
  const systemBlocks = [];
  const messages = [];
  let count = 0;

  if (typeof body.system === 'string') {
    systemBlocks.push({ type: 'text', text: body.system });
  } else if (Array.isArray(body.system)) {
    systemBlocks.push(...body.system);
  }

  for (const message of body.messages) {
    if (isPlainObject(message) &&
        (message.role === 'system' || message.role === 'developer') &&
        validContent(message.content, ['text'])) {
      count++;
      if (typeof message.content === 'string') systemBlocks.push({ type: 'text', text: message.content });
      else systemBlocks.push(...message.content);
    } else {
      messages.push(message);
    }
  }

  if (!count) return { body, normalizedInstructionMessages: 0 };
  return { body: { ...body, system: systemBlocks, messages }, normalizedInstructionMessages: count };
}

module.exports = { isPlainObject, validContent, validDocumentSource, validToolResultContent, validateMessagesRequest, normalizeAnthropicMessagesRequest };