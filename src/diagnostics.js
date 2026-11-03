'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT_DIR,
  LOG_CAPTURE_CONTENT,
  LOG_MAX_FILE_BYTES,
  LOG_ROTATION_FILES,
  PROVIDER_API_KEY,
  GATEWAY_API_KEY
} = require('./config');

const SECRET_FIELD = /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|credential|private[_-]?key)$/i;
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*["']?)[^\s"',;}]+/gi
];

function sanitizeString(value, secrets) {
  let result = value;
  for (const secret of secrets) {
    if (secret && result.includes(secret)) result = result.split(secret).join('[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix) =>
      typeof prefix === 'string' ? prefix + '[REDACTED]' : '[REDACTED]'
    );
  }
  return result;
}

function redact(value, secrets, fieldName = '') {
  if (SECRET_FIELD.test(fieldName)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizeString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = redact(child, secrets, key);
    }
    return output;
  }
  return value;
}

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function rotateFile(filePath, rotations) {
  if (rotations < 1) {
    removeIfExists(filePath);
    return;
  }
  for (let index = rotations; index >= 1; index--) {
    const source = index === 1 ? filePath : filePath + '.' + (index - 1);
    const target = filePath + '.' + index;
    if (!fs.existsSync(source)) continue;
    removeIfExists(target);
    fs.renameSync(source, target);
  }
}

function createDiagnostics(options = {}) {
  const directory = path.resolve(options.directory || path.join(ROOT_DIR, 'logs'));
  const captureContent = typeof options.captureContent === 'boolean'
    ? options.captureContent
    : LOG_CAPTURE_CONTENT;
  const maxFileBytes = Number.isSafeInteger(options.maxFileBytes) && options.maxFileBytes > 0
    ? options.maxFileBytes
    : LOG_MAX_FILE_BYTES;
  const rotations = Number.isSafeInteger(options.rotations) && options.rotations >= 0
    ? options.rotations
    : LOG_ROTATION_FILES;
  const secrets = [
    PROVIDER_API_KEY,
    GATEWAY_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY,
    ...(Array.isArray(options.secrets) ? options.secrets : [])
  ].filter((value) => typeof value === 'string' && value.length > 0);

  function write(category, entry) {
    const filePath = path.join(directory, category + '.jsonl');
    try {
      fs.mkdirSync(directory, { recursive: true });
      let line = JSON.stringify(entry) + '\n';
      let lineBytes = Buffer.byteLength(line, 'utf8');

      // A single request can be larger than the rotation threshold. Preserve a
      // compact event marker rather than allowing one oversized line to bypass it.
      if (lineBytes > maxFileBytes) {
        line = JSON.stringify({
          timestamp: entry.timestamp,
          event: entry.event,
          request_id: entry.request_id || null,
          level: entry.level || null,
          error_code: entry.error_code || null,
          record_omitted: true,
          original_bytes: lineBytes
        }) + '\n';
        lineBytes = Buffer.byteLength(line, 'utf8');
      }

      let currentSize = 0;
      try {
        currentSize = fs.statSync(filePath).size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (currentSize > 0 && currentSize + lineBytes > maxFileBytes) {
        rotateFile(filePath, rotations);
      }
      fs.appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Diagnostics are best-effort and must never change gateway behavior.
    }
  }

  function record(event, fields = {}) {
    if (typeof event !== 'string' || !event) return;
    const source = fields && typeof fields === 'object' ? { ...fields } : {};
    const content = source.content;
    delete source.content;

    const entry = redact({
      timestamp: new Date().toISOString(),
      event,
      ...source
    }, secrets);

    if (content !== undefined) {
      entry.content_captured = captureContent;
      if (captureContent) entry.content = redact(content, secrets);
    }

    write('timeline', entry);

    if (event === 'request.received' || event === 'provider.request.started') {
      write('requests', entry);
    }
    if (event === 'provider.response.completed' || event === 'gateway.response.completed') {
      write('responses', entry);
    }
    if (
      entry.level === 'error' ||
      /(?:\.failed|\.error|\.rejected)$/.test(event) ||
      entry.validation_status === 'rejected'
    ) {
      write('errors', entry);
    }
  }

  return { record, captureContent, directory };
}

module.exports = { createDiagnostics, redact, sanitizeString };
