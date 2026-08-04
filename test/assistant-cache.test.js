'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCache, DEFAULT_TTL_MS } = require('../srv/ai/cache');

test('serves a cached read until it expires', async () => {
  let clock = 1000;
  let loads = 0;
  const cache = createCache({ now: () => clock, ttlMs: 60000 });
  const load = async () => { loads += 1; return ['row']; };

  assert.deepEqual(await cache.get('partners:all', load), ['row']);
  assert.deepEqual(await cache.get('partners:all', load), ['row']);
  assert.equal(loads, 1);

  clock += 60001;
  assert.deepEqual(await cache.get('partners:all', load), ['row']);
  assert.equal(loads, 2);
});

test('keys reads separately so a filtered question cannot serve an unfiltered one', async () => {
  const cache = createCache();
  await cache.get('partners:null', async () => 'all');
  await cache.get('partners:{"BusinessPartner":"1"}', async () => 'one');

  assert.equal(await cache.get('partners:null', async () => 'unused'), 'all');
  assert.equal(await cache.get('partners:{"BusinessPartner":"1"}', async () => 'unused'), 'one');
  assert.equal(cache.size(), 2);
});

test('concurrent questions share a single in-flight read', async () => {
  let loads = 0;
  const cache = createCache();
  const load = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return loads;
  };

  const [first, second] = await Promise.all([
    cache.get('partners:all', load),
    cache.get('partners:all', load)
  ]);

  assert.equal(loads, 1);
  assert.equal(first, second);
});

test('a write clears the cache so the next question re-reads S/4', async () => {
  let loads = 0;
  const cache = createCache();
  const load = async () => { loads += 1; return loads; };

  assert.equal(await cache.get('partners:all', load), 1);
  cache.clear();
  assert.equal(await cache.get('partners:all', load), 2);
  assert.equal(cache.size(), 1);
});

test('a failed read is not cached and does not poison the next question', async () => {
  let attempts = 0;
  const cache = createCache();
  const load = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('S/4 unavailable');
    return 'recovered';
  };

  await assert.rejects(() => cache.get('partners:all', load), /S\/4 unavailable/);
  assert.equal(cache.size(), 0);
  assert.equal(await cache.get('partners:all', load), 'recovered');
});

test('evicts the oldest entry once the cap is reached', async () => {
  const cache = createCache({ maxEntries: 2 });
  await cache.get('a', async () => 'a');
  await cache.get('b', async () => 'b');
  await cache.get('c', async () => 'c');

  assert.equal(cache.size(), 2);
  assert.equal(await cache.get('c', async () => 'reloaded'), 'c');
  assert.equal(await cache.get('a', async () => 'reloaded'), 'reloaded');
});

test('defaults to a one minute time to live', () => {
  assert.equal(DEFAULT_TTL_MS, 60000);
});
