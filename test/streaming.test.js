'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const { DsmlStreamGuard } = require('../src/protocol/dsml-stream-guard');
const { writeEventAsync } = require('../src/sse-sink');
const { handleMessages } = require('../src/handler');
const { createServer } = require('../src/server');
const { GATEWAY_API_KEY } = require('../src/config');

function requestBody(options = {}) {
  return {
    model: 'byv-flash-v1',
    max_tokens: 128,
    stream: true,
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

async function withServer(t, options) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

function authHeaders() {
  return {
    Authorization: 'Bearer ' + GATEWAY_API_KEY,
    'Content-Type': 'application/json'
  };
}

function parseSse(raw) {
  return raw.split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event:\s*(.+)$/m);
      const data = block.match(/^data:\s*([\s\S]+)$/m);
      return event && data ? { event: event[1], data: JSON.parse(data[1]) } : null;
    })
    .filter(Boolean);
}

test('DSML stream guard releases ordinary text immediately and suppresses split protocol markup', () => {
  const guard = new DsmlStreamGuard();
  assert.deepEqual(guard.push('A token arrives.'), ['A token arrives.']);
  assert.deepEqual(guard.push(' More text. <｜DSML｜ calls><｜DSML｜ invoke name='), [' More text. ']);
  assert.deepEqual(guard.push('"Read"><｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>'), []);
  assert.deepEqual(guard.finish(), []);
  assert.equal(guard.protocolDetected, true);
});

test('DSML stream guard preserves protocol-looking text inside a complete Markdown code fence', () => {
  const guard = new DsmlStreamGuard();
  const fence = String.fromCharCode(96).repeat(3);
  const literal = 'Example:\n' + fence + 'xml\n<｜DSML｜ calls><｜DSML｜ invoke name="Read"/>\n' + fence + '\nThat is documentation.';
  assert.deepEqual(guard.push(literal), [literal]);
  assert.deepEqual(guard.finish(), []);
});

test('async SSE writer waits for response drain before resolving', async () => {
  class FakeResponse extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.writableEnded = false;
      this.chunks = [];
    }
    write(value) {
      this.chunks.push(value);
      return false;
    }
  }
  const response = new FakeResponse();
  let settled = false;
  const pending = writeEventAsync(response, 'ping', { type: 'ping' })
    .then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  response.emit('drain');
  await pending;
  assert.equal(settled, true);
  assert.match(response.chunks[0], /^event: ping\n/);
});

test('handler forwards native provider deltas while emitting tool_use only from validated completion', async () => {
  const seen = [];
  const result = await handleMessages(requestBody(), {
    noToolExperiment: false,
    nativeToolCalling: true,
    onStreamEvent: (event) => { seen.push(event); },
    provider: {
      getModelCapabilities: async () => null,
      streamChatCompletionEvents: async function* () {
        yield { type: 'text_delta', text: 'Inspecting. ' };
        yield {
          type: 'tool_call_delta',
          deltas: [{
            index: 0,
            id: 'call_native_stream',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":' }
          }]
        };
        yield {
          type: 'tool_call_delta',
          deltas: [{
            index: 0,
            function: { arguments: '"README.md"}' }
          }]
        };
        yield {
          type: 'completion',
          completion: {
            id: 'chatcmpl-native-stream',
            text: 'Inspecting. ',
            tool_calls: [{
              id: 'call_native_stream',
              type: 'function',
              function: { name: 'Read', arguments: '{"file_path":"README.md"}' }
            }],
            finish_reason: 'tool_calls',
            usage: { prompt_tokens: 12, completion_tokens: 4 }
          }
        };
      }
    }
  });

  assert.equal(seen[0].type, 'text_delta');
  assert.equal(seen.filter((event) => event.type === 'tool_call_delta').length, 2);
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.toolCalls, [{
    id: 'call_native_stream',
    name: 'Read',
    input: { file_path: 'README.md' }
  }]);
});

