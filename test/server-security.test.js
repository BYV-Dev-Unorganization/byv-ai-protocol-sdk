'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server');
const { GATEWAY_API_KEY } = require('../src/config');

async function withServer(t) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function request(port, { method = 'GET', path = '/health', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        Host: '127.0.0.1:' + port,
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('rejects unexpected Host headers before exposing application routes', async (t) => {
  const port = await withServer(t);
  const response = await request(port, {
    headers: {
      Host: 'attacker.example:' + port,
      Authorization: 'Bearer ' + GATEWAY_API_KEY
    }
  });
  assert.equal(response.status, 421);
  assert.match(response.body, /Host header is not allowed/);
});

test('rejects untrusted browser Origins and accepts the same local origin', async (t) => {
  const port = await withServer(t);
  const denied = await request(port, {
    headers: {
      Origin: 'https://attacker.example',
      Authorization: 'Bearer ' + GATEWAY_API_KEY
    }
  });
  assert.equal(denied.status, 403);

  const allowedOrigin = 'http://localhost:' + port;
  const allowed = await request(port, {
    headers: {
      Origin: allowedOrigin,
      Authorization: 'Bearer ' + GATEWAY_API_KEY
    }
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], allowedOrigin);
  assert.equal(allowed.headers.vary, 'Origin');
});

test('handles only validated CORS preflight origins and never emits wildcard access', async (t) => {
  const port = await withServer(t);
  const origin = 'http://localhost:' + port;
  const accepted = await request(port, {
    method: 'OPTIONS',
    path: '/v1/messages',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST'
    }
  });
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers['access-control-allow-origin'], origin);
  assert.doesNotMatch(String(accepted.headers['access-control-allow-origin']), /\*/);

  const rejected = await request(port, {
    method: 'OPTIONS',
    path: '/v1/messages',
    headers: {
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'POST'
    }
  });
  assert.equal(rejected.status, 403);
});

test('keeps the documented unauthenticated Claude Code HEAD probe narrow', async (t) => {
  const port = await withServer(t);
  const probe = await request(port, { method: 'HEAD', path: '/api/hello' });
  assert.equal(probe.status, 204);
  assert.equal(probe.body, '');

  const health = await request(port, { method: 'GET', path: '/health' });
  assert.equal(health.status, 401);
});
