'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessages, normalizeUsage, detectToolLoop, resolveCompactionBudgets } = require('../src/handler');

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

test('forwards manual sampling parameters from the Messages request to the provider', async () => {
  let receivedOptions;
  const providerParams = {
    min_p: 0.05,
    frequency_penalty: 0.2,
    repetition_penalty: 1.1,
    seed: 42
  };

  await handleMessages(body({
    top_k: 40,
    provider_params: providerParams,
    tools: [],
    tool_choice: 'none'
  }), {
    noToolExperiment: true,
    nativeToolCalling: false,
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async (_messages, options) => {
        receivedOptions = options;
        return { text: 'Sampling parameters received.', finish_reason: 'stop', usage: null };
      }
    }
  });

  assert.equal(receivedOptions.top_k, 40);
  assert.deepEqual(receivedOptions.provider_params, providerParams);
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
    noToolExperiment: true,
    nativeToolCalling: false,
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
  assert.match(providerMessages[1].at(-1).content, /=== TEXT-ONLY RECOVERY ===/);
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
    noToolExperiment: true,
    nativeToolCalling: false,
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
    noToolExperiment: true,
    nativeToolCalling: false,
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
    noToolExperiment: false,
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
    noToolExperiment: false,
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
    noToolExperiment: true,
    nativeToolCalling: false,
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
  assert.equal(seenMessages[1].options.tool_choice, 'none');
  assert.equal(result.toolCalls[0].id, 'call_good_byv');
  assert.deepEqual(result.toolCalls[0].input, { file_path: 'README.md' });
});
test('rejects mixed native function calls and BYV markup as an ambiguous response', async () => {
  await assert.rejects(
    handleMessages(body(), {
      noToolExperiment: true,
      nativeToolCalling: false,
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
    noToolExperiment: true,
    nativeToolCalling: false,
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
    noToolExperiment: true,
    nativeToolCalling: false,
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
    noToolExperiment: true,
    nativeToolCalling: false,
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
    noToolExperiment: true,
    nativeToolCalling: false,
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

test('native text-only recovery contains no DSML protocol instruction', async () => {
  const seenMessages = [];
  const result = await handleMessages(body({ tools: [], tool_choice: 'none' }), {
    noToolExperiment: false,
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async (messages) => {
        seenMessages.push(messages);
        return seenMessages.length === 1
          ? { text: '', finish_reason: 'stop', usage: null }
          : { text: 'Plain-text fallback response.', finish_reason: 'stop', usage: null };
      }
    }
  });

  assert.equal(seenMessages.length, 2);
  assert.doesNotMatch(seenMessages[0][0].content, /DSML/i);
  assert.doesNotMatch(seenMessages[1].at(-1).content, /DSML/i);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.text, 'Plain-text fallback response.');
});

test('text-only recovery rejects native tool calls instead of silently accepting them', async () => {
  let count = 0;
  const result = await handleMessages(body({ tools: [], tool_choice: 'none' }), {
    noToolExperiment: false,
    nativeToolCalling: true,
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
      noToolExperiment: true,
      nativeToolCalling: false,
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
    noToolExperiment: true,
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
  // DSML mode consolidates history, schemas, results, and the latest request
  // into a single text prompt instead of sending native tool roles.
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].role, 'user');
  assert.match(sentMessages[0].content, /AUTHORITATIVE TOOL INPUT SCHEMAS/);
  assert.ok(sentMessages[0].content.includes('Read(file_path*'));
  assert.match(sentMessages[0].content, /Tool call Read with input/);
  assert.match(sentMessages[0].content, /Tool result for toolu_history: README body/);
  assert.match(sentMessages[0].content, /Summarize the result/);
  assert.equal(sentMessages.some((message) => message.role === 'tool'), false);
  assert.equal(sentMessages.some((message) => Array.isArray(message.tool_calls)), false);
});


test('text-only inference converts DSML text to tool_use while provider-native tools stay disabled', async () => {
  let count = 0;
  let receivedMessages;
  let receivedOptions;
  const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="Read">' +
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜ calls>';

  const result = await handleMessages(body({ tool_choice: 'auto' }), {
    noToolExperiment: true,
    experimentVariant: 'B',
    nativeToolCalling: true,
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async (messages, options) => {
        count++;
        receivedMessages = messages;
        receivedOptions = options;
        return { text: dsml, finish_reason: 'stop', usage: null };
      }
    }
  });

  assert.equal(count, 1);
  assert.equal(receivedOptions.tool_choice, 'none');
  assert.deepEqual(receivedOptions.tools, []);
  assert.equal(receivedMessages.length, 1);
  assert.equal(receivedMessages[0].role, 'user');
  assert.match(receivedMessages[0].content, /### TOOLS/);
  assert.match(receivedMessages[0].content, /AUTHORITATIVE TOOL INPUT SCHEMAS/);
  assert.match(receivedMessages[0].content, /DeepSeek DSML markup format/);
  assert.doesNotMatch(receivedMessages[0].content, /NATIVE TOOL CALL PROTOCOL/);
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'Read');
  assert.deepEqual(result.toolCalls[0].input, { file_path: 'README.md' });
  assert.equal(result.content[0].type, 'tool_use');
});

test('native mode normalizes provider tool calls without parsing DSML text', async () => {
  let receivedOptions;
  const result = await handleMessages(body({ tool_choice: 'auto' }), {
    noToolExperiment: false,
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async (_messages, options) => {
        receivedOptions = options;
        return {
          text: '<｜DSML｜ calls><｜DSML｜ invoke name="Read"></｜DSML｜ invoke></｜DSML｜ calls>',
          tool_calls: [{
            id: 'call_native',
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

  assert.equal(receivedOptions.nativeToolCalling, true);
  assert.equal(receivedOptions.tool_choice, 'auto');
  assert.equal(receivedOptions.tools.length, 1);
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'Read');
  assert.deepEqual(result.toolCalls[0].input, { file_path: 'README.md' });
  assert.equal(result.text, '<｜DSML｜ calls><｜DSML｜ invoke name="Read"></｜DSML｜ invoke></｜DSML｜ calls>');
});


test('explicit tool_choice none keeps DSML unavailable in text-only inference', async () => {
  let count = 0;
  const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="Read">' +
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜ calls>';
  const result = await handleMessages(body({ tool_choice: 'none' }), {
    noToolExperiment: true,
    provider: {
      createChatCompletion: async (_messages, options) => {
        count++;
        assert.equal(options.tool_choice, 'none');
        assert.deepEqual(options.tools, []);
        return count === 1
          ? { text: dsml, finish_reason: 'stop' }
          : { text: 'I can explain how to read the file, but this request explicitly disables tools.', finish_reason: 'stop' };
      }
    }
  });

  assert.equal(count, 2);
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.toolCalls, []);
  assert.match(result.text, /explicitly disables tools/);
});


test('treats Claude Code compaction as a text-only summary even when tools are declared', async () => {
  let calls = 0;
  let providerOptions;
  const tick = String.fromCharCode(96);
  const fence = tick.repeat(3);
  const instructions = [
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
    'Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.',
    'Respond with plain text only — an <analysis> block followed by a <summary> block.',
    'Summarize the conversation.'
  ].join('\n');
  const summary = [
    '<analysis>Summary with a literal example ' + tick + '<|BYV| calls>' + tick + '.</analysis>',
    '<summary>',
    'The DSML syntax is documentation only:',
    fence + 'text',
    '<｜DSML｜ calls>',
    '<｜DSML｜ invoke name="Read">',
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
    fence,
    '</summary>'
  ].join('\n');

  const result = await handleMessages(body({
    messages: [{ role: 'user', content: instructions }],
    tool_choice: undefined
  }), {
    noToolExperiment: true,
    nativeToolCalling: false,
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async (_messages, options) => {
        calls++;
        providerOptions = options;
        return { text: summary, finish_reason: 'stop', usage: null };
      }
    }
  });

  assert.equal(calls, 1);
  assert.equal(providerOptions.tool_choice, 'none');
  assert.deepEqual(providerOptions.tools, []);
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.text, summary);
});



test('uses bounded model-capability-aware replay and output budgets for Claude Code autocompaction', async () => {
  const longToolResult = 'TOOL_OUTPUT_MARKER '.repeat(20000);
  const compactionInstruction = [
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
    'Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.',
    'Respond with plain text only, an <analysis> block followed by a <summary> block.',
    'Summarize the conversation.'
  ].join('\n');
  const conversation = [
    { role: 'user', content: 'Original task: implement a provider-neutral gateway feature.' },
    { role: 'assistant', content: 'I will inspect the API contract and repository structure.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_large', name: 'Read', input: { file_path: 'old.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_large', content: longToolResult }] },
    { role: 'assistant', content: 'The earlier repository details have been reviewed.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_recent', name: 'Read', input: { file_path: 'README.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_recent', content: 'Recent README result.' }] },
    { role: 'assistant', content: 'The latest repository details have been reviewed.' },
    { role: 'user', content: compactionInstruction }
  ];
  let receivedMessages;
  let receivedOptions;
  let streamCalls = 0;
  const diagnostics = [];
  const result = await handleMessages(body({
    max_tokens: 128000,
    stream: true,
    output_config: { effort: 'high' },
    messages: conversation,
    tool_choice: undefined
  }), {
    noToolExperiment: true,
    nativeToolCalling: false,
    requestId: 'req_compaction_budget',
    diagnostics: (event, fields) => diagnostics.push({ event, ...fields }),
    provider: {
      getModelCapabilities: async () => ({
        context_window_tokens: 65536,
        max_input_tokens: 40000,
        max_output_tokens: 4096
      }),
      createStreamingChatCompletion: async (messages, options) => {
        streamCalls++;
        receivedMessages = messages;
        receivedOptions = options;
        return {
          text: '<analysis>Conversation reviewed.</analysis>\n<summary>Original task and latest results retained.</summary>',
          finish_reason: 'stop',
          usage: null
        };
      }
    }
  });

  assert.equal(streamCalls, 1);
  assert.equal(receivedMessages.length, 2);
  assert.equal(receivedMessages[0].role, 'system');
  assert.equal(receivedMessages[1].role, 'user');
  assert.match(receivedMessages[0].content, /TEXT-ONLY OUTPUT CONTRACT/);
  assert.match(receivedMessages[1].content, /Original task: implement a provider-neutral gateway feature/);
  assert.match(receivedMessages[1].content, /CRITICAL: Respond with TEXT ONLY/);
  assert.match(receivedMessages[1].content, /Tool call Read/);
  assert.match(receivedMessages[1].content, /older conversation history omitted/);
  assert.ok(receivedMessages[1].content.length < longToolResult.length);
  assert.equal(receivedOptions.max_tokens, 4096);
  assert.equal(receivedOptions.reasoning_effort, 'high');
  assert.deepEqual(receivedOptions.tools, []);
  assert.equal(receivedOptions.tool_choice, 'none');
  assert.ok(diagnostics.some((entry) =>
    entry.event === 'provider.request.started' &&
    entry.request_intent === 'claude_code_compaction' &&
    entry.compaction_max_input_tokens === 32768 &&
    entry.compaction_max_output_tokens === 4096
  ));
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.toolCalls, []);
});

test('derives compaction budgets from generic provider input, output, and context capabilities', () => {
  assert.deepEqual(resolveCompactionBudgets({
    context_window_tokens: 16384,
    max_input_tokens: 12000,
    max_output_tokens: 4096
  }, 128000), {
    maxInputTokens: 11520,
    maxOutputTokens: 3840
  });
  assert.deepEqual(resolveCompactionBudgets(null, 128000), {
    maxInputTokens: 32768,
    maxOutputTokens: 8192
  });
});

test('retries one transient transport failure and logs the retry without entering tool recovery', async () => {
  let calls = 0;
  const diagnostics = [];
  const result = await handleMessages(body(), {
    diagnostics: (event, fields) => diagnostics.push({ event, ...fields }),
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async () => {
        calls++;
        if (calls === 1) {
          throw Object.assign(new Error('temporary provider timeout'), {
            statusCode: 504,
            code: 'PROVIDER_TIMEOUT'
          });
        }
        return { text: 'Recovered after transport retry.', finish_reason: 'stop', usage: null };
      }
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.stop_reason, 'end_turn');
  assert.match(result.text, /Recovered after transport retry/);
  assert.equal(diagnostics.filter((item) => item.event === 'provider.request.retry_scheduled').length, 1);
});


test('uses the upstream provider response ID as the Anthropic message ID when available', async () => {
  const result = await handleMessages(body(), {
    provider: {
      getModelCapabilities: async () => null,
      createChatCompletion: async () => ({
        id: 'chatcmpl-office-provider-id',
        text: 'Office-compatible response.',
        finish_reason: 'stop',
        usage: null
      })
    }
  });
  assert.equal(result.id, 'chatcmpl-office-provider-id');
  assert.equal(result.stop_reason, 'end_turn');
});
