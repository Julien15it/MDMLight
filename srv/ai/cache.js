'use strict';

const DEFAULT_TTL_MS = 60000;
const MAX_ENTRIES = 50;

// Per-instance read cache: entries expire after ttlMs and any write clears them.
function createCache({ now = Date.now, maxEntries = MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS } = {}) {
  const entries = new Map();

  function get(key, loader) {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) return hit.promise;

    // Cache the promise so concurrent questions share one S/4 read.
    const promise = Promise.resolve().then(loader);
    if (!entries.has(key) && entries.size >= maxEntries) {
      entries.delete(entries.keys().next().value);
    }
    entries.set(key, { promise, expiresAt: now() + ttlMs });
    // A failed read must not be served to the next caller.
    promise.catch(() => {
      const current = entries.get(key);
      if (current && current.promise === promise) entries.delete(key);
    });
    return promise;
  }

  return {
    get,
    clear: () => entries.clear(),
    size: () => entries.size
  };
}

module.exports = { DEFAULT_TTL_MS, MAX_ENTRIES, createCache };
