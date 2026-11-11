'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = [
  'PROVIDER_BASE_URL',
  'PROVIDER_API_KEY',
  'PROVIDER_MODEL',
  'PROVIDER_MODEL_METADATA_TIMEOUT_MS',
  'PROVIDER_CAPABILITIES_CACHE_MS',
  'PROVIDER_SAMPLING_AUTO_PROBE',
  'PROVIDER_SAMPLING_PROBE_TIMEOUT_MS',
  'PROVIDER_SUPPORTED_SAMPLING_PARAMETERS'
];

function loadSamplingCapabilities(t, overrides = {}) {
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const previousFetch = global.fetch;
  Object.assign(process.env, {
    PROVIDER_BASE_URL: 'https://provider.example/v1',
    PROVIDER_API_KEY: 'sampling-test-secret',
    PROVIDER_MODEL: 'test-model',
    PROVIDER_MODEL_METADATA_TIMEOUT_MS: '1000',
    PROVIDER_CAPABILITIES_CACHE_MS: '60000',
    PROVIDER_SAMPLING_AUTO_PROBE: 'true',
    PROVIDER_SAMPLING_PROBE_TIMEOUT_MS: '1000',
    PROVIDER_SUPPORTED_SAMPLING_PARAMETERS: '',
    ...overrides
  });

  const configPath = require.resolve('../src/config');
  const providerCapabilitiesPath = require.resolve('../src/provider/capabilities');
  const samplingPath = require.resolve('../src/provider/sampling-capabilities');
  delete require.cache[samplingPath];
  delete require.cache[providerCapabilitiesPath];
  delete require.cache[configPath];
  const sampling = require(samplingPath);

  t.after(() => {
    global.fetch = previousFetch;
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    delete require.cache[samplingPath];
    delete require.cache[providerCapabilitiesPath];
    delete require.cache[configPath];
  });

  return sampling;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    async text() { return JSON.stringify(payload); }
  };
}

test('uses model metadata supported_parameters before active probing', async (t) => {
  const sampling = loadSamplingCapabilities(t);
  const requested = [];
  global.fetch = async (url) => {
    requested.push(url);
    if (url.endsWith('/models/test-model')) {
      return jsonResponse({
        id: 'test-model',
        supported_parameters: ['temperature', 'top_p', 'min_p', 'reasoning_effort'],
        supported_reasoning_efforts: ['low', 'high']
      });
    }
    throw new Error('catalog should not be requested when detail metadata is complete');
  };

  const result = await sampling.getSamplingCapabilities({ forceRefresh: true });
  assert.equal(result.source, 'provider_metadata');
  assert.equal(result.status, 'available');
  assert.deepEqual(result.supported_parameters, [
    'temperature',
    'top_p',
    'min_p',
    'reasoning_effort'
  ]);
  assert.equal(result.parameters.temperature, true);
  assert.equal(result.parameters.top_k, false);
  assert.equal(result.parameters.frequency_penalty, false);
  assert.deepEqual(result.reasoning_effort_levels, ['low', 'high']);
  assert.deepEqual(requested, ['https://provider.example/v1/models/test-model']);
});

test('falls back to active per-parameter probes when metadata has no parameter list', async (t) => {
  const sampling = loadSamplingCapabilities(t);
  const probes = [];
  global.fetch = async (url, init = {}) => {
    if (init.method === 'GET') return jsonResponse({ id: 'test-model' });
    const payload = JSON.parse(init.body);
    probes.push(payload);
    if (Object.hasOwn(payload, 'top_k') || Object.hasOwn(payload, 'min_p')) {
      return jsonResponse({
        error: { message: 'The model rejected this optional parameter.' }
      }, 400);
    }
    return jsonResponse({
      id: 'chatcmpl-probe',
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }]
    });
  };

  const result = await sampling.getSamplingCapabilities({ forceRefresh: true });
  assert.equal(result.source, 'active_probe');
  assert.equal(result.status, 'available');
  assert.equal(result.parameters.temperature, true);
  assert.equal(result.parameters.top_p, true);
  assert.equal(result.parameters.top_k, false);
  assert.equal(result.parameters.min_p, false);
  assert.equal(result.parameters.repetition_penalty, true);
  assert.ok(probes.length > 2);
  assert.ok(probes.every((payload) => payload.max_tokens === 16 && payload.stream === false));
  assert.ok(probes.every((payload) => payload.messages.length === 1));
});

