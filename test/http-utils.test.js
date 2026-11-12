'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  readBody,
  safeEqual,
  checkAuth,
  isAllowedHost,
  isAllowedOrigin
} = require('../src/http-utils');
const { GATEWAY_API_KEY, MAX_BODY_BYTES } = require('../src/config');

function fakeRequest(chunks) {
  const request = new EventEmitter();
  request.destroyedByTest = false;
  request.destroy = () => { request.destroyedByTest = true; };
  process.nextTick(() => {
    for (const chunk of chunks) request.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    request.emit('end');
  });
  return request;
}

test('compares gateway tokens safely and accepts both documented auth headers', () => {
  assert.equal(safeEqual('same-token', 'same-token'), true);
  assert.equal(safeEqual('same-token', 'different-token'), false);
  assert.equal(safeEqual(undefined, 'same-token'), false);
  assert.equal(checkAuth({ headers: { authorization: 'Bearer ' + GATEWAY_API_KEY } }), true);
  assert.equal(checkAuth({ headers: { 'x-api-key': GATEWAY_API_KEY } }), true);
  assert.equal(checkAuth({ headers: { authorization: 'Bearer wrong' } }), false);
});

test('validates loopback Host headers and same-port or explicitly allowed Origins', () => {
  assert.equal(isAllowedHost('localhost:8787', 8787), true);
  assert.equal(isAllowedHost('127.0.0.1:8787', 8787), true);
  assert.equal(isAllowedHost('[::1]:8787', 8787), true);
  assert.equal(isAllowedHost('attacker.example:8787', 8787), false);
  assert.equal(isAllowedHost('localhost:9999', 8787), false);

  assert.equal(isAllowedOrigin(undefined, 8787), true);
  assert.equal(isAllowedOrigin('http://localhost:8787', 8787), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8787', 8787), true);
  assert.equal(isAllowedOrigin('https://attacker.example', 8787), false);
  assert.equal(isAllowedOrigin('null', 8787), false);
});

test('supports an exact CORS allowlist without allowing unrelated origins', () => {
  const previous = process.env.CORS_ALLOWED_ORIGINS;
  process.env.CORS_ALLOWED_ORIGINS = 'https://trusted.example, http://localhost:3000';
  try {
    assert.equal(isAllowedOrigin('https://trusted.example', 8787), true);
    assert.equal(isAllowedOrigin('http://localhost:3000', 8787), true);
    assert.equal(isAllowedOrigin('https://other.example', 8787), false);
  } finally {
    if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previous;
  }
});

test('reads JSON request bodies, including empty bodies and a UTF-8 BOM', async () => {
  assert.deepEqual(await readBody(fakeRequest(['{"ok":true}'])), { ok: true });
  assert.deepEqual(await readBody(fakeRequest([''])), {});
  assert.deepEqual(await readBody(fakeRequest(['\uFEFF{"message":"hello"}'])), { message: 'hello' });
});

test('rejects malformed JSON with HTTP 400 metadata', async () => {
  await assert.rejects(
    readBody(fakeRequest(['{"broken":'])),
    (error) => error.statusCode === 400 && /Invalid JSON request body/.test(error.message)
  );
});

test('rejects request bodies above MAX_BODY_BYTES with HTTP 413 metadata', async () => {
  const request = fakeRequest([Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)]);
  await assert.rejects(
    readBody(request),
    (error) => error.statusCode === 413 && /size limit/.test(error.message)
  );
  assert.equal(request.destroyedByTest, true);
});


test('allows only exact reverse-proxy Host values configured by the operator', () => {
  const previous = process.env.GATEWAY_ALLOWED_HOSTS;
  process.env.GATEWAY_ALLOWED_HOSTS = 'office-gateway.example.com, internal.example.com:8443';
  try {
    assert.equal(isAllowedHost('office-gateway.example.com', 8787), true);
    assert.equal(isAllowedHost('OFFICE-GATEWAY.EXAMPLE.COM', 8787), true);
    assert.equal(isAllowedHost('internal.example.com:8443', 8787), true);
    assert.equal(isAllowedHost('attacker.example.com', 8787), false);
    assert.equal(isAllowedHost('office-gateway.example.com:443', 8787), false);
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_ALLOWED_HOSTS;
    else process.env.GATEWAY_ALLOWED_HOSTS = previous;
  }
});


test('allows only HTTPS Cloudflare Quick Tunnel origins', () => {
  assert.equal(isAllowedOrigin('https://demo-123.trycloudflare.com', 8787), true);
  assert.equal(isAllowedOrigin('http://demo-123.trycloudflare.com', 8787), false);
  assert.equal(isAllowedOrigin('https://trycloudflare.com', 8787), false);
  assert.equal(isAllowedOrigin('https://demo.trycloudflare.com.attacker.example', 8787), false);
  assert.equal(isAllowedOrigin('https://demo.trycloudflare.com:8443', 8787), false);
});
