'use strict';

const { callApi, emailsForRoleCollections } = require('./btp-agents');

/**
 * E-mail addresses of every BTP subaccount user holding this app's own `DataSteward` role
 * (`xs-security.json`'s role template of that name), for the `datastewards` hint sent alongside
 * `criticalField` in the workflow context - see CLAUDE.md "Critical fields, entity-level only, and
 * who to notify". Distinct from `btp-agents.js`'s `MDMLIGHT`-prefixed role collections, which back the
 * separate Workflow Agent Determination approver picker: those are told apart by a naming convention a
 * subaccount admin follows, but `DataSteward` is one specific role template this app itself declares,
 * and a role collection carrying it can be named anything - so membership has to be resolved by role
 * template, not by a collection's name or description.
 *
 * Two calls, both verified against the real subaccount (2026-08-26, after `datastewards` came back
 * empty in the deployed app):
 *
 * - `GET /sap/rest/authorization/v2/rolecollections` already returns each collection's roles inline as
 *   `roleReferences` - there is no need for a second, per-collection detail call. The first version made
 *   one anyway and read its result as `detail.roles`, a key that does not exist on the response
 *   (`roleReferences` does), so `carriesTemplate` was always false and no collection ever matched.
 * - `GET /Users` already returns each user's role collection membership inline as `groups`
 *   (`[{ value, display, type }]`, `value`/`display` both the collection name). The first version instead
 *   called `GET /sap/rest/authorization/v2/users/{name}/rolecollections` per user, which is real but
 *   answered `{ roleCollections: [], roleCollectionsBySamlAssignment: [] }` for a confirmed member -
 *   wrong for this purpose. `groups` on `/Users` is the reliable source, and reading it costs nothing
 *   extra since `/Users` is already fetched.
 *
 * Same client, same failure discipline as `btp-agents.js`: best-effort, never throws, cached for
 * TTL_MS. A wrong path or field name here fails like every other read in this module: silently, to an
 * empty list - never a broken submit.
 */

const ROLE_TEMPLATE = 'DataSteward';

const TTL_MS = 5 * 60 * 1000;

let cachedEmails = null;
let loadedAt = 0;
let inFlight = null;

/** Names of role collections carrying this app's `DataSteward` role template. */
async function fetchDataStewardCollections() {
  const data = await callApi('/sap/rest/authorization/v2/rolecollections');
  const collections = Array.isArray(data) ? data : (data.roleCollections || data.value || []);
  return collections
    .filter((collection) => (collection.roleReferences || []).some((role) => (
      role.roleTemplateName === ROLE_TEMPLATE
    )))
    .map((collection) => collection.name)
    .filter(Boolean);
}

/** E-mail of every subaccount user whose own `groups` name one of the given role collections - now
 *  shared with btp-agents.js's `emailsForRoleCollections` (2026-08-27), which resolves a
 *  `WorkflowRules.approvers` role entry the same way. Kept as a thin wrapper so this module's own
 *  `load()`/tests read unchanged. */
async function fetchStewardEmails(collectionNames) {
  return emailsForRoleCollections(collectionNames);
}

async function load() {
  try {
    const collections = await fetchDataStewardCollections();
    return await fetchStewardEmails(collections);
  } catch (error) {
    console.warn('[data-stewards] Could not resolve data steward e-mails:', error.message);
    return [];
  }
}

/**
 * `string[]`, cached for TTL_MS. Never throws: an unreachable subaccount API, or a missing service
 * binding entirely, resolves to no data stewards rather than costing a submit - the same discipline
 * `workflowAgents` follows.
 */
async function dataStewardEmails({ force = false } = {}) {
  if (!force && cachedEmails && (Date.now() - loadedAt) < TTL_MS) {
    return cachedEmails;
  }
  if (!inFlight) {
    inFlight = load()
      .then((emails) => {
        cachedEmails = emails;
        loadedAt = Date.now();
        return emails;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

function reset() {
  cachedEmails = null;
  loadedAt = 0;
  inFlight = null;
}

module.exports = {
  ROLE_TEMPLATE,
  TTL_MS,
  dataStewardEmails,
  reset,
  // Exported for tests only, same convention as btp-agents.js's _internals.
  _internals: { fetchDataStewardCollections, fetchStewardEmails }
};
