'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { GATEWAY_API_KEY } = require('../src/config');

async function withServer(t, options) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

function authHeaders(extra = {}) {
  return {
    Authorization: 'Bearer ' + GATEWAY_API_KEY,
    'Content-Type': 'application/json',
    ...extra
  };
}

test('requires gateway authentication and exposes BYV Flash V1 in model discovery', async (t) => {
  const base = await withServer(t);
  const rejected = await fetch(base + '/v1/models');
  assert.equal(rejected.status, 401);

  const accepted = await fetch(base + '/v1/models', { headers: authHeaders() });
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(body.data.length, 6);
  assert.equal(body.data[0].id, 'byv-flash-v1');
  assert.equal(body.data[0].display_name, 'BYV Flash V1');
});

test('rejects unsupported model profile IDs before invoking the handler', async (t) => {
  let called = false;
  const base = await withServer(t, {
    handleMessages: async () => {
      called = true;
      throw new Error('handler should not run');
    }
  });
  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'nonexistent-profile',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Hello' }]
    })
  });
  assert.equal(response.status, 400);
  assert.equal(called, false);
  const result = await response.json();
  assert.equal(result.error.code, 'UNSUPPORTED_MODEL_PROFILE');
});

test('returns an Anthropic Messages envelope from the injected runtime', async (t) => {
  const base = await withServer(t, {
    handleMessages: async (body) => ({
      id: 'msg_test',
      text: 'BYV gateway is ready.',
      content: [{ type: 'text', text: 'BYV gateway is ready.' }],
      toolCalls: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 9, output_tokens: 6 },
      usage_estimated: false
    })
  });
  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Hello' }]
    })
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('x-gateway-request-id'));
  const result = await response.json();
  assert.equal(result.type, 'message');
  assert.equal(result.role, 'assistant');
  assert.equal(result.model, 'claude-sonnet-5-5');
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.content, [{ type: 'text', text: 'BYV gateway is ready.' }]);
  assert.deepEqual(result.usage, { input_tokens: 9, output_tokens: 6 });
});

test('count_tokens accepts the canonical BYV Flash V1 model ID without invoking model runtime', async (t) => {
  let called = false;
  const base = await withServer(t, {
    handleMessages: async () => {
      called = true;
      throw new Error('count_tokens must not invoke model runtime');
    }
  });
  const response = await fetch(base + '/v1/messages/count_tokens', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'byv-flash-v1',
      messages: [{ role: 'user', content: 'Count these tokens.' }]
    })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(Number.isInteger(result.input_tokens));
  assert.equal(response.headers.get('x-token-usage-estimated'), 'true');
  assert.equal(called, false);
});
