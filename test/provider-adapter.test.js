'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProviderModel } = require('./provider-model-fixture');

const ENV_KEYS = [
  'PROVIDER_BASE_URL',
  'PROVIDER_API_KEY',
  'PROVIDER_MODEL',
  'PROVIDER_NATIVE_REASONING_EFFORT',
  'PROVIDER_TIMEOUT_MS',
  'PROVIDER_MAX_REQUESTS_PER_MINUTE',
  'PROVIDER_MAX_CONCURRENT_REQUESTS'
];

function loadProvider(t, overrides = {}) {
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const previousFetch = global.fetch;
  const model = resolveProviderModel(overrides);
  Object.assign(process.env, {
    PROVIDER_BASE_URL: 'https://provider.example/v1',
    PROVIDER_API_KEY: 'provider-test-secret',
    PROVIDER_MODEL: model,
    PROVIDER_NATIVE_REASONING_EFFORT: 'true',
    PROVIDER_TIMEOUT_MS: '300000',
    PROVIDER_MAX_REQUESTS_PER_MINUTE: '0',
    PROVIDER_MAX_CONCURRENT_REQUESTS: '0',
    ...overrides,
    PROVIDER_MODEL: model
  });

  const configPath = require.resolve('../src/config');
  const providerPath = require.resolve('../src/provider/openai-compatible');
  delete require.cache[providerPath];
  delete require.cache[configPath];
  const provider = require(providerPath);

  t.after(() => {
    global.fetch = previousFetch;
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    delete require.cache[providerPath];
    delete require.cache[configPath];
  });
  return { provider, model };
}

function response({ status = 200, payload = {}, raw, jsonError } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (jsonError) throw jsonError;
      return payload;
    },
    async text() {
      return raw === undefined ? JSON.stringify(payload) : raw;
    }
  };
}

test('builds the exact OpenAI-compatible request payload from PROVIDER_MODEL and normalizes output', async (t) => {
  const { provider, model } = loadProvider(t);
  let captured;
  global.fetch = async (url, init) => {
    captured = { url, init, payload: JSON.parse(init.body) };
    return response({
      payload: {
        model,
        choices: [{
          finish_reason: 'stop',
          message: {
            content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'from provider.' }],
            reasoning_content: 'brief reasoning'
          }
        }],
        usage: { prompt_tokens: 20, completion_tokens: 4 }
      }
    });
  };

  const result = await provider.createChatCompletion(
    [{ role: 'system', content: 'stable prompt' }, { role: 'user', content: 'Hi' }],
    { max_tokens: 128, temperature: 0.2, top_p: 0.9, stop_sequences: ['END'] }
  );

  assert.equal(captured.url, 'https://provider.example/v1/chat/completions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer provider-test-secret');
  assert.deepEqual(captured.payload, {
    model,
    messages: [
      { role: 'system', content: 'stable prompt' },
      { role: 'user', content: 'Hi' }
    ],
    max_tokens: 128,
    stream: false,
    temperature: 0.2,
    top_p: 0.9,
    stop: ['END']
  });
  assert.deepEqual(result, {
    text: 'Hello from provider.',
    tool_calls: [],
    reasoning: 'brief reasoning',
    finish_reason: 'stop',
    usage: { prompt_tokens: 20, completion_tokens: 4 },
    provider_model: model
  });
});

test('forwards each supported Anthropic effort as native reasoning_effort', (t) => {
  const { provider } = loadProvider(t);
  const messages = [{ role: 'user', content: 'Think carefully.' }];
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];

  for (const level of levels) {
    const regular = provider.buildPayload(messages, {
      max_tokens: 128,
      reasoning_effort: level
    }).payload;
    const streaming = provider.buildPayload(messages, {
      max_tokens: 128,
      reasoning_effort: level,
      stream: true
    }).payload;

    assert.equal(regular.reasoning_effort, level);
    assert.equal(streaming.reasoning_effort, level);
    assert.equal(streaming.stream, true);
  }

  const omitted = provider.buildPayload(messages, { max_tokens: 128 }).payload;
  assert.equal(Object.hasOwn(omitted, 'reasoning_effort'), false);
});

test('omits native reasoning_effort when provider support is disabled', (t) => {
  const { provider } = loadProvider(t, {
    PROVIDER_NATIVE_REASONING_EFFORT: 'false'
  });
  const payload = provider.buildPayload([{ role: 'user', content: 'Hello' }], {
    max_tokens: 32,
    reasoning_effort: 'high'
  }).payload;

  assert.equal(Object.hasOwn(payload, 'reasoning_effort'), false);
});

