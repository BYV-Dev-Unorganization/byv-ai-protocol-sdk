'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  apiRootUrl,
  modelMetadataUrls,
  extractModelMetadata,
  mergeCapabilityValues
} = require('../src/provider/capabilities');

test('builds model metadata endpoints from OpenAI-compatible base URLs', () => {
  assert.equal(apiRootUrl('https://provider.example/v1').toString(), 'https://provider.example/v1');
  assert.deepEqual(modelMetadataUrls('https://provider.example/v1', 'org/model-x'), {
    detail: 'https://provider.example/v1/models/org%2Fmodel-x',
    collection: 'https://provider.example/v1/models'
  });
  assert.equal(
    modelMetadataUrls('https://provider.example/custom/chat/completions', 'model-x').detail,
    'https://provider.example/custom/models/model-x'
  );
});

test('extracts context, input, output, and cache capabilities from model metadata', () => {
  const metadata = extractModelMetadata({
    data: [{
      id: 'provider/model-x',
      context_length: 1000000,
      top_provider: { max_completion_tokens: 64000 },
      max_input_tokens: 900000,
      supports_prompt_caching: true
    }]
  }, 'provider/model-x');

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

test('does not guess context limits when the provider omits them', () => {
  assert.equal(extractModelMetadata({ id: 'model-x', object: 'model' }, 'model-x'), null);
});
