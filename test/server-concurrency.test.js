'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { GATEWAY_API_KEY, MAX_PENDING_REQUESTS } = require('../src/config');

async function withServer(t, handleMessages) {
  const server = createServer({ handleMessages });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('bounds concurrent Messages requests and releases capacity after completion', { timeout: 10000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered = 0;
  const base = await withServer(t, async () => {
    entered++;
    await gate;
    return {
      id: 'msg-concurrency',
      text: 'ok',
      content: [{ type: 'text', text: 'ok' }],
      toolCalls: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      usage_estimated: false
    };
  });

  const send = () => fetch(base + '/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + GATEWAY_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'byv-flash-v1',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }]
    })
  });

  const requests = Array.from({ length: MAX_PENDING_REQUESTS + 1 }, send);
  let signalOverload;
  const overloadFound = new Promise((resolve) => { signalOverload = resolve; });
  const observed = requests.map(async (request) => {
    const response = await request;
    const body = await response.text();
    const record = { status: response.status, body };
    if (response.status === 429) signalOverload(record);
    return record;
  });

  try {
    const overload = await overloadFound;
    const payload = JSON.parse(overload.body);
    assert.equal(overload.status, 429);
    assert.equal(payload.error.code, 'GATEWAY_BUSY');
    assert.equal(entered, MAX_PENDING_REQUESTS);
  } finally {
    release();
  }

  const records = await Promise.all(observed);
  assert.equal(records.filter((record) => record.status === 200).length, MAX_PENDING_REQUESTS);
  assert.equal(records.filter((record) => record.status === 429).length, 1);

  const afterRelease = await send();
  assert.equal(afterRelease.status, 200);
});
