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


test('accepts supported base64 and HTTP(S) image blocks', () => {
  const imageBlocks = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    { type: 'image', source: { type: 'url', url: 'https://images.example.test/photo.webp' } }
  ];

  assert.equal(validateMessagesRequest({
    ...minimal,
    messages: [{ role: 'user', content: imageBlocks }]
  }), null);
});

test('rejects unsupported image MIME types, malformed base64, unsafe URLs, and file references', () => {
  const invalidImages = [
    { type: 'image', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERiQ=' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not base64!' } },
    { type: 'image', source: { type: 'url', url: 'file:///etc/passwd' } },
    { type: 'image', source: { type: 'file', file_id: 'file_0123456789abcdef01234567' } }
  ];

  for (const image of invalidImages) {
    assert.match(validateMessagesRequest({
      ...minimal,
      messages: [{ role: 'user', content: [image] }]
    }).message, /unsupported block type or invalid image source/);
  }
});

test('rejects document, file, and container-upload blocks before provider conversion', () => {
  const unsupportedBlocks = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERiQ=' } },
    { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERiQ=' } },
    { type: 'container_upload', file_id: 'file_0123456789abcdef01234567' }
  ];

  for (const block of unsupportedBlocks) {
    assert.match(validateMessagesRequest({
      ...minimal,
      messages: [{ role: 'user', content: [block] }]
    }).message, /client-side skill or tool/);
  }
});

test('accepts image blocks inside tool results but rejects nested file and document blocks', () => {
  const toolUse = { type: 'tool_use', id: 'call_image', name: 'Screenshot', input: {} };
  const imageResult = {
    type: 'tool_result',
    tool_use_id: 'call_image',
    content: [
      { type: 'text', text: 'Screenshot captured.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
    ]
  };

  assert.equal(validateMessagesRequest({
    ...minimal,
    messages: [
      { role: 'assistant', content: [toolUse] },
      { role: 'user', content: [imageResult] }
    ]
  }), null);

  for (const attachment of [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERiQ=' } },
    { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERiQ=' } }
  ]) {
    assert.match(validateMessagesRequest({
      ...minimal,
      messages: [
        { role: 'assistant', content: [toolUse] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_image',
            content: [attachment]
          }]
        }
      ]
    }).message, /client-side skill or tool/);
  }
});

test('rejects image blocks in assistant messages', () => {
  assert.match(validateMessagesRequest({
    ...minimal,
    messages: [{
      role: 'assistant',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }]
    }]
  }).message, /image blocks must appear in user messages/);
});


test('rejects file and document attachment shapes nested inside structured tool-result JSON', () => {
  const error = validateMessagesRequest({
    ...minimal,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_structured_file', name: 'Read', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_structured_file',
          content: {
            result: {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERiQ=' }
            }
          }
        }]
      }
    ]
  });

  assert.match(error.message, /client-side skill or tool/);
});
