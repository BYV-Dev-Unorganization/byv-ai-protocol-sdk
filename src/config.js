'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = boundedInteger('PORT', 8787, 1, 65535);
const HOST = process.env.HOST || '127.0.0.1';
const PROVIDER_BASE_URL = (process.env.PROVIDER_BASE_URL || '').trim();
const PROVIDER_API_KEY = (process.env.PROVIDER_API_KEY || '').trim();
const PROVIDER_MODEL = (process.env.PROVIDER_MODEL || '').trim();
const PROVIDER_TIMEOUT_MS = boundedInteger('PROVIDER_TIMEOUT_MS', 300000, 1000, 3600000);
const MAX_BODY_BYTES = boundedInteger('MAX_BODY_BYTES', 10 * 1024 * 1024, 1024, 100 * 1024 * 1024);
const MAX_OUTPUT_CHARS = boundedInteger('MAX_OUTPUT_CHARS', 2 * 1024 * 1024, 1024, 20 * 1024 * 1024);
const MAX_PROMPT_CHARS = boundedInteger('MAX_PROMPT_CHARS', 120000, 8192, 1000000);
const MAX_PENDING_REQUESTS = boundedInteger('MAX_PENDING_REQUESTS', 8, 1, 128);
const MAX_RECOVERY_ATTEMPTS = boundedInteger('MAX_RECOVERY_ATTEMPTS', 2, 0, 5);
const REQUEST_TIMEOUT_MS = boundedInteger('REQUEST_TIMEOUT_MS', 300000, 1000, 3600000);
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
  PROVIDER_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_PROMPT_CHARS,
  MAX_PENDING_REQUESTS,
  MAX_RECOVERY_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  TOKEN_FILE,
  GATEWAY_API_KEY: gatewayAuth.token,
  GATEWAY_API_KEY_SOURCE: gatewayAuth.source,
  uuid: (prefix) => (prefix || 'id') + '_' + crypto.randomBytes(12).toString('hex'),
  sha256: (value) => crypto.createHash('sha256').update(String(value)).digest('hex'),
  approxTokens: (value) => Math.max(1, Math.ceil(String(value || '').length / 4))
};