test('provider generator yields token deltas before completion and assembles native tool-call fragments', () => {
  const script = [
    "const assert = require('node:assert/strict');",
    "const frames = [",
    "  { id: 'chatcmpl-stream-test', model: 'stream-test-model', choices: [{ delta: { content: 'hello ' }, finish_reason: null }] },",
    "  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream', type: 'function', function: { name: 'Re', arguments: '{\"file_path\":' } }] }, finish_reason: null }] },",
    "  { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ad', arguments: '\"README.md\"}' } }] }, finish_reason: 'tool_calls' }] },",
    "  { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } }",
    "];",
    "const body = frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\\n\\n').join('') + 'data: [DONE]\\n\\n';",
    "global.fetch = async (_url, init) => {",
    "  const request = JSON.parse(init.body);",
    "  assert.equal(request.stream, true);",
    "  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });",
    "};",
    "const { streamChatCompletionEvents } = require('./src/provider/openai-compatible');",
    "(async () => {",
    "  const iterator = streamChatCompletionEvents([{ role: 'user', content: 'Read README.md' }], {",
    "    max_tokens: 64, nativeToolCalling: true,",
    "    tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],",
    "    tool_choice: 'auto'",
    "  });",
    "  const first = await iterator.next();",
    "  assert.deepEqual(first.value, { type: 'text_delta', text: 'hello ' });",
    "  let completion = null;",
    "  const eventTypes = [first.value.type];",
    "  for await (const event of iterator) { eventTypes.push(event.type); if (event.type === 'completion') completion = event.completion; }",
    "  assert.ok(eventTypes.includes('tool_call_delta'));",
    "  assert.ok(eventTypes.includes('usage'));",
    "  assert.equal(completion.text, 'hello ');",
    "  assert.equal(completion.tool_calls[0].function.name, 'Read');",
    "  assert.equal(completion.tool_calls[0].function.arguments, '{\"file_path\":\"README.md\"}');",
    "  assert.equal(completion.usage.prompt_tokens, 8);",
    "  process.stdout.write('ok');",
    "})().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });"
  ].join('\n');

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'stream-test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      PROVIDER_TIMEOUT_MS: '2000'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'ok');
});

test('HTTP endpoint streams text deltas to the client before the handler completes', async (t) => {
  let handlerCompleted = false;
  const base = await withServer(t, {
    handleMessages: async (_body, options) => {
      await options.onStreamEvent({ type: 'text_delta', text: 'FIRST_TOKEN' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await options.onStreamEvent({ type: 'text_delta', text: ' SECOND_TOKEN' });
      handlerCompleted = true;
      return {
        id: 'msg_stream_e2e',
        text: 'FIRST_TOKEN SECOND_TOKEN',
        content: [{ type: 'text', text: 'FIRST_TOKEN SECOND_TOKEN' }],
        toolCalls: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 3 },
        usage_estimated: false
      };
    }
  });

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(requestBody({ tools: [], tool_choice: 'none' }))
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/i);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  while (!raw.includes('"text":"FIRST_TOKEN"')) {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'stream ended before the first token');
    raw += decoder.decode(value, { stream: true });
  }
  assert.equal(handlerCompleted, false, 'first token was not delivered until after handler completion');

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  const events = parseSse(raw);
  assert.ok(events.some((event) => event.event === 'message_start'));
  assert.ok(events.some((event) => event.data.delta && event.data.delta.text === 'FIRST_TOKEN'));
  assert.ok(events.some((event) => event.data.delta && event.data.delta.text === ' SECOND_TOKEN'));
  assert.equal(events.filter((event) => event.data.delta && event.data.delta.text === 'FIRST_TOKEN').length, 1);
  assert.equal(events.at(-1).event, 'message_stop');
  assert.equal(handlerCompleted, true);
});

test('aborts the upstream handler when the streaming client disconnects', async (t) => {
  let cancelled = false;
  const base = await withServer(t, {
    handleMessages: async (_body, options) => {
      await options.onStreamEvent({ type: 'text_delta', text: 'CANCEL_ME' });
      await new Promise((resolve) => {
        if (options.signal.aborted) {
          cancelled = true;
          resolve();
          return;
        }
        options.signal.addEventListener('abort', () => {
          cancelled = true;
          resolve();
        }, { once: true });
      });
      return {
        id: 'msg_cancel_stream',
        text: 'CANCEL_ME',
        content: [{ type: 'text', text: 'CANCEL_ME' }],
        toolCalls: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        usage_estimated: false
      };
    }
  });

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(requestBody({ tools: [], tool_choice: 'none' }))
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  while (!raw.includes('"text":"CANCEL_ME"')) {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'stream ended before test token');
    raw += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cancelled, true);
});

