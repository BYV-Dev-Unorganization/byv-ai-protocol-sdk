'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    console.warn('[config] invalid ' + name + '; using default ' + fallback);
    return fallback;
  }
  return value;
}

function optionalBoundedInteger(name, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    console.warn('[config] invalid ' + name + '; ignoring the value');
    return null;
  }
  return value;
}

function booleanFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  console.warn('[config] invalid ' + name + '; using default ' + fallback);
  return fallback;
}

const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = boundedInteger('PORT', 8787, 1, 65535);
const HOST = process.env.HOST || '127.0.0.1';
const PROVIDER_BASE_URL = (process.env.PROVIDER_BASE_URL || '').trim();
const PROVIDER_API_KEY = (process.env.PROVIDER_API_KEY || '').trim();
const PROVIDER_MODEL = (process.env.PROVIDER_MODEL || '').trim();
const DSML_TOOL_CALL = booleanFlag('DSML_TOOL_CALL', true);
const rawNoToolExperimentVariant = String(process.env.NO_TOOL_EXPERIMENT_VARIANT || 'A').trim().toUpperCase();
const NO_TOOL_EXPERIMENT_VARIANT = ['A', 'B'].includes(rawNoToolExperimentVariant)
  ? rawNoToolExperimentVariant
  : 'A';
if (rawNoToolExperimentVariant !== NO_TOOL_EXPERIMENT_VARIANT) {
  console.warn('[config] invalid NO_TOOL_EXPERIMENT_VARIANT; using default A');
}
const PROVIDER_NATIVE_REASONING_EFFORT = booleanFlag('PROVIDER_NATIVE_REASONING_EFFORT', false);
const PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS = booleanFlag('PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS', false);
const PROVIDER_TIMEOUT_MS = boundedInteger('PROVIDER_TIMEOUT_MS', 300000, 1000, 3600000);
const MAX_PROVIDER_RETRIES = boundedInteger('MAX_PROVIDER_RETRIES', 1, 0, 3);
const STREAM_PING_INTERVAL_MS = boundedInteger('STREAM_PING_INTERVAL_MS', 15000, 1000, 60000);
const PROVIDER_MAX_REQUESTS_PER_MINUTE = boundedInteger('PROVIDER_MAX_REQUESTS_PER_MINUTE', 0, 0, 1000000);
const PROVIDER_MAX_CONCURRENT_REQUESTS = boundedInteger('PROVIDER_MAX_CONCURRENT_REQUESTS', 0, 0, 128);
const PROVIDER_MODEL_METADATA_TIMEOUT_MS = boundedInteger('PROVIDER_MODEL_METADATA_TIMEOUT_MS', 5000, 500, 30000);
const PROVIDER_CAPABILITIES_CACHE_MS = boundedInteger('PROVIDER_CAPABILITIES_CACHE_MS', 300000, 1000, 86400000);
const PROVIDER_CONTEXT_WINDOW_TOKENS = optionalBoundedInteger('PROVIDER_CONTEXT_WINDOW_TOKENS', 1, 10000000);
const PROVIDER_MAX_INPUT_TOKENS = optionalBoundedInteger('PROVIDER_MAX_INPUT_TOKENS', 1, 10000000);
const PROVIDER_MAX_OUTPUT_TOKENS = optionalBoundedInteger('PROVIDER_MAX_OUTPUT_TOKENS', 1, 10000000);
const CONTEXT_WINDOW_SAFETY_TOKENS = boundedInteger('CONTEXT_WINDOW_SAFETY_TOKENS', 1024, 0, 1000000);
const MAX_BODY_BYTES = boundedInteger('MAX_BODY_BYTES', 10 * 1024 * 1024, 1024, 100 * 1024 * 1024);
const MAX_OUTPUT_CHARS = boundedInteger('MAX_OUTPUT_CHARS', 2 * 1024 * 1024, 1024, 20 * 1024 * 1024);
const MAX_PROMPT_CHARS = boundedInteger('MAX_PROMPT_CHARS', 4000000, 8192, 8000000);
const COMPACTION_MAX_INPUT_TOKENS = boundedInteger('COMPACTION_MAX_INPUT_TOKENS', 32768, 1024, 1000000);
const COMPACTION_MAX_OUTPUT_TOKENS = boundedInteger('COMPACTION_MAX_OUTPUT_TOKENS', 8192, 256, 200000);
const COMPACTION_MAX_SYSTEM_CHARS = boundedInteger('COMPACTION_MAX_SYSTEM_CHARS', 8000, 1024, 100000);
const MAX_PENDING_REQUESTS = boundedInteger('MAX_PENDING_REQUESTS', 8, 1, 128);
const MAX_RECOVERY_ATTEMPTS = boundedInteger('MAX_RECOVERY_ATTEMPTS', 2, 0, 5);
const LOG_CAPTURE_CONTENT = booleanFlag('LOG_CAPTURE_CONTENT', false);
const LOG_MAX_FILE_BYTES = boundedInteger('LOG_MAX_FILE_BYTES', 10 * 1024 * 1024, 1024, 100 * 1024 * 1024);
const LOG_ROTATION_FILES = boundedInteger('LOG_ROTATION_FILES', 3, 0, 20);
const TOKEN_FILE = path.join(ROOT_DIR, '.byv-gateway-token');

