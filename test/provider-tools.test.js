'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  providerToolChoice,
  providerFunctionTools,
  decodeProviderToolCalls,
  mergeProviderToolCallDelta,
  finalizeProviderToolCallDeltas
} = require('../src/provider/tool-calls');

test('maps Anthropic tools to OpenAI-compatible function tools without changing schemas', () => {
  const schema = {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
    additionalProperties: false
  };
  assert.deepEqual(providerFunctionTools([{
    name: 'Read',
    description: 'Read a file',
    input_schema: schema
  }]), [{
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file',
      parameters: schema
    }
  }]);
});

test('maps Anthropic tool_choice values to provider-native function tool choices', () => {
  assert.equal(providerToolChoice(undefined), 'auto');
  assert.equal(providerToolChoice('auto'), 'auto');
  assert.equal(providerToolChoice('none'), 'none');
  assert.equal(providerToolChoice('any'), 'required');
  assert.deepEqual(providerToolChoice({ type: 'tool', name: 'Read' }), {
    type: 'function',
    function: { name: 'Read' }
  });
});

test('rejects function names that the OpenAI-compatible tool contract cannot represent', () => {
  assert.throws(
    () => providerFunctionTools([{ name: 'Read.file', input_schema: { type: 'object' } }]),
    /at most 64 characters/
  );
});

test('decodes native provider function JSON into canonical in-memory call objects', () => {
  const result = decodeProviderToolCalls([{
    id: 'call_provider_1',
    type: 'function',
    function: { name: 'Read', arguments: '{"file_path":"README.md"}' }
  }]);
  assert.deepEqual(result, {
    calls: [{
      id: 'call_provider_1',
      name: 'Read',
      input: { file_path: 'README.md' }
    }],
    error: null
  });
});

test('rejects malformed, non-object, and duplicate native provider function arguments', () => {
  assert.match(decodeProviderToolCalls([{
    id: 'bad',
    type: 'function',
    function: { name: 'Read', arguments: '{bad json' }
  }]).error, /invalid JSON arguments/);

  assert.match(decodeProviderToolCalls([{
    id: 'bad',
    type: 'function',
    function: { name: 'Read', arguments: '[]' }
  }]).error, /must be a JSON object/);

  assert.match(decodeProviderToolCalls([
    { id: 'duplicate', type: 'function', function: { name: 'Read', arguments: '{}' } },
    { id: 'duplicate', type: 'function', function: { name: 'Write', arguments: '{}' } }
  ]).error, /duplicate tool-call ID/);
});

test('generates an invocation ID if the provider omits one', () => {
  const result = decodeProviderToolCalls([{
    type: 'function',
    function: { name: 'Read', arguments: '{}' }
  }], () => 'call_generated');
  assert.equal(result.calls[0].id, 'call_generated');
});

test('accumulates streamed function names and JSON arguments by tool-call index', () => {
  const deltas = new Map();
  mergeProviderToolCallDelta(deltas, [{
    index: 0,
    id: 'call_stream_1',
    type: 'function',
    function: { name: 'Re', arguments: '{"file_' }
  }]);
  mergeProviderToolCallDelta(deltas, [{
    index: 0,
    function: { name: 'ad', arguments: 'path":"README.md"}' }
  }]);
  assert.deepEqual(finalizeProviderToolCallDeltas(deltas), [{
    id: 'call_stream_1',
    type: 'function',
    function: { name: 'Read', arguments: '{"file_path":"README.md"}' }
  }]);
});
