'use strict';

const cds = require('@sap/cds');
const ruleStore = require('./rule-store');
const fieldProperties = require('./field-property-store');
const cvi = require('./cvi-checks');
const derivations = require('./derivation-checks');

/**
 * Fills the four customizing caches before anyone presses a button, and keeps them filled.
 *
 * Measured 2026-09-03 on the dev landscape: the FIRST `checkRequest` after any pause took **9.96
 * seconds**, the same press warm took **0.67**. Roughly 4.5s of that gap was this - the destination
 * handshake plus the paged customizing reads behind `cvi-checks` and `derivation-checks` - and the
 * rest was the first AI Core call. A 60s TTL meant a requester who stopped to think re-paid it, so
 * the cost landed on a person rather than on boot.
 *
 * Two halves, and the second is the one that matters: priming at startup only moves the first
 * press, while the refresh keeps every later one warm. The interval sits just inside the TTL so a
 * cache is replaced before it can expire, never after - a refresh that lands late leaves exactly
 * the cold press this exists to remove.
 *
 * Best-effort throughout, per the standing rule: this is a remote read that is not a verdict on
 * anybody's data. It never throws, never delays boot (nothing awaits it) and never blocks a
 * request. A failed pass leaves whatever was already cached in place and the next real request
 * loads it the way it always did - so the worst this file can do is nothing.
 *
 * NOT a substitute for the caches' own invalidation. `rule-store` and `field-property-store` still
 * drop on write, so a steward's change is visible on the next press whatever this timer is doing.
 * **One instance is assumed.** Scale `mdm-businesspartner-srv` past one and each instance warms and
 * invalidates only its own copy, so a rule change would be live on the instance that took the write
 * and up to 15 minutes stale on the others - at which point the TTLs want lowering again, or the
 * stores want a shared cache.
 */

/** Just inside the shortest TTL of the four, so a refresh always beats the expiry. */
const REFRESH_MS = 12 * 60 * 1000;

const SOURCES = Object.freeze([
  // Local Postgres, cheap. Included anyway: they sit on the same first press, and a cache filled
  // everywhere except one place still shows a requester a pause. `force`, because a pass inside the
  // TTL would otherwise return the cached value and refresh nothing - which is the whole job. Safe:
  // both load into a local and swap after, keeping what they had if the read fails.
  ['validation and derivation rules', () => ruleStore.configuredRules({ force: true })],
  ['field property profiles', () => fieldProperties.storedProfiles({ force: true })],
  // The two that cost seconds: paged reads over the remote value-help service.
  ['CVI customizing', () => cvi.prime()],
  ['SPRO derivation customizing', () => derivations.prime()]
]);

let timer = null;

/**
 * One pass over all four. Independent reads, so they go together; `allSettled` because one
 * unreachable source must not stop the other three being warm.
 */
async function warmOnce(sources = SOURCES, log = cds.log('warmup')) {
  const started = Date.now();
  const results = await Promise.allSettled(sources.map(([, load]) => load()));
  const ms = Date.now() - started;
  const failed = results
    .map((result, index) => (result.status === 'rejected' ? sources[index][0] : null))
    .filter(Boolean);
  if (failed.length) {
    // Named, not counted: "3 of 4" tells nobody which lookup will be slow for the next requester.
    log.warn(`warmed in ${ms}ms, could not read: ${failed.join(', ')}`);
  } else {
    log.info(`warmed ${sources.length} caches in ${ms}ms`);
  }
  return { failed, ms };
}

/**
 * Called once from service init, fire-and-forget. Idempotent: a second call is ignored rather than
 * starting a second timer, because both services in this process could reasonably ask.
 */
function startWarmup({ sources = SOURCES, log = cds.log('warmup'), refreshMs = REFRESH_MS } = {}) {
  if (timer) return timer;
  warmOnce(sources, log).catch((error) => log.debug('The warm-up did not run:', error.message));
  timer = setInterval(() => {
    warmOnce(sources, log).catch((error) => log.debug('A warm-up refresh did not run:', error.message));
  }, refreshMs);
  // Unref'd so this timer alone can never hold the process open - it must not keep a `node --test`
  // run alive, and it must not delay a CF shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopWarmup() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  REFRESH_MS,
  SOURCES,
  startWarmup,
  stopWarmup,
  warmOnce
};
