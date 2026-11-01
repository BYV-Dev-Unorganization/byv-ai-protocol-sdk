'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessages, normalizeUsage, detectToolLoop } = require('../src/handler');

function body(options = {}) {
  return {
    model: 'claude-sonnet-5-5',
    max_tokens: 256,
    stream: false,
    messages: [{ role: 'user', content: 'Read README.md.' }],
    tools: [{
      name: 'Read',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        required: ['file_path'],
        properties: { file_path: { type: 'string' } }
      }
    }],
    ...options
  };
}

test('detects repeated identical tool calls in conversation history', () => {
  const messages = [1, 2, 3].flatMap((index) => [
    {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'call_' + index,
        name: 'Bash',
        input: { command: 'pwd' }
      }]
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_' + index, content: '/workspace' }]
    }
  ]);
  assert.equal(detectToolLoop(messages, 3), true);
  assert.equal(detectToolLoop(messages, 4), false);
});

test('forces a text response after three identical tool calls', async () => {
  const messages = [
    { role: 'user', content: 'Show the current directory.' },
    ...[1, 2, 3].flatMap((index) => [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_' + index,
          name: 'Bash',
          input: { command: 'pwd' }
        }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_' + index, content: '/workspace' }]
      }
    ])
  ];
  let providerMessages;
  const result = await handleMessages(body({
    messages,
    tool_choice: 'auto'
  }), {
    provider: {
      createChatCompletion: async (messages) => {
        providerMessages = messages;
        return { text: 'The same command has already been repeated; no further tool call is needed.', finish_reason: 'stop', usage: null };
      }
    }
  });
  assert.match(providerMessages[0].content, /STOP: DO NOT CALL TOOLS/);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.toolCalls.length, 0);
});

test('converts valid BYV model output into Anthropic tool_use blocks', async () => {
  const output = '<|BYV| calls><|BYV| invoke name="Read" id="call_abc">' +
    '<|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter>' +
    '</|BYV| invoke></|BYV| calls>';
  const result = await handleMessages(body(), {
    provider: {
      createChatCompletion: async () => ({ text: output, reasoning: '', finish_reason: 'stop', usage: null })
    }
  });
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0], {
    type: 'tool_use',
    id: 'call_abc',
    name: 'Read',
    input: { file_path: 'README.md' }
  });
});

test('converts native provider function calls into Anthropic tool_use blocks', async () => {
  let receivedOptions;
  const result = await handleMessages(body({ tool_choice: 'auto' }), {
    provider: {
      createChatCompletion: async (_messages, options) => {
        receivedOptions = options;
        return {
          text: '',
          tool_calls: [{
            id: 'call_native_read',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"file_path":"README.md"}'
            }
          }],
          finish_reason: 'tool_calls',
          usage: null
        };
      }
    }
  });

  assert.equal(receivedOptions.tool_choice, 'auto');
  assert.equal(receivedOptions.tools[0].name, 'Read');
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0], {
    type: 'tool_use',
    id: 'call_native_read',
    name: 'Read',
    input: { file_path: 'README.md' }
  });
});

test('converts streamed native provider function calls into Anthropic tool_use blocks', async () => {
  let receivedOptions;
  const result = await handleMessages(body({ stream: true, tool_choice: 'auto' }), {
    provider: {
      getModelCapabilities: async () => null,
      createStreamingChatCompletion: async (_messages, options) => {
        receivedOptions = options;
        return {
          text: '',
          tool_calls: [{
            id: 'call_native_stream_read',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"file_path":"README.md"}'
            }
          }],
          finish_reason: 'tool_calls',
          usage: null
        };
      }
    }
  });

  assert.equal(receivedOptions.tool_choice, 'auto');
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0], {
    type: 'tool_use',
    id: 'call_native_stream_read',
    name: 'Read',
    input: { file_path: 'README.md' }
  });
});

