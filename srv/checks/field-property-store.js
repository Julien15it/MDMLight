'use strict';

const cds = require('@sap/cds');
const { resolveProfiles, createFieldPropertyStages } = require('./field-properties');

/**
 * Holds the field property profiles in memory, the same shape as `rule-store.js`: a 60s TTL, marked
 * stale on any write, and one in-flight read shared by everything that asks meanwhile.
 *
 * The failure mode is deliberately the opposite of the rule store's. An unreadable rule table
 * reports itself, because a validation nobody ran must not read as "nothing to report". An
 * unreadable **profile** table resolves to nothing instead: these properties say what a screen may
 * show and what it insists on, so a read failure that blocked every submit - or hid every field -
 * would take the whole maintenance screen down over a control that is not a verdict on the data.
 */

const PROFILES = 'mdmlight.config.FieldPropertyProfiles';
const SETTINGS = 'mdmlight.config.FieldPropertySettings';

// 15 minutes, for the reason in rule-store.js: write-invalidated through `markStale`, so the
// Modify dialog's Apply is still visible immediately and only an unchanged table is held.
const TTL_MS = 900000;

const EMPTY = Object.freeze({ profiles: [], settings: [] });

let rows = null;
let loadedAt = 0;
let stale = true;
let inFlight = null;
let lastError = null;

const due = () => stale || !rows || (Date.now() - loadedAt) >= TTL_MS;

async function read() {
  const [profiles, settings] = await Promise.all([
    cds.run(cds.ql.SELECT.from(PROFILES)),
    cds.run(cds.ql.SELECT.from(SETTINGS))
  ]);
  return {
    profiles: Array.isArray(profiles) ? profiles : [],
    settings: Array.isArray(settings) ? settings : []
  };
}

/** Dropped on every write, the same way a rule write drops the rule store. */
function markStale() {
  stale = true;
}

function reset() {
  rows = null;
  loadedAt = 0;
  stale = true;
  inFlight = null;
  lastError = null;
}

async function load(readRows) {
  try {
    rows = await readRows();
    loadedAt = Date.now();
    stale = false;
    lastError = null;
  } catch (error) {
    // Keep whatever was already loaded: an unreachable table must not empty a control that was
    // working a minute ago.
    lastError = error;
    console.warn('[field-properties] Profile configuration unavailable:', error.message);
  }
  return rows;
}

async function storedProfiles({ readRows = read, force = false } = {}) {
  if (!force && !due()) return rows;
  if (!inFlight) {
    inFlight = load(readRows).finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** The merged answer for one request context, `{ entities, fields, profiles }`. */
async function resolvedProperties(context, options = {}) {
  const loaded = (await storedProfiles(options)) || EMPTY;
  return resolveProfiles(loaded.profiles, loaded.settings, context);
}

/** The submit-time stages for one context. Empty when no profile matches, which is the usual case. */
async function fieldPropertyStages(context, options = {}) {
  const resolved = await resolvedProperties(context, options);
  return createFieldPropertyStages(resolved, options.model);
}

module.exports = {
  PROFILES,
  SETTINGS,
  TTL_MS,
  markStale,
  reset,
  storedProfiles,
  resolvedProperties,
  fieldPropertyStages,
  lastError: () => lastError
};
