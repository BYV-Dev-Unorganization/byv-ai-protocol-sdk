'use strict';

function createRateLimiter(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 30;
  const windowMs = Number.isInteger(options.windowMs) && options.windowMs > 0 ? options.windowMs : 60_000;
  const maxClients = Number.isInteger(options.maxClients) && options.maxClients > 0 ? options.maxClients : 10_000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const clients = new Map();

  function consume(clientKey) {
    const key = String(clientKey || 'unknown');
    const currentTime = now();
    const cutoff = currentTime - windowMs;
    const previous = clients.get(key) || [];
    const timestamps = previous.filter((timestamp) => timestamp > cutoff);

    // Keep memory bounded if requests arrive from many distinct client addresses.
    clients.delete(key);
    if (!previous.length && clients.size >= maxClients) {
      const oldestKey = clients.keys().next().value;
      if (oldestKey !== undefined) clients.delete(oldestKey);
    }

    const allowed = timestamps.length < limit;
    if (allowed) timestamps.push(currentTime);
    clients.set(key, timestamps);

    const resetAt = timestamps.length > 0
      ? timestamps[0] + windowMs
      : currentTime + windowMs;

    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - timestamps.length),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - currentTime) / 1000))
    };
  }

  return { consume };
}

function clientAddress(req) {
  const address = req && req.socket && req.socket.remoteAddress;
  if (typeof address !== 'string' || !address) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function setRateLimitHeaders(res, result) {
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
  }
}

module.exports = { createRateLimiter, clientAddress, setRateLimitHeaders };
