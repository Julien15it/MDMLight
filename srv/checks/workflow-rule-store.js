'use strict';

const cds = require('@sap/cds');
const { resolveApprovers } = require('./workflow-rules');

/**
 * Holds the workflow rules in memory, 60s TTL, dropped on any write - the same lifecycle as
 * rule-store.js and field-property-store.js.
 *
 * Its failure mode is the field property store's, not the rule store's: an unreadable table
 * resolves to NO approvers rather than to something that says so. A submit that failed because the
 * approver table could not be read would stop every request in the installation over a routing
 * hint, and an empty list is a state SBPA has to handle anyway - it is what an installation with no
 * rules configured sends, and what it sent before this table existed.
 */

const WORKFLOW_RULES = 'mdmlight.config.WorkflowRules';

const TTL_MS = 60000;

let rows = null;
let loadedAt = 0;
let stale = true;
let inFlight = null;

const due = () => stale || !rows || (Date.now() - loadedAt) >= TTL_MS;

const read = async () => {
  const stored = await cds.run(cds.ql.SELECT.from(WORKFLOW_RULES));
  return Array.isArray(stored) ? stored : [];
};

/** Dropped on every write, the same way a rule write drops the rule store. */
function markStale() {
  stale = true;
}

function reset() {
  rows = null;
  loadedAt = 0;
  stale = true;
  inFlight = null;
}

async function load(readRows) {
  try {
    rows = await readRows();
    loadedAt = Date.now();
    stale = false;
  } catch (error) {
    // Keep whatever was already loaded: an unreachable table must not empty a routing list that
    // was working a minute ago.
    console.warn('[workflow-rules] Workflow rule configuration unavailable:', error.message);
  }
  return rows;
}

async function workflowRules({ readRows = read, force = false } = {}) {
  if (!force && !due()) return rows;
  if (!inFlight) {
    inFlight = load(readRows).finally(() => { inFlight = null; });
  }
  return inFlight;
}

/**
 * The `approvers` list for one request. Never throws and never absent: an empty array means no rule
 * matched, which SBPA reads as "route it the way you always did".
 */
async function approversFor({ requestType, payload, model, ...options } = {}) {
  const loaded = await workflowRules(options);
  if (!loaded || !loaded.length) return [];
  try {
    return resolveApprovers({ rules: loaded, requestType, payload, model });
  } catch (error) {
    console.error('[workflow-rules] Could not resolve the approvers:', error);
    return [];
  }
}

module.exports = {
  WORKFLOW_RULES,
  TTL_MS,
  markStale,
  reset,
  workflowRules,
  approversFor
};
