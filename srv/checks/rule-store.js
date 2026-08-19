'use strict';

const cds = require('@sap/cds');
const { createConfiguredStages } = require('./rule-engine');

/**
 * Holds the configured rows in memory and turns them into pipeline stages. Unlike the duplicate
 * store there is NO fallback ruleset - inventing a rule nobody configured beats nothing only for a
 * check an empty table would switch off. An unreadable table produces a stage that says so, rather
 * than passing as "nothing to report".
 */

const VALIDATION_RULES = 'mdmlight.config.ValidationRules';
const DERIVATION_RULES = 'mdmlight.config.DerivationRules';

const TTL_MS = 60000;

let rows = null;
let loadedAt = 0;
let stale = true;
let inFlight = null;
let lastError = null;

const due = () => stale || !rows || (Date.now() - loadedAt) >= TTL_MS;

async function read() {
  const [validations, derivations] = await Promise.all([
    cds.run(cds.ql.SELECT.from(VALIDATION_RULES)),
    cds.run(cds.ql.SELECT.from(DERIVATION_RULES))
  ]);
  return {
    validations: Array.isArray(validations) ? validations : [],
    derivations: Array.isArray(derivations) ? derivations : []
  };
}

/** Dropped on every write, the same way a partner write drops the name index. */
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
    // working a minute ago. `lastError` is only reported when there is nothing cached at all.
    lastError = error;
    console.warn('[quality-rules] Rule configuration unavailable:', error.message);
    if (!rows) rows = null;
  }
  return rows;
}

async function configuredRules({ readRows = read, force = false } = {}) {
  if (!force && !due()) return rows;
  if (!inFlight) {
    inFlight = load(readRows).finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** The stages for one request. `model` is passed to the catalog so a test can inject a CSN. */
async function configuredStages(options = {}) {
  const loaded = await configuredRules(options);
  if (!loaded) {
    const message = `The configured validation and derivation rules could not be read`
      + `${lastError ? ` (${lastError.message})` : ''}, so none of them ran.`;
    return {
      validations: [{ name: 'configured_validation', run: async () => [{ severity: 'info', message }] }],
      derivations: []
    };
  }
  return createConfiguredStages({ ...loaded, model: options.model });
}

module.exports = {
  VALIDATION_RULES,
  DERIVATION_RULES,
  TTL_MS,
  markStale,
  reset,
  configuredRules,
  configuredStages
};
