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
