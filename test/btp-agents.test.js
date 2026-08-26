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

test('an unbound service is reported, not silently empty', async () => {
  await assert.rejects(withVcap({ xsuaa: [] }, getCredentials), /not found in VCAP_SERVICES/u);
  await assert.rejects(withVcap(undefined, getCredentials), /not found in VCAP_SERVICES/u);
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

test('one side failing does not cost the other', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/Users')) throw new Error('boom');
      return { data: [{ name: 'MDMLIGHT_X', description: 'MDMLIGHT X' }] };
    }
  }, async () => {
    const agents = await btpAgents.workflowAgents();
    assert.deepEqual(agents, [{ type: 'Role', value: 'MDMLIGHT_X' }]);
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
