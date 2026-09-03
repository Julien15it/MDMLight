'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const btpAgents = require('../srv/wf/btp-agents');
const { getCredentials, apiHost } = btpAgents._internals;

const CREDENTIALS = {
  clientid: 'sb-client',
  clientsecret: 'secret',
  url: 'https://subaccount.authentication.eu10.hana.ondemand.com',
  apiurl: 'https://api.authentication.eu10.hana.ondemand.com'
};

// `run` may be async - awaited here, not merely invoked, or the `finally` below restores the
// environment before a deferred (microtask-queued) body has actually read it.
async function withVcap(value, run) {
  const before = process.env.VCAP_SERVICES;
  if (value === undefined) delete process.env.VCAP_SERVICES;
  else process.env.VCAP_SERVICES = JSON.stringify(value);
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.VCAP_SERVICES;
    else process.env.VCAP_SERVICES = before;
  }
}

async function withAxios(handlers, run) {
  const originalGet = axios.get;
  const originalPost = axios.post;
  axios.get = handlers.get || originalGet;
  axios.post = handlers.post || originalPost;
  try {
    return await run();
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
}

test.afterEach(() => {
  btpAgents.reset();
});

// Told apart from mdmlight-bpa-uaa/-key: those are user-provided services, this is a managed XSUAA
// instance and lands under the `xsuaa` VCAP group, by name like every other bound instance.
test('the service is found under the xsuaa group by name', async () => {
  const found = await withVcap(
    { xsuaa: [{ name: 'mdm-businesspartner-auth', credentials: { url: 'wrong' } }, { name: 'mdm-businesspartner-authmgmt', credentials: CREDENTIALS }] },
    getCredentials
  );
  assert.equal(found.url, CREDENTIALS.url);
});

// apiurl is what tells an apiaccess-plan instance apart from the app's own application-plan one -
// the same host every subaccount's Authorization Management API answers on, not the tenant login URL.
test('apiHost demands apiurl rather than guessing one from url', () => {
  assert.equal(apiHost(CREDENTIALS), CREDENTIALS.apiurl);
  assert.throws(() => apiHost({ url: CREDENTIALS.url }), /apiaccess-plan/u);
});

test('role collections are filtered to the MDMLIGHT prefix and named, never their own row shape', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/sap/rest/authorization/v2/rolecollections')) {
        return {
          data: [
            { name: 'MDMLIGHT_Sales_Approver', description: 'MDMLIGHT Sales Approver' },
            { name: 'MDMLIGHT_Data_Steward', description: 'MDMLIGHT Data Steward' },
            { name: 'Some_Other_App_Admin', description: 'Some other app entirely' }
          ]
        };
      }
      return { data: [] };
    }
  }, async () => {
    const agents = await btpAgents.workflowAgents();
    const roles = agents.filter((agent) => agent.type === 'Role');
    assert.deepEqual(roles.map((role) => role.value).sort(), ['MDMLIGHT_Data_Steward', 'MDMLIGHT_Sales_Approver']);
  }));
});

test('users are named by e-mail, falling back to their user name when they have none', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/Users')) {
        return {
          data: {
            resources: [
              { userName: 'julien', emails: [{ value: 'julien@alluvion.eu' }] },
              { userName: 'service-user', emails: [] }
            ]
          }
        };
      }
      return { data: [] };
    }
  }, async () => {
    const agents = await btpAgents.workflowAgents();
    const users = agents.filter((agent) => agent.type === 'User');
    assert.deepEqual(users.map((user) => user.value).sort(), ['julien@alluvion.eu', 'service-user']);
  }));
});

// Best-effort like every other BTP-platform read in this codebase: the picker offers nothing rather
// than taking the rule page down, whether the subaccount API is unreachable or not bound at all.
test('an unreadable subaccount never throws - it resolves to no agents', () => {
  return withVcap(undefined, () => btpAgents.workflowAgents().then((agents) => {
    assert.deepEqual(agents, []);
  }));
});

// The 5-minute cache: role collections and users do not change fast enough to justify a call to the
// subaccount's management API on every dialog open.
test('a second call within the TTL does not call the API again', () => {
  let calls = 0;
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async () => {
      calls += 1;
      return { data: [] };
    }
  }, async () => {
    await btpAgents.workflowAgents();
    await btpAgents.workflowAgents();
    // Two endpoints (role collections, users) called once each per load.
    assert.equal(calls, 2);
  }));
});

// --- emailsForRoleCollections --------------------------------------------------------------

/**
 * What makes a `WorkflowRules.approvers` entry naming a role (e.g. "Approver Customer", picked from
 * the Workflow Agent Determination cell) actually reach anyone: SBPA does not resolve BTP role
 * collection membership itself, so this is resolved to real e-mails before it ever crosses the wire -
 * see workflowContext in change-request-service.js. Shared with data-stewards.js's own lookup.
 */
test('emailsForRoleCollections resolves membership off /Users own groups', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/Users')) {
        return {
          data: [
            {
              userName: 'maarten', emails: [{ value: 'maarten@alluvion.eu' }],
              groups: [{ value: 'Approver Customer', display: 'Approver Customer' }]
            },
            {
              userName: 'julien', emails: [{ value: 'julien@alluvion.eu' }],
              groups: [{ value: 'Approver Customer', display: 'Approver Customer' }]
            },
            {
              userName: 'other', emails: [{ value: 'other@alluvion.eu' }],
              groups: [{ value: 'Some_Other_Role', display: 'Some_Other_Role' }]
            }
          ]
        };
      }
      return { data: [] };
    }
  }, async () => {
    const emails = await btpAgents.emailsForRoleCollections(['Approver Customer']);
    assert.deepEqual(emails.sort(), ['julien@alluvion.eu', 'maarten@alluvion.eu']);
  }));
});

