'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProviderModel } = require('./provider-model-fixture');

const ENV_KEYS = [
  'PROVIDER_BASE_URL',
  'PROVIDER_API_KEY',
  'PROVIDER_MODEL',
  'PROVIDER_SAMPLING_AUTO_PROBE',
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
    PROVIDER_SAMPLING_AUTO_PROBE: 'false',
    PROVIDER_NATIVE_REASONING_EFFORT: 'true',
    PROVIDER_TIMEOUT_MS: '300000',
    PROVIDER_MAX_REQUESTS_PER_MINUTE: '0',
    PROVIDER_MAX_CONCURRENT_REQUESTS: '0',
    ...overrides,
    PROVIDER_MODEL: model
  });

  const configPath = require.resolve('../src/config');
  const providerPath = require.resolve('../src/provider/openai-compatible');
  const samplingCapabilitiesPath = require.resolve('../src/provider/sampling-capabilities');
  delete require.cache[samplingCapabilitiesPath];
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
    delete require.cache[samplingCapabilitiesPath];
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

test('uses upstream sampling defaults when auto-probe is disabled and normalizes output', async (t) => {
  const { provider, model } = loadProvider(t);
  let captured;
  let fetchCalls = 0;
  global.fetch = async (url, init) => {
    fetchCalls++;
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
    {
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      provider_params: { min_p: 0.05 },
      stop_sequences: ['END']
    }
  );

  assert.equal(captured.url, 'https://provider.example/v1/chat/completions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer provider-test-secret');
  assert.equal(fetchCalls, 1, 'disabled auto-probe must not send a sampling probe');
  assert.equal(Object.hasOwn(captured.payload, 'temperature'), false);
  assert.equal(Object.hasOwn(captured.payload, 'top_p'), false);
  assert.equal(Object.hasOwn(captured.payload, 'top_k'), false);
  assert.equal(Object.hasOwn(captured.payload, 'min_p'), false);
  assert.deepEqual(captured.payload, {
    model,
    messages: [
      { role: 'system', content: 'stable prompt' },
      { role: 'user', content: 'Hi' }
    ],
    max_tokens: 128,
    stream: false,
    stop: ['END'],
    tool_choice: 'none'
  });
  assert.deepEqual(result, {
    id: null,
    text: 'Hello from provider.',
    tool_calls: [],
    reasoning: 'brief reasoning',
    finish_reason: 'stop',
    usage: { prompt_tokens: 20, completion_tokens: 4 },
    provider_model: model
  });
});

test('forwards top_k and allowlisted provider sampling parameters in regular and streaming payloads', (t) => {
  const { provider } = loadProvider(t, { PROVIDER_SAMPLING_AUTO_PROBE: 'true' });
  const messages = [{ role: 'user', content: 'Tune sampling.' }];
  const providerParams = {
    min_p: 0.05,
    frequency_penalty: 0.2,
    presence_penalty: -0.1,
    repetition_penalty: 1.1,
    typical_p: 0.95,
    top_a: 0.2,
    tfs_z: 0.9,
    seed: 42,
    logit_bias: { '123': -2.5 },
    mirostat: 2,
    mirostat_tau: 5,
    mirostat_eta: 0.1
  };

  for (const stream of [false, true]) {
    const payload = provider.buildPayload(messages, {
      max_tokens: 128,
      stream,
      top_k: 40,
      provider_params: providerParams,
      samplingCapabilities: {
        accepted_parameters: ['top_k', ...Object.keys(providerParams)]
      }
    }).payload;

    assert.equal(payload.top_k, 40);
    assert.equal(payload.min_p, 0.05);
    assert.equal(payload.frequency_penalty, 0.2);
    assert.equal(payload.presence_penalty, -0.1);
    assert.equal(payload.repetition_penalty, 1.1);
    assert.equal(payload.typical_p, 0.95);
    assert.equal(payload.top_a, 0.2);
    assert.equal(payload.tfs_z, 0.9);
    assert.equal(payload.seed, 42);
    assert.deepEqual(payload.logit_bias, { '123': -2.5 });
    assert.equal(payload.mirostat, 2);
    assert.equal(payload.mirostat_tau, 5);
    assert.equal(payload.mirostat_eta, 0.1);
    assert.equal(Object.hasOwn(payload, 'provider_params'), false);
    assert.equal(payload.stream, stream);
  }
});

