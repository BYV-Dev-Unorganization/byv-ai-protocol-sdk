'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderRequestLimiter } = require('../src/provider/request-limiter');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('serializes provider requests when the configured concurrency is one', async () => {
  const limiter = createProviderRequestLimiter({ maxConcurrent: 1 });
  const releaseFirst = await limiter.acquire();
  let secondAcquired = false;
  const second = limiter.acquire().then((release) => {
    secondAcquired = true;
    return release;
  });

  await Promise.resolve();
  assert.equal(secondAcquired, false);
  assert.equal(limiter.getState().active, 1);

  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  assert.equal(limiter.getState().active, 1);
  releaseSecond();
  releaseSecond();
  assert.equal(limiter.getState().active, 0);
});

test('waits for a rolling-minute request slot instead of exceeding the configured rate', async () => {
  const limiter = createProviderRequestLimiter({
    requestsPerMinute: 1,
    windowMs: 35
  });
  const releaseFirst = await limiter.acquire();
  releaseFirst();

  let acquired = false;
  const pending = limiter.acquire().then((release) => {
    acquired = true;
    return release;
  });

  await delay(10);
  assert.equal(acquired, false);
  const releaseSecond = await pending;
  assert.equal(acquired, true);
  assert.equal(limiter.getState().requestsInWindow, 1);
  releaseSecond();
});

test('cancels a queued provider request when the client disconnects', async () => {
  const limiter = createProviderRequestLimiter({ maxConcurrent: 1 });
  const releaseFirst = await limiter.acquire();
  const controller = new AbortController();
  const pending = limiter.acquire(controller.signal);

  controller.abort(new Error('client disconnected'));
  await assert.rejects(pending, /client disconnected/);
  assert.equal(limiter.getState().active, 1);
  releaseFirst();
  assert.equal(limiter.getState().active, 0);
});

test('does not limit requests when both provider quota settings are zero', async () => {
  const limiter = createProviderRequestLimiter({
    requestsPerMinute: 0,
    maxConcurrent: 0
  });
  const releases = await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
  assert.equal(limiter.getState().active, 5);
  for (const release of releases) release();
  assert.equal(limiter.getState().active, 0);
});
