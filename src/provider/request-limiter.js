'use strict';

function positiveIntegerOrZero(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function createProviderRequestLimiter(options = {}) {
  const requestsPerMinute = positiveIntegerOrZero(options.requestsPerMinute);
  const maxConcurrent = positiveIntegerOrZero(options.maxConcurrent);
  const windowMs = Number.isSafeInteger(options.windowMs) && options.windowMs > 0
    ? options.windowMs : 60_000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const cancelTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;

  const requestTimes = [];
  const waiters = new Set();
  let active = 0;

  function prune(currentTime) {
    const cutoff = currentTime - windowMs;
    while (requestTimes.length && requestTimes[0] <= cutoff) requestTimes.shift();
  }

  function wakeWaiters() {
    for (const wake of [...waiters]) wake();
  }

  function waitForCapacity(waitMs, signal) {
    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;

      const cleanup = () => {
        waiters.delete(onWake);
        if (timer !== null) cancelTimer(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onWake = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal.reason || new Error('Provider request wait was aborted.'));
      };

      waiters.add(onWake);
      if (waitMs !== null) timer = schedule(onWake, waitMs);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
  }

  async function acquire(signal) {
    while (true) {
      if (signal && signal.aborted) {
        throw signal.reason || new Error('Provider request wait was aborted.');
      }

      const currentTime = now();
      prune(currentTime);

      const concurrencyAvailable = maxConcurrent === 0 || active < maxConcurrent;
      const rateAvailable = requestsPerMinute === 0 || requestTimes.length < requestsPerMinute;
      if (concurrencyAvailable && rateAvailable) {
        active++;
        if (requestsPerMinute > 0) requestTimes.push(currentTime);

        let released = false;
        return function release() {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
          wakeWaiters();
        };
      }

      const waitMs = requestsPerMinute > 0 && requestTimes.length >= requestsPerMinute
        ? Math.max(1, requestTimes[0] + windowMs - currentTime)
        : null;
      await waitForCapacity(waitMs, signal);
    }
  }

  function getState() {
    prune(now());
    return {
      requestsInWindow: requestTimes.length,
      active,
      queued: waiters.size,
      requestsPerMinute,
      maxConcurrent
    };
  }

  return { acquire, getState };
}

module.exports = { createProviderRequestLimiter };
