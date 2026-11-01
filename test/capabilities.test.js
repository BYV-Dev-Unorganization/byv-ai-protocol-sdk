'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProviderModel } = require('./provider-model-fixture');
const {
  apiRootUrl,
  modelMetadataUrls,
  extractModelMetadata,
  mergeCapabilityValues
} = require('../src/provider/capabilities');

const PROVIDER_MODEL = resolveProviderModel();

test('builds model metadata endpoints from OpenAI-compatible base URLs', () => {
  assert.equal(apiRootUrl('https://provider.example/v1').toString(), 'https://provider.example/v1');
  assert.deepEqual(modelMetadataUrls('https://provider.example/v1', PROVIDER_MODEL), {
    detail: 'https://provider.example/v1/models/' + encodeURIComponent(PROVIDER_MODEL),
    collection: 'https://provider.example/v1/models'
  });
  assert.equal(
    modelMetadataUrls('https://provider.example/custom/chat/completions', PROVIDER_MODEL).detail,
    'https://provider.example/custom/models/' + encodeURIComponent(PROVIDER_MODEL)
  );
});

test('extracts context, input, output, and cache capabilities for the configured provider model', () => {
  const metadata = extractModelMetadata({
    data: [{
      id: PROVIDER_MODEL,
      context_length: 1000000,
      top_provider: { max_completion_tokens: 64000 },
      max_input_tokens: 900000,
      supports_prompt_caching: true
    }]
  }, PROVIDER_MODEL);

  assert.deepEqual(metadata, {
    context_window_tokens: 1000000,
    max_input_tokens: 900000,
    max_output_tokens: 64000,
    supports_prompt_caching: true
  });
});

test('prefers explicit environment limits over provider-discovered values', () => {
  const merged = mergeCapabilityValues({
    context_window_tokens: 1000000,
    max_input_tokens: 900000,
    max_output_tokens: 64000,
    supports_prompt_caching: true
  }, {
    context_window_tokens: 500000,
    max_output_tokens: 32000
  });

  assert.equal(merged.context_window_tokens, 500000);
  assert.equal(merged.max_input_tokens, 900000);
  assert.equal(merged.max_output_tokens, 32000);
  assert.equal(merged.supports_prompt_caching, true);
  assert.equal(merged.field_sources.context_window_tokens, 'environment');
  assert.equal(merged.field_sources.max_input_tokens, 'provider_metadata');
});

test('does not guess context limits when the configured provider model omits them', () => {
  assert.equal(extractModelMetadata({ id: PROVIDER_MODEL, object: 'model' }, PROVIDER_MODEL), null);
});

test('recognizes context_limit in the configured provider model catalog record', () => {
  const metadata = extractModelMetadata({
    object: 'list',
    data: [{
      id: PROVIDER_MODEL,
      name: 'Configured provider model',
      context_limit: 1000000,
      provider: 'test-provider'
    }]
  }, PROVIDER_MODEL);

  assert.deepEqual(metadata, {
    context_window_tokens: 1000000,
    max_input_tokens: null,
    max_output_tokens: null,
    supports_prompt_caching: null
  });
});
