'use strict';

/**
 * Whether AI assistance is switched on for this installation.
 *
 * The switch is a row in mdmlight.config.FeatureSettings rather than an
 * environment variable so a steward can flip it without a redeploy, and so the
 * decision survives one. That means a database read on a path that used to be
 * pure config, which is why the value is cached: the assistant asks once per
 * question, the check pipeline once per submit, and neither should pay for a
 * round trip to learn something that changes a few times a year.
 *
 * Reads never throw. A missing table, an unreachable database or an empty
 * settings row all resolve to "on", because the alternative is worse in both
 * directions: an installation that has never opened the settings page would
 * silently lose its assistant, and a transient database error would look to the
 * user like the AI had been switched off.
 */

const cds = require('@sap/cds');

const ENTITY = 'mdmlight.config.FeatureSettings';

/** The single row's key. Exported so the service layer upserts the same one. */
const SINGLETON_ID = 'SINGLETON';

/** Long enough to keep it off the hot path, short enough that flipping the
 *  switch takes effect while the steward is still looking at the page. */
const CACHE_TTL_MS = 30_000;

let cached = null;

/** Dropped after a write so the next read sees it, rather than up to a TTL later. */
function forgetCachedSettings() {
  cached = null;
}

async function readSettings() {
  const db = await cds.connect.to('db');
  return db.run(cds.ql.SELECT.one.from(ENTITY).where({ ID: SINGLETON_ID }));
}

/**
 * @param {object} [options]
 * @param {number} [options.now] Millisecond clock, injectable so tests can age the cache.
 * @param {Function} [options.read] Settings reader, injectable so tests need no database.
 */
async function aiAssistanceEnabled({ now = Date.now(), read = readSettings } = {}) {
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.enabled;

  let enabled = true;
  try {
    const row = await read();
    // Only an explicit false turns it off. A missing row, or a row written before
    // this column existed, leaves assistance on.
    if (row && row.aiAssistanceEnabled === false) enabled = false;
  } catch (error) {
    console.warn(
      '[ai] Could not read the AI assistance setting, leaving assistance on:',
      error?.message || error
    );
    // Deliberately not cached: a failed read should be retried, not remembered
    // for the next half minute.
    return true;
  }

  cached = { enabled, at: now };
  return enabled;
}

module.exports = {
  ENTITY,
  SINGLETON_ID,
  CACHE_TTL_MS,
  aiAssistanceEnabled,
  forgetCachedSettings
};
