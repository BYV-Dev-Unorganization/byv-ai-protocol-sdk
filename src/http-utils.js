'use strict';

const crypto = require('node:crypto');
const { GATEWAY_API_KEY, MAX_BODY_BYTES } = require('./config');

function jsonError(res, status, type, message, code) {
  if (res.destroyed || res.writableEnded) return;
  const error = { type, message };
  if (code) error.code = code;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(Object.assign(new Error('Request body exceeds the configured size limit.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error('Invalid JSON request body: ' + error.message), { statusCode: 400 }));
      }
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

function safeEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function checkAuth(req) {
  const apiKey = req.headers['x-api-key'];
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return safeEqual(apiKey, GATEWAY_API_KEY) || safeEqual(bearer, GATEWAY_API_KEY);
}

function isAllowedHost(hostHeader, localPort) {
  if (typeof hostHeader !== 'string') return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(hostHeader.trim());
  if (!match) return false;
  if (!match[2]) return true;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 && port === Number(localPort);
}

function isAllowedOrigin(origin, localPort) {
  if (origin === undefined || origin === '') return true;
  if (typeof origin !== 'string' || origin === 'null') return false;
  const configured = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  if (configured.includes(origin)) return true;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'http:') return false;
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())) return false;
  return Number(url.port || 80) === Number(localPort);
}

module.exports = { jsonError, readBody, safeEqual, checkAuth, isAllowedHost, isAllowedOrigin };