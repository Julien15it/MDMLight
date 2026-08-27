'use strict';

const axios = require('axios');

/**
 * The BTP subaccount's role collections and users, for the Workflow Agent Determination approver
 * picker - see CLAUDE.md "Workflow Agent Determination". Before this, the picker offered a hand-kept
 * list of three names (`Requester`/`Approver`/`DataSteward` - this app's own concept, still used by
 * the Field Property Profiles page) that had nothing to do with who could actually be assigned an
 * approval in the subaccount.
 *
 * Requires a dedicated `apiaccess`-plan XSUAA instance (`mdm-businesspartner-authmgmt`, see
 * mta.yaml). The app's own `application`-plan instance (`mdm-businesspartner-auth`) authenticates
 * users into this app and has no access to the Authorization Management REST API - a second XSUAA
 * instance is the documented way in, the same way `mdmlight-bpa-uaa` is a second credential
 * altogether from this app's own XSUAA.
 *
 * Best-effort like every other BTP-platform read in this codebase (workflow-rule-store.js,
 * processAutomation.js): an unreachable subaccount API must not take the value help down, only leave
 * it offering nothing - the cell still takes a typed e-mail address or role name either way.
 */

const SERVICE_NAME = 'mdm-businesspartner-authmgmt';

// Only role collections meant for this app's approver picker - see CLAUDE.md. A subaccount has role
// collections for every application in it; without this filter the picker would offer all of them,
// most naming nothing an approver of a business partner request could mean.
const ROLE_COLLECTION_PREFIX = 'MDMLIGHT';

// Role collections and subaccount users change on nobody's request cadence; there is no reason to
// call BTP's management API on every dialog open the way the payload catalog is generated fresh.
const TTL_MS = 5 * 60 * 1000;

let cachedToken = null;
let tokenExpiresAt = 0;

let cachedAgents = null;
let loadedAt = 0;
let inFlight = null;

function getCredentials() {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  // A managed XSUAA instance - application-plan and apiaccess-plan alike - lands under the `xsuaa`
  // label, told apart by name; unlike the BPA credentials, which are user-provided services.
  const service = (vcap.xsuaa || []).find((instance) => instance.name === SERVICE_NAME);
  if (!service) {
    throw new Error(`Service '${SERVICE_NAME}' not found in VCAP_SERVICES`);
  }
  return service.credentials;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const { clientid, clientsecret, url } = getCredentials();
  const response = await axios.post(
    `${url}/oauth/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }),
    {
      auth: { username: clientid, password: clientsecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );

  cachedToken = response.data.access_token;
  tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
  return cachedToken;
}

/** `apiurl` is the Authorization Management API host that an apiaccess-plan service key carries
 *  alongside the usual `url` - a fixed, region-wide address, not this tenant's own login URL. If it
 *  is missing, the bound instance is not what this module needs, and guessing a host would be worse
 *  than saying so. */
function apiHost(credentials) {
  if (!credentials.apiurl) {
    throw new Error(
      `Service '${SERVICE_NAME}' credentials carry no 'apiurl' - is it bound as an apiaccess-plan `
      + 'XSUAA instance?'
    );
  }
  return credentials.apiurl;
}

async function callApi(path) {
  const credentials = getCredentials();
  const accessToken = await getAccessToken();
  const response = await axios.get(`${apiHost(credentials)}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.data;
}

/** Role collections whose Description starts with MDMLIGHT - see CLAUDE.md. Description, never
 *  Name: the prefix is a naming convention applied to the description a subaccount admin writes,
 *  not to the role collection's own (often short, unrelated) name. Case-insensitive on purpose: an
 *  admin typing "Mdmlight" or "mdmlight" is not a mistake this filter should be able to make into a
 *  silently-empty list. */
async function fetchRoleCollections() {
  const data = await callApi('/sap/rest/authorization/v2/rolecollections');
  const collections = Array.isArray(data) ? data : (data.roleCollections || data.value || []);
  return collections
    .filter((collection) => (
      typeof collection.description === 'string'
      && collection.description.toUpperCase().startsWith(ROLE_COLLECTION_PREFIX)
    ))
    .map((collection) => ({ type: 'Role', value: collection.name }))
    .filter((agent) => agent.value);
}

/** Every user in the subaccount, named by e-mail where one is on file - an approver is addressed by
 *  a person, and e-mail is the address this app's own notifications and SBPA both already use. Falls
 *  back to the username for a user with none. */
async function fetchUsers() {
  const data = await callApi('/Users');
  const users = Array.isArray(data) ? data : (data.resources || data.Resources || data.value || []);
  return users
    .map((user) => (user.emails && user.emails.length ? user.emails[0].value : (user.userName || user.id)))
    .filter(Boolean)
    .map((value) => ({ type: 'User', value }));
}

async function load() {
  const [roles, users] = await Promise.all([
    fetchRoleCollections().catch((error) => {
      console.warn('[workflow-agents] Could not read BTP role collections:', error.message);
      return [];
    }),
    fetchUsers().catch((error) => {
      console.warn('[workflow-agents] Could not read BTP subaccount users:', error.message);
      return [];
    })
  ]);
  return [...roles, ...users];
}

/**
 * `{ type: 'Role'|'User', value }[]`, cached for TTL_MS. Never throws: an unreachable subaccount API,
 * or a missing service binding entirely, leaves the picker offering nothing rather than taking the
 * rule page down - the same discipline field-property-store.js and workflow-rule-store.js follow for
 * their own tables.
 */
async function workflowAgents({ force = false } = {}) {
  if (!force && cachedAgents && (Date.now() - loadedAt) < TTL_MS) {
    return cachedAgents;
  }
  if (!inFlight) {
    // load() never rejects - each fetch swallows its own error above - so there is nothing to catch
    // here beyond what those two already log.
    inFlight = load()
      .then((agents) => {
        cachedAgents = agents;
        loadedAt = Date.now();
        return agents;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

function reset() {
  cachedAgents = null;
  loadedAt = 0;
  inFlight = null;
  cachedToken = null;
  tokenExpiresAt = 0;
}

module.exports = {
  SERVICE_NAME,
  ROLE_COLLECTION_PREFIX,
  TTL_MS,
  workflowAgents,
  reset,
  // Shared with data-stewards.js, which reads the same Authorization Management API through the same
  // token cache - a second module fetching its own token would be a second, redundant call to the
  // XSUAA token endpoint for the one client credential this app has for that API.
  callApi,
  // Exported for tests only, same convention as _internals elsewhere in this codebase.
  _internals: { fetchRoleCollections, fetchUsers, getCredentials, apiHost }
};
