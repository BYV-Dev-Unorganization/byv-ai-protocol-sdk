'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function loadConfig(env) {
  const source = [
    "const c = require('./src/config');",
    "process.stdout.write(JSON.stringify({",
    "PORT: c.PORT,",
    "PROVIDER_MODEL: c.PROVIDER_MODEL,",
    "PROVIDER_TIMEOUT_MS: c.PROVIDER_TIMEOUT_MS,",
    "PROVIDER_MODEL_METADATA_TIMEOUT_MS: c.PROVIDER_MODEL_METADATA_TIMEOUT_MS,",
    "PROVIDER_CAPABILITIES_CACHE_MS: c.PROVIDER_CAPABILITIES_CACHE_MS,",
    "PROVIDER_CONTEXT_WINDOW_TOKENS: c.PROVIDER_CONTEXT_WINDOW_TOKENS,",
    "PROVIDER_MAX_INPUT_TOKENS: c.PROVIDER_MAX_INPUT_TOKENS,",
    "PROVIDER_MAX_OUTPUT_TOKENS: c.PROVIDER_MAX_OUTPUT_TOKENS,",
    "CONTEXT_WINDOW_SAFETY_TOKENS: c.CONTEXT_WINDOW_SAFETY_TOKENS,",
    "MAX_BODY_BYTES: c.MAX_BODY_BYTES,",
    "MAX_OUTPUT_CHARS: c.MAX_OUTPUT_CHARS,",
    "MAX_PROMPT_CHARS: c.MAX_PROMPT_CHARS,",
    "MAX_PENDING_REQUESTS: c.MAX_PENDING_REQUESTS,",
    "MAX_RECOVERY_ATTEMPTS: c.MAX_RECOVERY_ATTEMPTS",
    "}));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('reads the upstream provider model from PROVIDER_MODEL and accepts valid bounded configuration', () => {
  const config = loadConfig({
    PORT: '8877',
    PROVIDER_MODEL: 'configured-model-from-env',
    PROVIDER_TIMEOUT_MS: '120000',
    PROVIDER_MODEL_METADATA_TIMEOUT_MS: '7000',
    PROVIDER_CAPABILITIES_CACHE_MS: '60000',
    PROVIDER_CONTEXT_WINDOW_TOKENS: '1000000',
    PROVIDER_MAX_INPUT_TOKENS: '900000',
    PROVIDER_MAX_OUTPUT_TOKENS: '64000',
    CONTEXT_WINDOW_SAFETY_TOKENS: '2048',
    MAX_BODY_BYTES: '2097152',
    MAX_OUTPUT_CHARS: '1048576',
    MAX_PROMPT_CHARS: '240000',
    MAX_PENDING_REQUESTS: '12',
    MAX_RECOVERY_ATTEMPTS: '3'
  });

  assert.deepEqual(config, {
    PORT: 8877,
    PROVIDER_MODEL: 'configured-model-from-env',
    PROVIDER_TIMEOUT_MS: 120000,
    PROVIDER_MODEL_METADATA_TIMEOUT_MS: 7000,
    PROVIDER_CAPABILITIES_CACHE_MS: 60000,
    PROVIDER_CONTEXT_WINDOW_TOKENS: 1000000,
    PROVIDER_MAX_INPUT_TOKENS: 900000,
    PROVIDER_MAX_OUTPUT_TOKENS: 64000,
    CONTEXT_WINDOW_SAFETY_TOKENS: 2048,
    MAX_BODY_BYTES: 2097152,
    MAX_OUTPUT_CHARS: 1048576,
    MAX_PROMPT_CHARS: 240000,
    MAX_PENDING_REQUESTS: 12,
    MAX_RECOVERY_ATTEMPTS: 3
  });
});

test('falls back or ignores invalid, fractional, and out-of-range configuration values', () => {
  const config = loadConfig({
    PORT: '0',
    PROVIDER_MODEL: 'another-configured-model-from-env',
    PROVIDER_TIMEOUT_MS: '300000.5',
    PROVIDER_MODEL_METADATA_TIMEOUT_MS: '999999',
    PROVIDER_CAPABILITIES_CACHE_MS: '-1',
    PROVIDER_CONTEXT_WINDOW_TOKENS: '1.5',
    PROVIDER_MAX_INPUT_TOKENS: 'NaN',
    PROVIDER_MAX_OUTPUT_TOKENS: '0',
    CONTEXT_WINDOW_SAFETY_TOKENS: 'not-a-number',
    MAX_BODY_BYTES: '100',
    MAX_OUTPUT_CHARS: '999999999',
    MAX_PROMPT_CHARS: '1000',
    MAX_PENDING_REQUESTS: '129',
    MAX_RECOVERY_ATTEMPTS: '6'
  });

  assert.deepEqual(config, {
    PORT: 8787,
    PROVIDER_MODEL: 'another-configured-model-from-env',
    PROVIDER_TIMEOUT_MS: 300000,
    PROVIDER_MODEL_METADATA_TIMEOUT_MS: 5000,
    PROVIDER_CAPABILITIES_CACHE_MS: 300000,
    PROVIDER_CONTEXT_WINDOW_TOKENS: null,
    PROVIDER_MAX_INPUT_TOKENS: null,
    PROVIDER_MAX_OUTPUT_TOKENS: null,
    CONTEXT_WINDOW_SAFETY_TOKENS: 1024,
    MAX_BODY_BYTES: 10485760,
    MAX_OUTPUT_CHARS: 2097152,
    MAX_PROMPT_CHARS: 120000,
    MAX_PENDING_REQUESTS: 8,
    MAX_RECOVERY_ATTEMPTS: 2
  });
});
