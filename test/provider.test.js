'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { completionsUrl } = require('../src/provider/openai-compatible');

test('normalizes OpenAI-compatible provider URLs', () => {
  assert.equal(completionsUrl('https://provider.example/v1'), 'https://provider.example/v1/chat/completions');
  assert.equal(completionsUrl('https://provider.example/v1/'), 'https://provider.example/v1/chat/completions');
  assert.equal(completionsUrl('https://provider.example'), 'https://provider.example/v1/chat/completions');
  assert.equal(completionsUrl('https://provider.example/custom/chat/completions'), 'https://provider.example/custom/chat/completions');
});
test('builds native function tools and maps tool_choice into the provider request payload', () => {
  const script = [
    "const { buildPayload } = require('./src/provider/openai-compatible');",
    "const { payload } = buildPayload([{ role: 'user', content: 'Read README.md' }], {",
    "  max_tokens: 256,",
    "  tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],",
    "  tool_choice: { type: 'tool', name: 'Read' }",
    "});",
    "process.stdout.write(JSON.stringify(payload));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://router.bynara.id/v1',
      PROVIDER_MODEL: 'deepseek-v4-flash',
      PROVIDER_API_KEY: 'unit-test-secret',
      PROVIDER_NATIVE_TOOL_CALLING: 'true'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.tools, [{
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }
  }]);
  assert.deepEqual(payload.tool_choice, {
    type: 'function',
    function: { name: 'Read' }
  });
  assert.deepEqual(payload.thinking, { type: 'disabled' });
});

test('keeps DeepSeek auto tool choice in the provider default thinking mode', () => {
  const script = [
    "const { buildPayload } = require('./src/provider/openai-compatible');",
    "const { payload } = buildPayload([{ role: 'user', content: 'Read README.md' }], {",
    "  max_tokens: 256,",
    "  tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],",
    "  tool_choice: 'auto'",
    "});",
    "process.stdout.write(JSON.stringify(payload));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://router.bynara.id/v1',
      PROVIDER_MODEL: 'deepseek-v4-flash',
      PROVIDER_API_KEY: 'unit-test-secret',
      PROVIDER_NATIVE_TOOL_CALLING: 'true'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.tool_choice, 'auto');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'thinking'), false);
});

test('omits provider-native tool fields when native function calling is disabled', () => {
  const script = [
    "const { buildPayload } = require('./src/provider/openai-compatible');",
    "const { payload } = buildPayload([{ role: 'user', content: 'Read README.md' }], {",
    "  max_tokens: 256,",
    "  tools: [{ name: 'Read', input_schema: { type: 'object' } }],",
    "  tool_choice: 'auto'",
    "});",
    "process.stdout.write(JSON.stringify(payload));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      PROVIDER_NATIVE_TOOL_CALLING: 'false'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'tools'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'tool_choice'), false);
});