test('recovers invalid BYV Format Block arguments using BYV protocol instructions', async () => {
  let count = 0;
  const seenMessages = [];
  const result = await handleMessages(body({ tool_choice: 'auto' }), {
    provider: {
      createChatCompletion: async (messages, options) => {
        count++;
        seenMessages.push({ messages, options });
        return count === 1
          ? {
              text: '<|BYV| calls><|BYV| invoke name="Read" id="call_bad_byv"><|BYV| parameter name="path" type="string">README.md</|BYV| parameter></|BYV| invoke></|BYV| calls>',
              finish_reason: 'stop'
            }
          : {
              text: '<|BYV| calls><|BYV| invoke name="Read" id="call_good_byv"><|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter></|BYV| invoke></|BYV| calls>',
              finish_reason: 'stop'
            };
      }
    }
  });

  assert.equal(count, 2);
  assert.match(seenMessages[1].messages.at(-1).content, /Output exactly one complete BYV calls block/);
  assert.equal(seenMessages[1].options.tool_choice, 'auto');
  assert.equal(result.toolCalls[0].id, 'call_good_byv');
  assert.deepEqual(result.toolCalls[0].input, { file_path: 'README.md' });
});
test('rejects mixed native function calls and BYV markup as an ambiguous response', async () => {
  await assert.rejects(
    handleMessages(body(), {
      provider: {
        createChatCompletion: async () => ({
          text: '<|BYV| calls><|BYV| invoke name="Read" id="call_markup"><|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter></|BYV| invoke></|BYV| calls>',
          tool_calls: [{
            id: 'call_native',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"README.md"}' }
          }],
          finish_reason: 'tool_calls'
        })
      }
    }),
    (error) => error.code === 'BYV_TOOL_CALL_RECOVERY_FAILED'
  );
});

test('performs bounded recovery for schema-invalid tool arguments', async () => {
  let count = 0;
  const result = await handleMessages(body(), {
    provider: {
      createChatCompletion: async () => {
        count++;
        return count === 1
          ? { text: '<|BYV| calls><|BYV| invoke name="Read" id="bad"><|BYV| parameter name="path" type="string">README.md</|BYV| parameter></|BYV| invoke></|BYV| calls>', finish_reason: 'stop' }
          : { text: '<|BYV| calls><|BYV| invoke name="Read" id="good"><|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter></|BYV| invoke></|BYV| calls>', finish_reason: 'stop' };
      }
    }
  });
  assert.equal(count, 2);
  assert.equal(result.toolCalls[0].id, 'good');
});

test('recovers to plain text when tools are disabled but model emits BYV markup', async () => {
  let count = 0;
  const result = await handleMessages(body({ tools: [], tool_choice: 'none' }), {
    provider: {
      createChatCompletion: async () => {
        count++;
        return count === 1
          ? { text: '<|BYV| calls><|BYV| invoke name="Read" id="bad"></|BYV| invoke></|BYV| calls>', finish_reason: 'stop' }
          : { text: 'I cannot access files in this request, but I can explain how to inspect README.md.', finish_reason: 'stop' };
      }
    }
  });
  assert.equal(count, 2);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /cannot access files/);
});

test('fails explicitly when a required tool call cannot be recovered', async () => {
  await assert.rejects(
    handleMessages(body({ tool_choice: 'any' }), {
      provider: {
        createChatCompletion: async () => ({ text: 'Here is a plain text answer.', finish_reason: 'stop' })
      }
    }),
    (error) => error.code === 'BYV_REQUIRED_TOOL_MISSING'
  );
});

test('maps upstream max-token finish reasons to Anthropic max_tokens', async () => {
  const result = await handleMessages(body({ tools: [] }), {
    provider: {
      createChatCompletion: async () => ({
        text: 'A deliberately short answer.',
        finish_reason: 'max_tokens',
        usage: null
      })
    }
  });
  assert.equal(result.stop_reason, 'max_tokens');
});


test('rejects requests above the provider model output limit before upstream invocation', async () => {
  let called = false;
  await assert.rejects(
    handleMessages(body(), {
      provider: {
        getModelCapabilities: async () => ({ max_output_tokens: 128 }),
        createChatCompletion: async () => {
          called = true;
          return { text: 'should not run', finish_reason: 'stop' };
        }
      }
    }),
    (error) => error.code === 'PROVIDER_MAX_OUTPUT_EXCEEDED'
  );
  assert.equal(called, false);
});

test('rejects an estimated input that cannot fit the discovered context window', async () => {
  let called = false;
  await assert.rejects(
    handleMessages(body({ max_tokens: 64 }), {
      provider: {
        getModelCapabilities: async () => ({
          context_window_tokens: 2048,
          max_output_tokens: 1024
        }),
        createChatCompletion: async () => {
          called = true;
          return { text: 'should not run', finish_reason: 'stop' };
        }
      }
    }),
    (error) => error.code === 'PROVIDER_CONTEXT_WINDOW_EXCEEDED'
  );
  assert.equal(called, false);
});

test('maps provider cached prompt tokens to Anthropic cache usage fields', () => {
  const usage = normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 80 }
  }, 120, 12);

  assert.deepEqual(usage, {
    input_tokens: 20,
    output_tokens: 7,
    cache_read_input_tokens: 80
  });
});

test('maps reported cache creation tokens without inventing cache metrics', () => {
  const usage = normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 7,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 20
  }, 120, 12);

  assert.deepEqual(usage, {
    input_tokens: 50,
    output_tokens: 7,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 20
  });
});
