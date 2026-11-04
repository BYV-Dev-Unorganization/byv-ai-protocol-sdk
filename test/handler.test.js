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

test('forwards Anthropic output_config.effort to the provider as native metadata', async () => {
  let receivedOptions;
  const result = await handleMessages(body({
    output_config: { effort: 'high' }
  }), {
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async (_messages, options) => {
        receivedOptions = options;
        return { text: 'Completed.', finish_reason: 'stop', usage: null };
      }
    }
  });

  assert.equal(receivedOptions.reasoning_effort, 'high');
  assert.equal(result.stop_reason, 'end_turn');
});

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
  const providerMessages = [];
  const providerOptions = [];
  const result = await handleMessages(body({
    messages,
    tool_choice: 'auto'
  }), {
    provider: {
      createChatCompletion: async (messages, options) => {
        providerMessages.push(messages);
        providerOptions.push(options);
        if (providerOptions.length === 1) {
          return {
            text: '<|BYV| calls><|BYV| invoke name="Read" id="call_loop_retry"><|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter></|BYV| invoke></|BYV| calls>',
            finish_reason: 'stop',
            usage: null
          };
        }
        return {
          text: 'The same command has already been repeated; no further tool call is needed.',
          finish_reason: 'stop',
          usage: null
        };
      }
    }
  });
  assert.match(providerMessages[0][0].content, /STOP: DO NOT CALL TOOLS/);
  assert.match(providerMessages[1].at(-1).content, /RECOVERY REQUIRED/);
  assert.equal(providerOptions.length, 2);
  assert.ok(providerOptions.every((options) => options.tool_choice === 'none'));
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

test('converts DSML model output through the unchanged BYV parser before returning tool_use', async () => {
  const events = [];
  const output = '<｜DSML｜ calls><｜DSML｜ invoke name="Read">' +
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜ calls>';
  const result = await handleMessages(body(), {
    nativeToolCalling: false,
    requestId: 'req_dsml_adapter',
    logger: (event) => events.push(event),
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async () => ({
        text: output,
        reasoning: '',
        finish_reason: 'stop',
        usage: null
      })
    }
  });

  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content[0].type, 'tool_use');
  assert.equal(result.content[0].name, 'Read');
  assert.deepEqual(result.content[0].input, { file_path: 'README.md' });
  assert.match(result.content[0].id, /^dsml_call_[a-f0-9]{24}$/);
  assert.equal(events[0].source, 'dsml_converted_to_byv');
  assert.equal(events[0].validation_status, 'valid');
});

test('logs validated BYV tool-call metadata without recording arguments', async () => {
  const events = [];
  const privatePath = '/workspace/private-file-name.txt';
  const result = await handleMessages(body(), {
    requestId: 'req_safe_tool_log',
    logger: (event) => events.push(event),
    provider: {
      createChatCompletion: async () => ({
        text: '<|BYV| calls><|BYV| invoke name="Read" id="call_safe_log"><|BYV| parameter name="file_path" type="string">' +
          privatePath +
          '</|BYV| parameter></|BYV| invoke></|BYV| calls>',
        finish_reason: 'stop',
        usage: null
      })
    }
  });

  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    level: 'info',
    event: 'tool_call.validated',
    request_id: 'req_safe_tool_log',
    source: 'byv_format_block',
    phase: 'initial',
    recovery_attempt: null,
    invocation_id: 'call_safe_log',
    tool_name: 'Read',
    validation_status: 'valid',
    validation_reason: null
  });
  assert.equal(JSON.stringify(events).includes(privatePath), false);
  assert.equal(JSON.stringify(events).includes('file_path'), false);
});

