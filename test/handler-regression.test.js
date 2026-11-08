'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessages } = require('../src/handler');

const tools = [
  {
    name: 'Read',
    description: 'Read a workspace file',
    input_schema: {
      type: 'object',
      required: ['file_path'],
      properties: { file_path: { type: 'string', minLength: 1 } },
      additionalProperties: false
    }
  },
  {
    name: 'Bash',
    description: 'Run an explicitly permitted command',
    input_schema: {
      type: 'object',
      required: ['command'],
      properties: { command: { type: 'string', minLength: 1 } },
      additionalProperties: false
    }
  }
];

function body(options = {}) {
  return {
    model: 'byv-flash-v1',
    max_tokens: 256,
    stream: false,
    messages: [{ role: 'user', content: 'Use the requested tool.' }],
    tools,
    ...options
  };
}

function invocation(name, id, parameters) {
  const values = Object.entries(parameters).map(([key, value]) =>
    '<|BYV| parameter name="' + key + '" type="string">' +
    String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n') +
    '</|BYV| parameter>'
  ).join('');
  return '<|BYV| invoke name="' + name + '" id="' + id + '">' +
    values + '</|BYV| invoke>';
}

function calls(...items) {
  return '<|BYV| calls>' + items.join('') + '</|BYV| calls>';
}

function providerWith(responses, streaming = false) {
  let index = 0;
  const next = async () => {
    const item = responses[Math.min(index, responses.length - 1)];
    index++;
    return { text: item, reasoning: '', finish_reason: 'stop', usage: null };
  };
  return {
    getModelCapabilities: async () => null,
    createChatCompletion: streaming ? undefined : next,
    createStreamingChatCompletion: streaming ? next : undefined,
    get calls() { return index; }
  };
}

test('recovers a specific tool-choice mismatch and returns only the selected tool', async () => {
  const provider = providerWith([
    calls(invocation('Bash', 'wrong-tool', { command: 'pwd' })),
    calls(invocation('Read', 'right-tool', { file_path: 'README.md' }))
  ]);
  const result = await handleMessages(body({
    tool_choice: { type: 'tool', name: 'Read' }
  }), { noToolExperiment: true, nativeToolCalling: false, provider });

  assert.equal(provider.calls, 2);
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.toolCalls.map((call) => [call.id, call.name]), [
    ['right-tool', 'Read']
  ]);
});

test('recovers when tool_choice=any receives text instead of a tool invocation', async () => {
  const provider = providerWith([
    'I will explain this without a tool.',
    calls(invocation('Read', 'required-read', { file_path: 'README.md' }))
  ]);
  const result = await handleMessages(body({ tool_choice: 'any' }), { noToolExperiment: true, nativeToolCalling: false, provider });

  assert.equal(provider.calls, 2);
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.toolCalls[0].name, 'Read');
});

test('does not return a partial streaming tool batch when one invocation is invalid', async () => {
  const provider = providerWith([
    calls(
      invocation('Read', 'valid-but-uncommitted', { file_path: 'README.md' }),
      invocation('Bash', 'invalid-batch-member', {})
    ),
    calls(
      invocation('Read', 'recovered-read', { file_path: 'README.md' }),
      invocation('Bash', 'recovered-bash', { command: 'pwd' })
    )
  ], true);
  const result = await handleMessages(body({ stream: true }), { noToolExperiment: true, nativeToolCalling: false, provider });

  assert.equal(provider.calls, 2);
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.toolCalls.map((call) => call.id), [
    'recovered-read',
    'recovered-bash'
  ]);
  assert.ok(!result.toolCalls.some((call) => call.id === 'valid-but-uncommitted'));
});

test('returns an explicit error when malformed protocol recovery is exhausted', async () => {
  const provider = providerWith([
    '<|BYV| calls>',
    '<|BYV| calls>',
    '<|BYV| calls>'
  ]);

  await assert.rejects(
    handleMessages(body(), { noToolExperiment: true, nativeToolCalling: false, provider }),
    (error) => error.code === 'BYV_TOOL_CALL_RECOVERY_FAILED' && error.statusCode === 502
  );
  assert.equal(provider.calls, 3);
});
