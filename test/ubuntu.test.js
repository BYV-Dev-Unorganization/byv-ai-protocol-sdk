'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probeServer } = require('../scripts/ubuntu');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run('http://127.0.0.1:' + address.port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Ubuntu launcher readiness checks both dashboard and unauthenticated gateway probe', async () => {
  await withServer((req, res) => {
    if (req.url === '/dashboard' && req.method === 'GET') {
      res.writeHead(200);
      return res.end('<html>dashboard</html>');
    }
    if (req.url === '/api/hello' && req.method === 'HEAD') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(401);
    res.end();
  }, async (baseUrl) => {
    const result = await probeServer(baseUrl);
    assert.equal(result.dashboard_status, 200);
    assert.equal(result.gateway_probe_status, 204);
    assert.equal(result.ready, true);
  });
});

test('Ubuntu launcher does not mistake an authenticated API 401 for a ready dashboard', async () => {
  await withServer((req, res) => {
    if (req.url === '/api/hello' && req.method === 'HEAD') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(401);
    res.end();
  }, async (baseUrl) => {
    const result = await probeServer(baseUrl);
    assert.equal(result.gateway_probe_status, 204);
    assert.equal(result.dashboard_status, 401);
    assert.equal(result.ready, false);
  });
});
