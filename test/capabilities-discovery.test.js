'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = [
  'PROVIDER_BASE_URL',
  'PROVIDER_API_KEY',
  'PROVIDER_MODEL',
  'PROVIDER_MODEL_METADATA_TIMEOUT_MS',
  'PROVIDER_CAPABILITIES_CACHE_MS',
  'PROVIDER_CONTEXT_WINDOW_TOKENS',
  'PROVIDER_MAX_INPUT_TOKENS',
  'PROVIDER_MAX_OUTPUT_TOKENS'
];

function loadCapabilities(t, overrides = {}) {
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const previousFetch = global.fetch;
  Object.assign(process.env, {
    PROVIDER_BASE_URL: 'https://provider.example/v1',
    PROVIDER_API_KEY: 'metadata-test-secret',
    PROVIDER_MODEL: 'model-x',
    PROVIDER_MODEL_METADATA_TIMEOUT_MS: '5000',
    PROVIDER_CAPABILITIES_CACHE_MS: '60000',
    PROVIDER_CONTEXT_WINDOW_TOKENS: '',
    PROVIDER_MAX_INPUT_TOKENS: '',
    PROVIDER_MAX_OUTPUT_TOKENS: '',
    ...overrides
  });

  const configPath = require.resolve('../src/config');
  const capabilitiesPath = require.resolve('../src/provider/capabilities');
  delete require.cache[capabilitiesPath];
  delete require.cache[configPath];
  const capabilities = require(capabilitiesPath);

  t.after(() => {
    global.fetch = previousFetch;
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    delete require.cache[capabilitiesPath];
    delete require.cache[configPath];
  });
  return capabilities;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); }
  };
}

test('discovers exact-model metadata from the model detail endpoint', async (t) => {
  const capabilities = loadCapabilities(t);
  let requestedUrl = '';
  let authorization = '';
  global.fetch = async (url, init) => {
    requestedUrl = url;
    authorization = init.headers.Authorization;
    return jsonResponse({
      id: 'model-x',
      context_length: 1000000,
      max_input_tokens: 900000,
      max_output_tokens: 64000
    });
  };

  const result = await capabilities.getModelCapabilities({ forceRefresh: true });
  assert.equal(requestedUrl, 'https://provider.example/v1/models/model-x');
  assert.equal(authorization, 'Bearer metadata-test-secret');
  assert.equal(result.metadata_status, 'available');
  assert.equal(result.context_window_tokens, 1000000);
  assert.equal(result.max_input_tokens, 900000);
  assert.equal(result.max_output_tokens, 64000);
  assert.equal(result.field_sources.context_window_tokens, 'provider_metadata');
});

test('falls back to the model catalog and selects only the exact configured model ID', async (t) => {
  const capabilities = loadCapabilities(t);
  const requested = [];
  global.fetch = async (url) => {
    requested.push(url);
    if (url.endsWith('/models/model-x')) return jsonResponse({ error: 'not found' }, 404);
    return jsonResponse({
      object: 'list',
      data: [
        { id: 'another-model', context_limit: 2000000 },
        { id: 'model-x', context_limit: 1000000, provider: 'test' }
      ]
    });
  };

  const result = await capabilities.getModelCapabilities({ forceRefresh: true });
  assert.deepEqual(requested, [
    'https://provider.example/v1/models/model-x',
    'https://provider.example/v1/models'
  ]);
  assert.equal(result.metadata_status, 'available');
  assert.equal(result.context_window_tokens, 1000000);
});

test('caches discoveries, shares concurrent refresh work, and honors force refresh', async (t) => {
  const capabilities = loadCapabilities(t);
  let calls = 0;
  global.fetch = async () => {
    calls++;
    await Promise.resolve();
    return jsonResponse({ id: 'model-x', context_length: 1000000 });
  };

  const [first, concurrent] = await Promise.all([
    capabilities.getModelCapabilities(),
    capabilities.getModelCapabilities()
  ]);
  assert.equal(first.context_window_tokens, 1000000);
  assert.deepEqual(concurrent, first);
  assert.equal(calls, 1);

  await capabilities.getModelCapabilities();
  assert.equal(calls, 1);

  await capabilities.getModelCapabilities({ forceRefresh: true });
  assert.equal(calls, 2);
});

test('does not guess limits when provider metadata is unavailable', async (t) => {
  const capabilities = loadCapabilities(t);
  global.fetch = async () => { throw new Error('provider unavailable'); };

  const result = await capabilities.getModelCapabilities({ forceRefresh: true });
  assert.equal(result.metadata_status, 'unknown');
  assert.equal(result.context_window_tokens, null);
  assert.equal(result.max_input_tokens, null);
  assert.equal(result.max_output_tokens, null);
  assert.equal(result.supports_prompt_caching, null);
});