function loadGatewayToken() {
  const envToken = (process.env.GATEWAY_API_KEY || '').trim();
  if (envToken) return { token: envToken, source: 'environment' };

  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return { token: saved, source: 'local token file' };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, generated + '\n', { flag: 'wx', mode: 0o600 });
    return { token: generated, source: 'generated local token file' };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!saved) throw new Error('The local gateway token file is empty.');
    return { token: saved, source: 'local token file' };
  }
}

const gatewayAuth = loadGatewayToken();

module.exports = {
  ROOT_DIR,
  PORT,
  HOST,
  PROVIDER_BASE_URL,
  PROVIDER_API_KEY,
  PROVIDER_MODEL,
  DSML_TOOL_CALL,
  NO_TOOL_EXPERIMENT_VARIANT,
  PROVIDER_NATIVE_REASONING_EFFORT,
  PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS,
  PROVIDER_TIMEOUT_MS,
  MAX_PROVIDER_RETRIES,
  STREAM_PING_INTERVAL_MS,
  PROVIDER_MAX_REQUESTS_PER_MINUTE,
  PROVIDER_MAX_CONCURRENT_REQUESTS,
  PROVIDER_MODEL_METADATA_TIMEOUT_MS,
  PROVIDER_CAPABILITIES_CACHE_MS,
  PROVIDER_CONTEXT_WINDOW_TOKENS,
  PROVIDER_MAX_INPUT_TOKENS,
  PROVIDER_MAX_OUTPUT_TOKENS,
  CONTEXT_WINDOW_SAFETY_TOKENS,
  MAX_BODY_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_PROMPT_CHARS,
  COMPACTION_MAX_INPUT_TOKENS,
  COMPACTION_MAX_OUTPUT_TOKENS,
  COMPACTION_MAX_SYSTEM_CHARS,
  MAX_PENDING_REQUESTS,
  MAX_RECOVERY_ATTEMPTS,
  LOG_CAPTURE_CONTENT,
  LOG_MAX_FILE_BYTES,
  LOG_ROTATION_FILES,
  TOKEN_FILE,
  GATEWAY_API_KEY: gatewayAuth.token,
  GATEWAY_API_KEY_SOURCE: gatewayAuth.source,
  uuid: (prefix) => (prefix || 'id') + '_' + crypto.randomBytes(12).toString('hex'),
  sha256: (value) => crypto.createHash('sha256').update(String(value)).digest('hex'),
  approxTokens: (value) => Math.max(1, Math.ceil(String(value || '').length / 4))
};
