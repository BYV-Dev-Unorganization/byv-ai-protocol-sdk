'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  providerToolChoice,
  providerFunctionTools,
  createProviderToolNameMap,
  restoreProviderToolCallNames,
  normalizeProviderToolCalls,
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

test('maps invalid and colliding Anthropic tool names to unique provider-safe aliases', () => {
  const tools = [
    { name: 'mcp__github.search_repositories', input_schema: { type: 'object' } },
    { name: 'mcp__github_search_repositories', input_schema: { type: 'object' } },
    { name: 'very_long_tool_name_' + 'x'.repeat(80), input_schema: { type: 'object' } }
  ];
  const nameMap = createProviderToolNameMap(tools);

  const dotted = nameMap.originalToProvider.get('mcp__github.search_repositories');
  const valid = nameMap.originalToProvider.get('mcp__github_search_repositories');
  const long = nameMap.originalToProvider.get(tools[2].name);

  assert.equal(dotted, 'mcp__github_search_repositories_2');
  assert.equal(valid, 'mcp__github_search_repositories');
  assert.match(long, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(nameMap.providerToOriginal.get(dotted), 'mcp__github.search_repositories');
  assert.equal(nameMap.providerToOriginal.get(long), tools[2].name);

  const providerTools = providerFunctionTools(tools, nameMap);
  assert.equal(providerTools[0].function.name, dotted);
  assert.equal(providerTools[1].function.name, valid);

  assert.deepEqual(restoreProviderToolCallNames([
    { id: 'call_1', name: dotted, input: {} },
    { id: 'call_2', name: long, input: {} }
  ], nameMap), [
    { id: 'call_1', name: 'mcp__github.search_repositories', input: {} },
    { id: 'call_2', name: tools[2].name, input: {} }
  ]);
});

test('maps a named Anthropic tool_choice through the provider-safe name map', () => {
  const tools = [{ name: 'mcp__filesystem.read_file', input_schema: { type: 'object' } }];
  const nameMap = createProviderToolNameMap(tools);
  assert.deepEqual(providerToolChoice({ type: 'tool', name: tools[0].name }, nameMap), {
    type: 'function',
    function: { name: 'mcp__filesystem_read_file' }
  });
});

test('rejects duplicate original tool names before building a provider name map', () => {
  assert.throws(() => createProviderToolNameMap([
    { name: 'Read', input_schema: { type: 'object' } },
    { name: 'Read', input_schema: { type: 'object' } }
  ]), /Duplicate tool name/);
});

test('normalizes provider function calls into validated Anthropic tool-call candidates', () => {
  const result = normalizeProviderToolCalls([{
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

test('rejects malformed, non-object, and duplicate provider function arguments', () => {
  assert.match(normalizeProviderToolCalls([{
    id: 'bad',
    type: 'function',
    function: { name: 'Read', arguments: '{bad json' }
  }]).error, /invalid JSON arguments/);

  assert.match(normalizeProviderToolCalls([{
    id: 'bad',
    type: 'function',
    function: { name: 'Read', arguments: '[]' }
  }]).error, /must be a JSON object/);

  assert.match(normalizeProviderToolCalls([
    { id: 'duplicate', type: 'function', function: { name: 'Read', arguments: '{}' } },
    { id: 'duplicate', type: 'function', function: { name: 'Write', arguments: '{}' } }
  ]).error, /duplicate tool-call ID/);
});

test('generates an invocation ID if the provider omits one', () => {
  const result = normalizeProviderToolCalls([{
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
