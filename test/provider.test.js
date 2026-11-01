'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { completionsUrl } = require('../src/provider/openai-compatible');

test('normalizes OpenAI-compatible provider URLs', () => {
  assert.equal(completionsUrl('https://provider.example/v1'), 'https://provider.example/v1/chat/completions');
  assert.equal(completionsUrl('https://provider.example/v1/'), 'https://provider.example/v1/chat/completions');
  assert.equal(completionsUrl('https://provider.example'), 'https://provider.example/v1/chat/completions');
  assert.equal(completionsUrl('https://provider.example/custom/chat/completions'), 'https://provider.example/custom/chat/completions');
});