// --- specificRoleFor -----------------------------------------------------------------------

/**
 * What lets two Field Property Profiles scoped to different approver functions actually apply to
 * different people - see effectiveFieldProperties in change-request-service.js and CLAUDE.md "Field
 * property profiles". Reads the SAME /Users response as emailsForRoleCollections, in the other
 * direction: given a user, which of their own groups matches the category being asked about.
 */
test('specificRoleFor finds the one of a user\'s own groups matching the category', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/Users')) {
        return {
          data: [{
            userName: 'maarten', emails: [{ value: 'maarten@alluvion.eu' }],
            groups: [
              { value: 'Approver Customer', display: 'Approver Customer' },
              { value: 'Alluvion_Developer', display: 'Alluvion_Developer' }
            ]
          }]
        };
      }
      return { data: [] };
    }
  }, async () => {
    assert.equal(await btpAgents.specificRoleFor('maarten@alluvion.eu', 'Approver'), 'Approver Customer');
  }));
});

// Reported live (2026-09-02): field property profiles never applied to any approver. The reason
// was startsWith rather than includes - the workflowAgents fixture right above this one already
// uses `MDMLIGHT_Sales_Approver`, a real-shaped name with the category LAST, which a prefix check
// could never match. This pins that specific shape resolves correctly now.
test('specificRoleFor matches a category anywhere in the name, not only as a prefix', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/Users')) {
        return {
          data: [{
            userName: 'maarten', emails: [{ value: 'maarten@alluvion.eu' }],
            groups: [
              { value: 'MDMLIGHT_Sales_Approver', display: 'MDMLIGHT Sales Approver' },
              { value: 'Alluvion_Developer', display: 'Alluvion_Developer' }
            ]
          }]
        };
      }
      return { data: [] };
    }
  }, async () => {
    assert.equal(await btpAgents.specificRoleFor('maarten@alluvion.eu', 'Approver'), 'MDMLIGHT_Sales_Approver');
  }));
});

test('specificRoleFor is null when nothing matches, when several do, or when the user is unknown', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/Users')) {
        return {
          data: [
            {
              userName: 'nomatch', emails: [{ value: 'nomatch@alluvion.eu' }],
              groups: [{ value: 'Alluvion_Developer', display: 'Alluvion_Developer' }]
            },
            {
              userName: 'both', emails: [{ value: 'both@alluvion.eu' }],
              // Ambiguous on purpose: two of their own roles both match the category - picking one
              // would be a guess, so the caller falls back to the bare category instead.
              groups: [
                { value: 'Approver Customer', display: 'Approver Customer' },
                { value: 'Approver Vendor', display: 'Approver Vendor' }
              ]
            }
          ]
        };
      }
      return { data: [] };
    }
  }, async () => {
    assert.equal(await btpAgents.specificRoleFor('nomatch@alluvion.eu', 'Approver'), null);
    assert.equal(await btpAgents.specificRoleFor('both@alluvion.eu', 'Approver'), null);
    assert.equal(await btpAgents.specificRoleFor('nobody@alluvion.eu', 'Approver'), null);
  }));
});


// --- the shared /Users cache -----------------------------------------------------------------

/**
 * `specificRoleFor` runs on every render of the maintenance screen and every Check press, through
 * `resolveEffectiveRole`. It used to fetch the whole subaccount each time - and the data steward
 * screen paid for it twice per open, since it checks itself on load. Only `fetchUsers` sat behind
 * a cache, and only incidentally, because `workflowAgents` caches its own mapped result.
 *
 * All three readers now share one `/Users` read on the same TTL.
 */
test('the three /Users readers share one cached read', () => {
  let userReads = 0;
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/Users')) {
        userReads += 1;
        return {
          data: [{
            userName: 'maarten', emails: [{ value: 'maarten@alluvion.eu' }],
            groups: [{ value: 'Approver Customer', display: 'Approver Customer' }]
          }]
        };
      }
      return { data: [] };
    }
  }, async () => {
    assert.equal(await btpAgents.specificRoleFor('maarten@alluvion.eu', 'Approver'), 'Approver Customer');
    assert.equal(await btpAgents.specificRoleFor('maarten@alluvion.eu', 'Approver'), 'Approver Customer');
    assert.deepEqual(await btpAgents.emailsForRoleCollections(['Approver Customer']), ['maarten@alluvion.eu']);
    await btpAgents.workflowAgents();
    assert.equal(userReads, 1, 'one /Users read serves every reader within the TTL');
  }));
});

// A failed read is not cached - the same discipline the rule and profile stores follow. Each caller
// still degrades its own way rather than throwing.
test('a failed /Users read is retried rather than remembered', () => {
  let userReads = 0;
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/Users')) {
        userReads += 1;
        if (userReads === 1) throw new Error('subaccount away');
        return { data: [{ userName: 'm', emails: [{ value: 'm@alluvion.eu' }], groups: [{ value: 'Approver X' }] }] };
      }
      return { data: [] };
    }
  }, async () => {
    assert.equal(await btpAgents.specificRoleFor('m@alluvion.eu', 'Approver'), null, 'degrades, never throws');
    assert.equal(await btpAgents.specificRoleFor('m@alluvion.eu', 'Approver'), 'Approver X');
    assert.equal(userReads, 2, 'the failure was not cached');
  }));
});