test('auto-probes provider sampling support and omits fields the provider rejects', async (t) => {
  const { provider, model } = loadProvider(t, {
    PROVIDER_SAMPLING_AUTO_PROBE: 'true'
  });
  const parameterNames = [
    'temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty',
    'presence_penalty', 'repetition_penalty', 'typical_p', 'top_a',
    'tfs_z', 'seed', 'logit_bias', 'mirostat', 'mirostat_tau', 'mirostat_eta'
  ];
  let probeRequests = 0;
  let actualPayload = null;

  global.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const isProbe = payload.messages &&
      payload.messages[0] &&
      payload.messages[0].content === 'Reply with OK.';

    if (isProbe) {
      probeRequests++;
      const present = parameterNames.filter((name) => Object.hasOwn(payload, name));
      if (present.length > 1) {
        return response({
          status: 400,
          raw: JSON.stringify({ error: { message: 'Unsupported parameter: top_k' } })
        });
      }
      if (present[0] === 'top_k') {
        return response({
          status: 400,
          raw: JSON.stringify({ error: { message: 'Unsupported parameter: top_k' } })
        });
      }
      return response({ payload: {} });
    }

    actualPayload = payload;
    return response({
      payload: {
        model,
        choices: [{ finish_reason: 'stop', message: { content: 'Sampling filtered.' } }]
      }
    });
  };

  await provider.createChatCompletion(
    [{ role: 'user', content: 'Tune these parameters.' }],
    {
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.85,
      top_k: 20,
      provider_params: { min_p: 0.05, mirostat: 2 }
    }
  );

  assert.equal(probeRequests, 1 + parameterNames.length);
  assert.equal(actualPayload.temperature, 0.2);
  assert.equal(actualPayload.top_p, 0.85);
  assert.equal(Object.hasOwn(actualPayload, 'top_k'), false);
  assert.equal(actualPayload.min_p, 0.05);
  assert.equal(actualPayload.mirostat, 2);
});

test('rejects unrecognized provider sampling parameters at the adapter boundary', (t) => {
  const { provider } = loadProvider(t);
  assert.throws(
    () => provider.buildPayload([{ role: 'user', content: 'Hello' }], {
      max_tokens: 32,
      provider_params: { unsupported_sampling_flag: true }
    }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_PROVIDER_PARAMS'
  );
});

test('forwards multimodal image_url parts unchanged in regular and streaming provider payloads', async (t) => {
  const { provider, model } = loadProvider(t);
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image.' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aGVsbG8=' }
      }
    ]
  }];
  let captured;
  global.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return response({
      payload: {
        model,
        choices: [{ finish_reason: 'stop', message: { content: 'A test image.' } }]
      }
    });
  };

  await provider.createChatCompletion(messages, { max_tokens: 64 });
  assert.deepEqual(captured.messages, messages);

  const streamingPayload = provider.buildPayload(messages, {
    max_tokens: 64,
    stream: true
  }).payload;
  assert.deepEqual(streamingPayload.messages, messages);
  assert.equal(streamingPayload.stream, true);
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

test('preserves safe OpenRouter provider error metadata for diagnosis', async (t) => {
  const { provider } = loadProvider(t);
  const imageData = 'A'.repeat(200);
  const upstream = response({
    status: 400,
    payload: {
      id: 'gen-openrouter-diagnostic',
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: {
          provider_name: 'Stealth',
          error_type: 'provider_error',
          provider_code: 'invalid_request',
          is_byok: false,
          raw: 'Unsupported image payload data:image/png;base64,' + imageData +
            '; api_key=provider-secret-value; invalid parameter: reasoning_effort'
        }
      }
    }
  });
  upstream.headers = new Headers({ 'x-request-id': 'or-test-request-123' });
  global.fetch = async () => upstream;

  await assert.rejects(
    provider.createChatCompletion([{ role: 'user', content: 'Hi' }], { max_tokens: 16 }),
    (error) => error.code === 'UPSTREAM_HTTP_400' &&
      error.statusCode === 502 &&
      /provider=Stealth/.test(error.message) &&
      /error_type=provider_error/.test(error.message) &&
      /provider_code=invalid_request/.test(error.message) &&
      /is_byok=false/.test(error.message) &&
      /provider_raw=/.test(error.message) &&
      /upstream_request_id=or-test-request-123/.test(error.message) &&
      /reasoning_effort/.test(error.message) &&
      !error.message.includes(imageData) &&
      !error.message.includes('provider-secret-value')
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
