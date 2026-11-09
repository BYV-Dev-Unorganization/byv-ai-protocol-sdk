'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMessagesRequest, normalizeAnthropicMessagesRequest } = require('../src/anthropic-contract');

const minimal = {
  model: 'claude-sonnet-5-5',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'Hello' }]
};

test('accepts a basic Anthropic Messages request', () => {
  assert.equal(validateMessagesRequest(minimal), null);
});

test('validates required fields, message roles, and content block types', () => {
  assert.match(validateMessagesRequest({ ...minimal, max_tokens: 0 }).message, /max_tokens/);
  assert.match(validateMessagesRequest({ ...minimal, messages: [] }).message, /messages/);
  assert.match(validateMessagesRequest({ ...minimal, messages: [{ role: 'system', content: 'x' }] }).message, /role/);
  assert.match(validateMessagesRequest({ ...minimal, messages: [{ role: 'user', content: [{ type: 'image' }] }] }).message, /unsupported/);
});

test('accepts supported base64 and URL image blocks and rejects malformed image sources', () => {
  const base64Image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }
  };
  const urlImage = {
    type: 'image',
    source: { type: 'url', url: 'https://images.example.test/photo.webp' }
  };

  assert.equal(validateMessagesRequest({
    ...minimal,
    messages: [{ role: 'user', content: [base64Image, urlImage] }]
  }), null);
  assert.match(validateMessagesRequest({
    ...minimal,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'text/plain', data: 'aGVsbG8=' } }] }]
  }).message, /unsupported block type/);
  assert.match(validateMessagesRequest({
    ...minimal,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'file:///etc/passwd' } }] }]
  }).message, /unsupported block type/);
  assert.match(validateMessagesRequest({
    ...minimal,
    messages: [{ role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }]
  }).message, /image blocks must appear in user messages/);
});

test('rejects PDF, document, generic file, file-ID, and container-upload attachments', () => {
  const unsupported = [
    { type: 'document', title: 'report.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERiQ=' } },
    { type: 'document', source: { type: 'text', data: 'document text' } },
    { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERiQ=' } },
    { type: 'container_upload', file_id: 'file_123' },
    { type: 'image', source: { type: 'file', file_id: 'file_0123456789abcdef01234567' } }
  ];

  for (const block of unsupported) {
    const error = validateMessagesRequest({
      ...minimal,
      messages: [{ role: 'user', content: [block] }]
    });
    assert.ok(error);
    assert.match(error.message, /Claude client-side skill or tool/);
  }
});

test('accepts additional structured Anthropic and MCP tool-result content blocks', () => {
  const request = {
    ...minimal,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_lookup', name: 'Lookup', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_lookup',
          content: [
            { type: 'text', text: 'Found one result.' },
            { type: 'search_result', title: 'Example', url: 'https://example.test' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
          ]
        }]
      }
    ]
  };

  assert.equal(validateMessagesRequest(request), null);
  assert.equal(validateMessagesRequest({
    ...minimal,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_json', name: 'Lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_json', content: { matches: [{ id: 1, title: 'Example' }] } }] }
    ]
  }), null);
  assert.match(validateMessagesRequest({
    ...minimal,
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_missing',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'text/plain', data: 'aGVsbG8=' } }]
      }]
    }]
  }).message, /Tool results cannot contain raw files or documents/);
});

test('rejects file and document payloads nested inside structured tool results', () => {
  const result = validateMessagesRequest({
    ...minimal,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_file', name: 'Read', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_file',
          content: {
            result: {
              document: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERiQ=' } },
              attachment: { type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERiQ=' } }
            }
          }
        }]
      }
    ]
  });
  assert.ok(result);
  assert.match(result.message, /Tool results cannot contain raw files or documents/);
});

test('validates tool schemas and tool_choice references', () => {
  const tools = [{
    name: 'Read',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
  }];
  assert.equal(validateMessagesRequest({ ...minimal, tools, tool_choice: { type: 'tool', name: 'Read' } }), null);
  assert.match(validateMessagesRequest({ ...minimal, tools, tool_choice: { type: 'tool', name: 'Write' } }).message, /unavailable/);
  assert.match(validateMessagesRequest({ ...minimal, tool_choice: 'any' }).message, /requires at least one/);
});

test('normalizes system and developer role messages without mutating the request', () => {
  const request = {
    ...minimal,
    system: 'Base instructions',
    messages: [
      { role: 'user', content: 'Start' },
      { role: 'developer', content: 'Developer instructions' },
      { role: 'assistant', content: 'Ready' }
    ]
  };
  const normalized = normalizeAnthropicMessagesRequest(request);
  assert.equal(normalized.normalizedInstructionMessages, 1);
  assert.equal(normalized.body.system.length, 2);
  assert.equal(normalized.body.messages.length, 2);
  assert.equal(request.messages[1].role, 'developer');
  assert.equal(validateMessagesRequest(normalized.body), null);
});

test('validates optional generation parameters', () => {
  assert.equal(validateMessagesRequest({ ...minimal, temperature: 0.2, top_p: 0.9, stop_sequences: ['END'] }), null);
  assert.match(validateMessagesRequest({ ...minimal, temperature: 2 }).message, /temperature/);
  assert.match(validateMessagesRequest({ ...minimal, output_config: { effort: 'extreme' } }).message, /effort/);
});

test('rejects tool blocks placed in the wrong message role', () => {
  assert.match(validateMessagesRequest({
    ...minimal,
    messages: [{ role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] }]
  }).message, /tool_result blocks must appear in user messages/);
  assert.match(validateMessagesRequest({
    ...minimal,
    messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] }]
  }).message, /tool_use blocks must appear in assistant messages/);
});

test('rejects invalid JSON Schema declarations before calling the provider', () => {
  const invalid = {
    ...minimal,
    tools: [{
      name: 'Broken',
      input_schema: { type: 'not-a-json-schema-type' }
    }]
  };
  assert.match(validateMessagesRequest(invalid).message, /input_schema is invalid/);
});


test('accepts JSON Schema Draft 2020-12 tool declarations', () => {
  const tools = [{
    name: 'Read',
    input_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      allOf: [{
        properties: {
          file_path: { type: 'string', minLength: 1 }
        }
      }],
      required: ['file_path'],
      unevaluatedProperties: false
    }
  }];
  assert.equal(validateMessagesRequest({ ...minimal, tools }), null);
});
