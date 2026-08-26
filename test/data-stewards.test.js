'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const btpAgents = require('../srv/wf/btp-agents');
const dataStewards = require('../srv/wf/data-stewards');

const CREDENTIALS = {
  clientid: 'sb-client',
  clientsecret: 'secret',
  url: 'https://subaccount.authentication.eu10.hana.ondemand.com',
  apiurl: 'https://api.authentication.eu10.hana.ondemand.com'
};

// Mirrors test/btp-agents.test.js - the same VCAP/axios mocking, since data-stewards.js reuses
// btp-agents.js's `callApi` rather than its own client.
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
  dataStewards.reset();
  btpAgents.reset();
});

// Shapes below are copied from a real subaccount response (2026-08-26 live diagnostic), not guessed -
// see the module doc comment for what was wrong before and how this was confirmed.
test('a user is a steward when their own /Users groups name a collection carrying the DataSteward role template', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/sap/rest/authorization/v2/rolecollections')) {
        return {
          data: [
            {
              name: 'DataSteward',
              description: 'MDMLIGHT',
              roleReferences: [{
                roleTemplateAppId: 'mdm-businesspartner-alluvion-dev-cf-dev!t512170',
                roleTemplateName: 'DataSteward',
                name: 'DataSteward'
              }]
            },
            {
              name: 'Alluvion_Admin',
              description: '',
              roleReferences: [{ roleTemplateAppId: 'eu10-app-studio!t33857', roleTemplateName: 'Business_Application_Studio_Administrator' }]
            }
          ]
        };
      }
      if (url.endsWith('/Users')) {
        return {
          data: [
            {
              userName: 'julien.compernolle@alluvion.eu',
              emails: [{ value: 'julien.compernolle@alluvion.eu' }],
              groups: [
                { value: 'Alluvion_Developer', display: 'Alluvion_Developer', type: 'DIRECT' },
                { value: 'DataSteward', display: 'DataSteward', type: 'DIRECT' }
              ]
            },
            {
              userName: 'matthijs.mennens@amista.com',
              emails: [{ value: 'matthijs.mennens@amista.com' }],
              groups: [
                { value: 'Subaccount Administrator', display: 'Subaccount Administrator', type: 'DIRECT' },
                { value: 'Alluvion_Admin', display: 'Alluvion_Admin', type: 'DIRECT' }
              ]
            }
          ]
        };
      }
      return { data: [] };
    }
  }, async () => {
    const emails = await dataStewards.dataStewardEmails();
    assert.deepEqual(emails, ['julien.compernolle@alluvion.eu']);
  }));
});

// The bug that shipped: a role collection's roles were read off `detail.roles`/`detail.value`, which
// do not exist on the list response - only `roleReferences` does. Pinned so it cannot come back.
test('a collection is matched by roleReferences, not by a roles or value key that does not exist', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/sap/rest/authorization/v2/rolecollections')) {
        return {
          data: [{
            name: 'DataSteward',
            // No `roles` or `value` key here on purpose - only roleReferences, like the real API.
            roleReferences: [{ roleTemplateName: 'DataSteward' }]
          }]
        };
      }
      if (url.endsWith('/Users')) {
        return { data: [{ userName: 'a', emails: [{ value: 'a@b.com' }], groups: [{ value: 'DataSteward' }] }] };
      }
      return { data: [] };
    }
  }, async () => {
    const emails = await dataStewards.dataStewardEmails();
    assert.deepEqual(emails, ['a@b.com']);
  }));
});

// The other bug that shipped: the per-user rolecollections endpoint answered empty for a confirmed
// member, so this module no longer calls it - membership comes off /Users' own `groups` only.
test('never calls the per-user rolecollections endpoint - membership comes off /Users groups', () => {
  let calledPerUserEndpoint = false;
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.includes('/rolecollections') && !url.endsWith('/rolecollections')) calledPerUserEndpoint = true;
      if (url.includes('/users/') && url.endsWith('/rolecollections')) calledPerUserEndpoint = true;
      if (url.endsWith('/sap/rest/authorization/v2/rolecollections')) {
        return { data: [{ name: 'DataSteward', roleReferences: [{ roleTemplateName: 'DataSteward' }] }] };
      }
      if (url.endsWith('/Users')) {
        return { data: [{ userName: 'a', emails: [{ value: 'a@b.com' }], groups: [{ value: 'DataSteward' }] }] };
      }
      return { data: [] };
    }
  }, async () => {
    const emails = await dataStewards.dataStewardEmails();
    assert.deepEqual(emails, ['a@b.com']);
    assert.equal(calledPerUserEndpoint, false);
  }));
});

test('no matching role collection resolves to no stewards, without calling /Users at all', () => {
  let usersCalled = false;
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/sap/rest/authorization/v2/rolecollections')) {
        return { data: [{ name: 'Other_App_Admins', roleReferences: [{ roleTemplateName: 'SomeOtherRole' }] }] };
      }
      if (url.endsWith('/Users')) {
        usersCalled = true;
        return { data: [] };
      }
      return { data: [] };
    }
  }, async () => {
    const emails = await dataStewards.dataStewardEmails();
    assert.deepEqual(emails, []);
    assert.equal(usersCalled, false, 'nothing to check membership against, so /Users is never asked');
  }));
});

// Best-effort like btp-agents.js: an unreachable subaccount, or one not bound at all, resolves to no
// stewards rather than costing the submit that is asking for them.
test('an unreadable subaccount never throws - it resolves to no stewards', () => {
  return withVcap(undefined, () => dataStewards.dataStewardEmails().then((emails) => {
    assert.deepEqual(emails, []);
  }));
});

test('a user with no groups, or none matching, contributes nobody', () => {
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async (url) => {
      if (url.endsWith('/sap/rest/authorization/v2/rolecollections')) {
        return { data: [{ name: 'DataSteward', roleReferences: [{ roleTemplateName: 'DataSteward' }] }] };
      }
      if (url.endsWith('/Users')) {
        return {
          data: [
            { userName: 'no-groups', emails: [{ value: 'x@b.com' }] },
            { userName: 'other-groups', emails: [{ value: 'y@b.com' }], groups: [{ value: 'Something_Else' }] }
          ]
        };
      }
      return { data: [] };
    }
  }, async () => {
    const emails = await dataStewards.dataStewardEmails();
    assert.deepEqual(emails, []);
  }));
});

test('a second call within the TTL does not call the API again', () => {
  let calls = 0;
  return withVcap({ xsuaa: [{ name: btpAgents.SERVICE_NAME, credentials: CREDENTIALS }] }, () => withAxios({
    post: async () => ({ data: { access_token: 'tok', expires_in: 3600 } }),
    get: async () => {
      calls += 1;
      return { data: [] };
    }
  }, async () => {
    await dataStewards.dataStewardEmails();
    await dataStewards.dataStewardEmails();
    // One call: the role collection list, with nothing in it to fan out to (no /Users call either).
    assert.equal(calls, 1);
  }));
});