test('full handler/provider/HTTP path streams DSML-safe text and emits a validated Anthropic tool_use', async (t) => {
  const protocol = '<｜DSML｜ calls><｜DSML｜ invoke name="Read">' +
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜ calls>';
  const providerText = 'I will inspect README. ' + protocol + ' Done.';
  const base = await withServer(t, {
    noToolExperiment: true,
    provider: {
      getModelCapabilities: async () => null,
      streamChatCompletionEvents: async function* () {
        yield {
          type: 'text_delta',
          text: 'I will inspect README. <｜DSML｜ calls><｜DSML｜ invoke name="Read"><｜DSML｜ parameter name='
        };
        yield {
          type: 'text_delta',
          text: '"file_path" string="true">README.md</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls> Done.'
        };
        yield {
          type: 'completion',
          completion: {
            id: 'chatcmpl-dsml-e2e',
            text: providerText,
            tool_calls: [],
            finish_reason: 'stop',
            usage: { prompt_tokens: 18, completion_tokens: 10 }
          }
        };
      }
    }
  });

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(requestBody())
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(raw.includes('DSML'), false);
  assert.equal(raw.includes('｜'), false);
  const events = parseSse(raw);
  assert.ok(events.some((event) => event.data.delta && event.data.delta.text === 'I will inspect README. '));
  assert.ok(events.some((event) => event.data.delta && event.data.delta.text === ' Done.'));
  const toolStart = events.find((event) =>
    event.data.content_block && event.data.content_block.type === 'tool_use'
  );
  assert.ok(toolStart, 'validated tool_use block was not returned');
  assert.equal(toolStart.data.content_block.name, 'Read');
  assert.ok(events.some((event) =>
    event.data.delta && event.data.delta.partial_json === '{"file_path":"README.md"}'
  ));
  const finalDelta = events.find((event) => event.data.delta && event.data.delta.stop_reason);
  assert.equal(finalDelta.data.delta.stop_reason, 'tool_use');
  assert.equal(events.at(-1).event, 'message_stop');
});

test('full handler/provider/HTTP path streams DSML-safe text and emits a validated Anthropic tool_use', async (t) => {
  const protocol = '<｜DSML｜ calls><｜DSML｜ invoke name="Read">' +
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>' +
    '</｜DSML｜ invoke></｜DSML｜ calls>';
  const providerText = 'I will inspect README. ' + protocol;
  const base = await withServer(t, {
    noToolExperiment: true,
    provider: {
      getModelCapabilities: async () => null,
      streamChatCompletionEvents: async function* () {
        yield {
          type: 'text_delta',
          text: 'I will inspect README. <｜DSML｜ calls><｜DSML｜ invoke name="Read"><｜DSML｜ parameter name='
        };
        yield {
          type: 'text_delta',
          text: '"file_path" string="true">README.md</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>'
        };
        yield {
          type: 'completion',
          completion: {
            id: 'chatcmpl-dsml-e2e',
            text: providerText,
            tool_calls: [],
            finish_reason: 'stop',
            usage: { prompt_tokens: 18, completion_tokens: 10 }
          }
        };
      }
    }
  });

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(requestBody())
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(raw.includes('DSML'), false);
  assert.equal(raw.includes('｜'), false);
  const events = parseSse(raw);
  assert.ok(events.some((event) => event.data.delta && event.data.delta.text === 'I will inspect README. '));
  const toolStart = events.find((event) =>
    event.data.content_block && event.data.content_block.type === 'tool_use'
  );
  assert.ok(toolStart, 'validated tool_use block was not returned');
  assert.equal(toolStart.data.content_block.name, 'Read');
  assert.ok(events.some((event) =>
    event.data.delta && event.data.delta.partial_json === '{"file_path":"README.md"}'
  ));
  const finalDelta = events.find((event) => event.data.delta && event.data.delta.stop_reason);
  assert.equal(finalDelta.data.delta.stop_reason, 'tool_use');
  assert.equal(events.at(-1).event, 'message_stop');
});

test('HTTP stream with DSML emits plain text and validated tool_use without leaking protocol markup', async (t) => {
  const base = await withServer(t, {
    handleMessages: async (_body, options) => {
      await options.onStreamEvent({
        type: 'text_delta',
        text: 'Visible prefix. <｜DSML｜ calls><｜DSML｜ invoke name='
      });
      await options.onStreamEvent({
        type: 'text_delta',
        text: '"Read"><｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>'
      });
      return {
        id: 'msg_dsml_stream',
        text: 'Visible prefix. ',
        content: [
          { type: 'text', text: 'Visible prefix. ' },
          { type: 'tool_use', id: 'call_dsml_stream', name: 'Read', input: { file_path: 'README.md' } }
        ],
        toolCalls: [{ id: 'call_dsml_stream', name: 'Read', input: { file_path: 'README.md' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 8 },
        usage_estimated: false
      };
    }
  });
  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(requestBody())
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(raw.includes('DSML'), false);
  assert.equal(raw.includes('｜'), false);
  const events = parseSse(raw);
  assert.ok(events.some((event) => event.data.delta && event.data.delta.text === 'Visible prefix. '));
  const toolStart = events.find((event) =>
    event.data.content_block && event.data.content_block.type === 'tool_use'
  );
  assert.ok(toolStart);
  assert.equal(toolStart.data.content_block.id, 'call_dsml_stream');
  assert.ok(events.some((event) => event.data.delta && event.data.delta.partial_json === '{"file_path":"README.md"}'));
  assert.equal(events.at(-1).event, 'message_stop');
});