test('maps upstream HTTP errors without leaking provider credentials', async (t) => {
  const { provider } = loadProvider(t);
  global.fetch = async () => response({
    status: 429,
    payload: { error: { message: 'rate limit reached' } }
  });

  await assert.rejects(
    provider.createChatCompletion([{ role: 'user', content: 'Hi' }], { max_tokens: 16 }),
    (error) => error.code === 'UPSTREAM_HTTP_429' &&
      error.statusCode === 502 &&
      /rate limit reached/.test(error.message) &&
      !error.message.includes('provider-test-secret')
  );
});

test('rejects invalid JSON and structurally invalid provider responses', async (t) => {
  const { provider } = loadProvider(t);
  global.fetch = async () => response({ jsonError: new SyntaxError('Unexpected token') });
  await assert.rejects(
    provider.createChatCompletion([], { max_tokens: 16 }),
    (error) => error.code === 'PROVIDER_INVALID_JSON'
  );

  global.fetch = async () => response({ payload: { choices: [] } });
  await assert.rejects(
    provider.createChatCompletion([], { max_tokens: 16 }),
    (error) => error.code === 'PROVIDER_INVALID_RESPONSE'
  );
});

test('maps connection failures to a stable provider error', async (t) => {
  const { provider } = loadProvider(t);
  global.fetch = async () => { throw new TypeError('network unavailable'); };
  await assert.rejects(
    provider.createChatCompletion([], { max_tokens: 16 }),
    (error) => error.code === 'PROVIDER_CONNECTION_FAILED' && error.statusCode === 502
  );
});

test('aborts upstream requests when the client disconnects', async (t) => {
  const { provider } = loadProvider(t);
  global.fetch = async (_url, init) => {
    if (init.signal.aborted) throw new Error('aborted');
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const controller = new AbortController();
  controller.abort(new Error('client disconnected'));

  await assert.rejects(
    provider.createChatCompletion([], { max_tokens: 16 }, controller.signal),
    (error) => error.code === 'CLIENT_DISCONNECTED' && error.statusCode === 499
  );
});

test('enforces the configured provider timeout', async (t) => {
  const { provider } = loadProvider(t, { PROVIDER_TIMEOUT_MS: '1000' });
  global.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('timeout abort')), { once: true });
  });

  await assert.rejects(
    provider.createChatCompletion([], { max_tokens: 16 }),
    (error) => error.code === 'PROVIDER_TIMEOUT' && error.statusCode === 504
  );
});

test('parses provider SSE chunks, finish reasons, reasoning, and final usage', async (t) => {
  const { provider, model } = loadProvider(t);
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hello "},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n'
  ];
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    })
  });

  const result = await provider.createStreamingChatCompletion(
    [{ role: 'user', content: 'Hi' }],
    { max_tokens: 16 }
  );
  assert.equal(result.text, 'hello world');
  assert.equal(result.reasoning, 'thinking');
  assert.equal(result.finish_reason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 2 });
  assert.equal(result.provider_model, model);
});


test('applies the configured provider concurrency limit across parallel client requests', async (t) => {
  const { provider } = loadProvider(t, {
    PROVIDER_MAX_REQUESTS_PER_MINUTE: '20',
    PROVIDER_MAX_CONCURRENT_REQUESTS: '1'
  });
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return response({
      payload: {
        choices: [{
          finish_reason: 'stop',
          message: { content: 'ok' }
        }]
      }
    });
  };

  const results = await Promise.all(Array.from({ length: 4 }, () =>
    provider.createChatCompletion([{ role: 'user', content: 'Hi' }], { max_tokens: 16 })
  ));

  assert.equal(calls, 4);
  assert.equal(maximumActive, 1);
  assert.deepEqual(results.map((result) => result.text), ['ok', 'ok', 'ok', 'ok']);
});

test('rejects malformed JSON in an upstream SSE event', async (t) => {
  const { provider } = loadProvider(t);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: not-json\n\n'));
        controller.close();
      }
    })
  });

  await assert.rejects(
    provider.createStreamingChatCompletion([], { max_tokens: 16 }),
    (error) => error.code === 'PROVIDER_INVALID_STREAM' && error.statusCode === 502
  );
});