test('rejects provider-native calls and recovers with DSML when native calling is disabled', async () => {
  let count = 0;
  const events = [];
  const seenMessages = [];
  const result = await handleMessages(body(), {
    nativeToolCalling: false,
    requestId: 'req_native_disabled',
    logger: (event) => events.push(event),
    provider: {
      createChatCompletion: async (messages) => {
        count++;
        seenMessages.push(messages);
        if (count === 1) {
          return {
            text: '',
            tool_calls: [{
              id: 'call_native_disabled',
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
        return {
          text: '<｜DSML｜ calls><｜DSML｜ invoke name="Read"><｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>',
          finish_reason: 'stop',
          usage: null
        };
      }
    }
  });

  assert.equal(count, 2);
  const recoveryPrompt = seenMessages[1].at(-1).content;
  assert.match(recoveryPrompt, /Output exactly one DeepSeek DSML calls block/);
  assert.match(recoveryPrompt, /PROVIDER_NATIVE_DISABLED/);
  assert.match(recoveryPrompt, /provider-native function call/i);
  assert.match(recoveryPrompt, /was NOT executed/i);
  assert.match(recoveryPrompt, /"tool_name": "Read"/);
  assert.match(recoveryPrompt, /README\.md/);
  assert.equal(recoveryPrompt.includes('call_native_disabled'), false);
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content[0].type, 'tool_use');
  assert.equal(result.content[0].name, 'Read');
  assert.deepEqual(result.content[0].input, { file_path: 'README.md' });
  assert.match(result.content[0].id, /^dsml_call_[a-f0-9]{24}$/);
  assert.deepEqual(events.map((event) => ({
    event: event.event,
    source: event.source,
    phase: event.phase,
    validation_reason: event.validation_reason
  })), [
    {
      event: 'tool_call.parse_rejected',
      source: 'provider_native',
      phase: 'initial',
      validation_reason: 'PROVIDER_NATIVE_DISABLED'
    },
    {
      event: 'tool_call.validated',
      source: 'dsml_converted_to_byv',
      phase: 'tool_recovery',
      validation_reason: null
    }
  ]);
});


test('second recovery explains a repeated native-call rejection before accepting DSML', async () => {
  let count = 0;
  const seenMessages = [];
  const result = await handleMessages(body(), {
    nativeToolCalling: false,
    provider: {
      createChatCompletion: async (messages) => {
        count++;
        seenMessages.push(messages);
        if (count <= 2) {
          return {
            text: '',
            tool_calls: [{
              id: 'call_rejected_' + count,
              type: 'function',
              function: { name: 'Read', arguments: '{"file_path":"README.md"}' }
            }],
            finish_reason: 'tool_calls',
            usage: null
          };
        }
        return {
          text: '<｜DSML｜ calls><｜DSML｜ invoke name="Read"><｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>',
          finish_reason: 'stop',
          usage: null
        };
      }
    }
  });
  assert.equal(count, 3);
  assert.match(seenMessages[1].at(-1).content, /previous provider response returned a provider-native function call/i);
  assert.match(seenMessages[2].at(-1).content, /previous recovery response again returned a provider-native function call/i);
  assert.match(seenMessages[2].at(-1).content, /final recovery attempt/i);
  assert.match(seenMessages[2].at(-1).content, /README\.md/);
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0].input, { file_path: 'README.md' });
});

test('converts native provider function calls into Anthropic tool_use blocks', async () => {
  let receivedOptions;
  const result = await handleMessages(body({ tool_choice: 'auto' }), {
    nativeToolCalling: true,
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
    nativeToolCalling: true,
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

test('recovers invalid tool arguments using DSML protocol instructions', async () => {
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
  assert.match(seenMessages[1].messages.at(-1).content, /Output only one DeepSeek DSML calls block/);
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
  const events = [];
  const result = await handleMessages(body(), {
    requestId: 'req_recovery_log',
    logger: (event) => events.push(event),
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
  assert.deepEqual(events.map((event) => ({
    event: event.event,
    request_id: event.request_id,
    invocation_id: event.invocation_id,
    tool_name: event.tool_name,
    phase: event.phase,
    validation_status: event.validation_status,
    validation_reason: event.validation_reason
  })), [
    {
      event: 'tool_call.rejected',
      request_id: 'req_recovery_log',
      invocation_id: 'bad',
      tool_name: 'Read',
      phase: 'initial',
      validation_status: 'rejected',
      validation_reason: 'TOOL_SCHEMA_INVALID'
    },
    {
      event: 'tool_call.validated',
      request_id: 'req_recovery_log',
      invocation_id: 'good',
      tool_name: 'Read',
      phase: 'tool_recovery',
      validation_status: 'valid',
      validation_reason: null
    }
  ]);
  assert.equal(JSON.stringify(events).includes('README.md'), false);
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

test('recovers an initially empty response when tools are disabled', async () => {
  let count = 0;
  const result = await handleMessages(body({ tools: [], tool_choice: 'none' }), {
    provider: {
      createChatCompletion: async () => {
        count++;
        return count === 1
          ? { text: '', finish_reason: 'stop' }
          : { text: 'No tool is available for this request.', finish_reason: 'stop' };
      }
    }
  });

  assert.equal(count, 2);
  assert.equal(result.stop_reason, 'end_turn');
  assert.match(result.text, /No tool is available/);
});

test('text-only recovery rejects an empty response and retries with plain text', async () => {
  let count = 0;
  const result = await handleMessages(body({ tools: [], tool_choice: 'none' }), {
    provider: {
      createChatCompletion: async (_messages, options) => {
        count++;
        assert.equal(options.tool_choice, 'none');
        if (count === 1) {
          return {
            text: '<|BYV| calls><|BYV| invoke name="Read" id="call_bad"></|BYV| invoke></|BYV| calls>',
            finish_reason: 'stop'
          };
        }
        if (count === 2) return { text: '   ', finish_reason: 'stop' };
        return {
          text: 'The requested operation is unavailable because tools are disabled.',
          finish_reason: 'stop'
        };
      }
    }
  });

  assert.equal(count, 3);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /tools are disabled/);
});

test('text-only recovery rejects native tool calls instead of silently accepting them', async () => {
  let count = 0;
  const result = await handleMessages(body({ tools: [], tool_choice: 'none' }), {
    provider: {
      createChatCompletion: async () => {
        count++;
        if (count === 1) {
          return {
            text: '<|BYV| calls><|BYV| invoke name="Read" id="call_bad"></|BYV| invoke></|BYV| calls>',
            finish_reason: 'stop'
          };
        }
        if (count === 2) {
          return {
            text: '',
            tool_calls: [{
              id: 'call_native_during_text_recovery',
              type: 'function',
              function: {
                name: 'Read',
                arguments: '{"file_path":"README.md"}'
              }
            }],
            finish_reason: 'tool_calls'
          };
        }
        return {
          text: 'I cannot perform file operations while tools are disabled.',
          finish_reason: 'stop'
        };
      }
    }
  });

  assert.equal(count, 3);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /tools are disabled/);
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


test('native-disabled provider receives DSML history and structured tool results', async () => {
  const messages = [
    { role: 'user', content: 'Inspect the repository, then answer.' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_history', name: 'Read', input: { file_path: 'README.md' } }]
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_history', content: 'README body' }]
    },
    { role: 'user', content: 'Summarize the result.' }
  ];
  let sentMessages;
  const result = await handleMessages(body({ messages }), {
    nativeToolCalling: false,
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async (providerMessages) => {
        sentMessages = providerMessages;
        return { text: 'The README was inspected.', finish_reason: 'stop', usage: null };
      }
    }
  });

  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(sentMessages[0].role, 'system');
  assert.match(sentMessages[0].content, /AUTHORITATIVE TOOL INPUT SCHEMAS/);
  assert.equal(sentMessages.some((message) => message.role === 'tool'), false);
  const historicalAssistant = sentMessages.find((message) =>
    message.role === 'assistant' && typeof message.content === 'string' &&
    message.content.includes('HISTORICAL TOOL INVOCATIONS')
  );
  assert.ok(historicalAssistant);
  assert.match(historicalAssistant.content, /<｜DSML｜tool_calls>/);
  const historicalResult = sentMessages.find((message) =>
    message.role === 'user' && typeof message.content === 'string' &&
    message.content.includes('HISTORICAL TOOL RESULTS')
  );
  assert.ok(historicalResult);
  assert.match(historicalResult.content, /README body/);
  assert.equal(sentMessages.some((message) => Array.isArray(message.tool_calls)), false);
});


test('no-tool experiment overrides client auto and rejects native calls before any execution', async () => {
  let count = 0;
  const attempts = [];
  const result = await handleMessages(body({ tool_choice: 'auto' }), {
    noToolExperiment: true,
    experimentVariant: 'B',
    nativeToolCalling: true,
    provider: {
      createChatCompletion: async (messages, options) => {
        count++;
        attempts.push({ messages, options });
        assert.equal(options.tool_choice, 'none');
        assert.deepEqual(options.tools, []);
        if (count === 1) {
          return {
            text: '',
            tool_calls: [{
              id: 'call_must_not_execute',
              type: 'function',
              function: {
                name: 'Read',
                arguments: '{"file_path":"README.md"}'
              }
            }],
            finish_reason: 'tool_calls'
          };
        }
        return {
          text: 'I cannot inspect README.md because tools are disabled for this request.',
          finish_reason: 'stop'
        };
      }
    }
  });

  assert.equal(count, 2);
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.toolCalls, []);
  assert.match(result.text, /tools are disabled/);
  assert.match(attempts[0].messages[0].content, /TEXT-ONLY OUTPUT CONTRACT/);
  assert.match(attempts[0].messages[0].content, /TOOLS LISTED FOR REFERENCE ONLY/);
  assert.doesNotMatch(attempts[0].messages[0].content, /DSML TOOL CALL PROTOCOL|NATIVE TOOL CALL PROTOCOL/);
  assert.doesNotMatch(attempts[0].messages[0].content, /AUTHORITATIVE TOOL INPUT SCHEMAS/);
  assert.match(attempts[1].messages.at(-1).content, /Answer in plain text/);
  assert.ok(attempts.every((attempt) => attempt.options.tool_choice === 'none'));
  assert.ok(attempts.every((attempt) => attempt.options.tools.length === 0));
});
