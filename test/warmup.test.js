'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startWarmup, stopWarmup, warmOnce, SOURCES, REFRESH_MS } = require('../srv/checks/warmup');

/** cds.log's shape, narrowed to what warmup.js uses. */
function recordingLog() {
  const lines = { info: [], warn: [], debug: [] };
  return {
    lines,
    info: (message) => lines.info.push(message),
    warn: (message) => lines.warn.push(message),
    debug: (message) => lines.debug.push(message)
  };
}

test('one pass reads every source', async () => {
  const seen = [];
  const sources = [
    ['first', async () => { seen.push('first'); }],
    ['second', async () => { seen.push('second'); }]
  ];
  const result = await warmOnce(sources, recordingLog());
  assert.deepEqual(seen.sort(), ['first', 'second']);
  assert.equal(result.failed.length, 0);
});

// The whole point of allSettled over all: an unreachable value-help service must still leave the
// two local caches warm, or one outage puts the cold press back on every requester.
test('a failing source does not stop the others, and is named', async () => {
  const warmed = [];
  const log = recordingLog();
  const sources = [
    ['rules', async () => { warmed.push('rules'); }],
    ['CVI customizing', async () => { throw new Error('destination unreachable'); }],
    ['SPRO derivation customizing', async () => { warmed.push('spro'); }]
  ];
  const result = await warmOnce(sources, log);
  assert.deepEqual(warmed.sort(), ['rules', 'spro']);
  assert.deepEqual(result.failed, ['CVI customizing']);
  // Named, not counted - "1 of 3 failed" tells nobody which lookup will be slow next.
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /CVI customizing/u);
  assert.equal(log.lines.info.length, 0);
});

test('a clean pass says so once, and warns about nothing', async () => {
  const log = recordingLog();
  await warmOnce([['rules', async () => {}]], log);
  assert.equal(log.lines.warn.length, 0);
  assert.equal(log.lines.info.length, 1);
});

// Both services in this process could reasonably ask; a second timer would double every remote read.
test('startWarmup is idempotent and stoppable', async () => {
  const log = recordingLog();
  let passes = 0;
  const sources = [['rules', async () => { passes += 1; }]];
  try {
    const first = startWarmup({ sources, log, refreshMs: 60000 });
    const second = startWarmup({ sources, log, refreshMs: 60000 });
    assert.equal(first, second, 'the second call returns the running timer rather than a new one');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(passes, 1, 'primed once, not once per caller');
  } finally {
    stopWarmup();
  }
  // Stopped means stopped: a later start is a fresh timer, not a no-op on a cleared one.
  const third = startWarmup({ sources, log, refreshMs: 60000 });
  assert.ok(third);
  stopWarmup();
});

// A refresh landing after the cache has already expired leaves exactly the cold press this file
// exists to remove, so the interval has to sit strictly inside the shortest TTL of the four.
test('the refresh interval is strictly inside every cache TTL', () => {
  const ttls = [
    require('../srv/checks/rule-store').TTL_MS,
    require('../srv/checks/field-property-store').TTL_MS,
    require('../srv/checks/cvi-checks').TTL_MS,
    require('../srv/checks/derivation-checks').TTL_MS
  ];
  for (const ttl of ttls) assert.ok(REFRESH_MS < ttl, `refresh ${REFRESH_MS} must beat TTL ${ttl}`);
});

test('the shipped source list covers all four caches', () => {
  assert.equal(SOURCES.length, 4);
  for (const [name, load] of SOURCES) {
    assert.equal(typeof name, 'string');
    assert.equal(typeof load, 'function');
  }
});
