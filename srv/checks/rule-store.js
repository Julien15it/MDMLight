'use strict';

const cds = require('@sap/cds');
const { createConfiguredStages } = require('./rule-engine');

/**
 * Holds the configured validation and derivation rows in memory and turns them
 * into pipeline stages.
 *
 * Same shape of problem as `createRuleStore` in srv/ai/rule-config.js, and one
 * deliberate difference: **there is no fallback ruleset.** An empty duplicate
 * table falls back to built-in defaults, because an empty one would switch the
 * duplicate check off. There are no default validations to fall back to, and
 * inventing a rule nobody configured would be worse than running none.
 *
 * What an unreadable table must not do is pass as "nothing to report". A read
 * failure with nothing cached therefore produces a stage that says so - the same
 * discipline `pipeline.js` applies to a duplicate check that could not run.
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

/**
 * The stages for one request. `model` is passed through to the field catalog so
 * the caller can inject a CSN in a test.
 */
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