test('fails closed when provider baseline probe cannot be completed', async (t) => {
  const sampling = loadSamplingCapabilities(t);
  let postCalls = 0;
  global.fetch = async (url, init = {}) => {
    if (init.method === 'GET') return jsonResponse({ id: 'test-model' });
    postCalls++;
    return jsonResponse({ error: { message: 'unauthorized' } }, 401);
  };

  const result = await sampling.getSamplingCapabilities({ forceRefresh: true });
  assert.equal(result.status, 'baseline_unavailable');
  assert.equal(result.parameters.temperature, null);
  assert.equal(result.parameters.top_k, null);
  assert.equal(postCalls, 1);
});

test('manual supported-parameter allowlist overrides discovery and disables all unlisted fields', async (t) => {
  const sampling = loadSamplingCapabilities(t, {
    PROVIDER_SAMPLING_AUTO_PROBE: 'false',
    PROVIDER_SUPPORTED_SAMPLING_PARAMETERS: 'temperature,min_p'
  });
  global.fetch = async () => {
    throw new Error('manual allowlist must avoid network discovery');
  };

  const result = await sampling.getSamplingCapabilities({ forceRefresh: true });
  assert.equal(result.source, 'environment');
  assert.equal(result.parameters.temperature, true);
  assert.equal(result.parameters.min_p, true);
  assert.equal(result.parameters.top_k, false);
  assert.equal(result.parameters.logit_bias, false);
});

test('filters unsupported top-level and provider-specific sampling fields before forwarding', () => {
  const sampling = require('../src/provider/sampling-capabilities');
  const filtered = sampling.filterSamplingOptions({
    temperature: 0.4,
    top_p: 0.9,
    top_k: 40,
    reasoning_effort: 'xhigh',
    provider_params: {
      min_p: 0.05,
      frequency_penalty: 0.2,
      repetition_penalty: 1.1
    },
    max_tokens: 256
  }, {
    parameters: {
      temperature: true,
      top_p: false,
      top_k: false,
      reasoning_effort: true,
      min_p: true,
      frequency_penalty: false,
      repetition_penalty: true
    }
  });

  assert.equal(filtered.options.temperature, 0.4);
  assert.equal(Object.hasOwn(filtered.options, 'top_p'), false);
  assert.equal(Object.hasOwn(filtered.options, 'top_k'), false);
  assert.equal(Object.hasOwn(filtered.options, 'reasoning_effort'), false);
  assert.deepEqual(filtered.options.provider_params, {
    min_p: 0.05,
    repetition_penalty: 1.1
  });
  assert.equal(filtered.options.max_tokens, 256);
  assert.deepEqual(filtered.omitted, ['top_p', 'top_k', 'reasoning_effort', 'frequency_penalty']);
});

test('forwards only the exact reasoning effort levels confirmed by discovery', () => {
  const sampling = require('../src/provider/sampling-capabilities');
  const capabilities = {
    parameters: { temperature: true, reasoning_effort: true },
    reasoning_effort_levels: ['low', 'high']
  };
  const accepted = sampling.filterSamplingOptions(
    { reasoning_effort: 'high', temperature: 0.3 },
    capabilities
  );
  const rejected = sampling.filterSamplingOptions(
    { reasoning_effort: 'max', temperature: 0.3 },
    capabilities
  );
  assert.equal(accepted.options.reasoning_effort, 'high');
  assert.equal(rejected.options.reasoning_effort, undefined);
  assert.deepEqual(rejected.omitted, ['reasoning_effort']);
});

test('does not force OpenRouter routing when no optional sampling field is sent', () => {
  const sampling = require('../src/provider/sampling-capabilities');
  const filtered = sampling.filterSamplingOptions({
    max_tokens: 256
  }, {
    parameters: {},
    provider_require_parameters: true
  });
  assert.equal(Object.hasOwn(filtered.options, 'provider'), false);
});

test('adds OpenRouter require_parameters only when model metadata is from OpenRouter', () => {
  const sampling = require('../src/provider/sampling-capabilities');
  const filtered = sampling.filterSamplingOptions({
    temperature: 0.4
  }, {
    parameters: { temperature: true },
    provider_require_parameters: true
  });
  assert.deepEqual(filtered.options.provider, { require_parameters: true });
});
