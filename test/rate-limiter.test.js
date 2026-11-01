'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, clientAddress, setRateLimitHeaders } = require('../src/rate-limiter');

test('enforces a rolling time window and reports the next available slot', () => {
  let currentTime = 1_000;
  const limiter = createRateLimiter({
    limit: 2,
    windowMs: 1_000,
    now: () => currentTime
  });

  const first = limiter.consume('192.0.2.1');
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  assert.equal(first.resetAt, 2_000);

  currentTime = 1_500;
  const second = limiter.consume('192.0.2.1');
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);

  currentTime = 1_750;
  const blocked = limiter.consume('192.0.2.1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.resetAt, 2_000);
  assert.equal(blocked.retryAfterSeconds, 1);

  currentTime = 2_001;
  const afterExpiry = limiter.consume('192.0.2.1');
  assert.equal(afterExpiry.allowed, true);
  assert.equal(afterExpiry.remaining, 0);
});

test('tracks each client address independently', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 10_000 });
  assert.equal(limiter.consume('192.0.2.1').allowed, true);
  assert.equal(limiter.consume('192.0.2.1').allowed, false);
  assert.equal(limiter.consume('192.0.2.2').allowed, true);
});

test('normalizes IPv4-mapped IPv6 socket addresses and does not trust forwarded headers', () => {
  assert.equal(clientAddress({ socket: { remoteAddress: '::ffff:192.0.2.5' }, headers: { 'x-forwarded-for': '198.51.100.8' } }), '192.0.2.5');
  assert.equal(clientAddress({ socket: { remoteAddress: '2001:db8::1' } }), '2001:db8::1');
  assert.equal(clientAddress({ socket: {} }), 'unknown');
});

test('sets rate limit headers and Retry-After when blocked', () => {
  const headers = {};
  const response = { setHeader: (name, value) => { headers[name] = value; } };
  setRateLimitHeaders(response, {
    allowed: false,
    limit: 30,
    remaining: 0,
    resetAt: 61_000,
    retryAfterSeconds: 7
  });

  assert.equal(headers['X-RateLimit-Limit'], '30');
  assert.equal(headers['X-RateLimit-Remaining'], '0');
  assert.equal(headers['X-RateLimit-Reset'], '61');
  assert.equal(headers['Retry-After'], '7');
});
