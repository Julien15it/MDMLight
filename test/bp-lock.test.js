'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const cds = require('@sap/cds');

const {
  LOCKING_STATUSES, holderUser, lockHolder, lockMessage
} = require('../srv/bp-lock');
const { IN_PROGRESS_REQUEST_STATUSES } = require('../srv/search-results');
const { ACTIVE_REQUEST_STATUSES } = require('../srv/business-partner-service')._internals;

const SRV = path.join(__dirname, '..', 'srv');
const REUSE = path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');
const bpServiceJs = fs.readFileSync(path.join(SRV, 'business-partner-service.js'), 'utf8');
const bpServiceCds = fs.readFileSync(path.join(SRV, 'business-partner-service.cds'), 'utf8');
const crServiceJs = fs.readFileSync(path.join(SRV, 'change-request-service.js'), 'utf8');
const controllerSource = fs.readFileSync(
  path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'), 'utf8'
);
const viewSource = fs.readFileSync(
  path.join(REUSE, 'view', 'BusinessPartnerMaintenance.view.xml'), 'utf8'
);

/** Stands in for `cds.connect.to('db')` for the length of one call. */
async function withStagedRequests(rows, run) {
  const connect = cds.connect.to;
  const queries = [];
  cds.connect.to = async () => ({
    run: async (query) => {
      queries.push(query);
      if (rows instanceof Error) throw rows;
      return rows;
    }
  });
  try {
    return { result: await run(), queries };
  } finally {
    cds.connect.to = connect;
  }
}

const holder = (overrides = {}) => Object.assign({
  ID: 'cr-1',
  requestType: 'change',
  status: 'inApproval',
  businessPartner: '20',
  createdBy: 'author@alluvion.eu',
  submittedBy: 'requester@alluvion.eu'
}, overrides);

// ---------------------------------------------------------------------------------------------
// The statuses themselves
// ---------------------------------------------------------------------------------------------

test('the lock is the ACTIVE set, defined once and aliased by the business partner service', () => {
  assert.deepEqual(
    [...LOCKING_STATUSES],
    ['draft', 'inApproval', 'approved', 'reworkRequired', 'checkAndEnrich', 'failed']
  );
  // One list, not two that can drift: the service aliases it rather than redeclaring it.
  assert.equal(ACTIVE_REQUEST_STATUSES, LOCKING_STATUSES);
  assert.match(bpServiceJs, /const ACTIVE_REQUEST_STATUSES = LOCKING_STATUSES;/u);
});

test('a draft locks, and posted never does', () => {
  // Decided 2026-09-15: a request nobody has submitted yet is still somebody's work on that partner.
  assert.ok(LOCKING_STATUSES.includes('draft'));
  assert.equal(LOCKING_STATUSES.includes('posted'), false);
  assert.equal(LOCKING_STATUSES.includes('rejected'), false);
});

test('the lock stays wider than the list marker', () => {
  for (const status of IN_PROGRESS_REQUEST_STATUSES) {
    assert.ok(LOCKING_STATUSES.includes(status), `${status} is not a locking status`);
  }
  assert.ok(LOCKING_STATUSES.length > IN_PROGRESS_REQUEST_STATUSES.length);
});

// ---------------------------------------------------------------------------------------------
// Who holds it, and what the refusal says
// ---------------------------------------------------------------------------------------------

test('the holder is the submitter, falling back to the author of a draft', () => {
  assert.equal(holderUser(holder()), 'requester@alluvion.eu');
  assert.equal(holderUser(holder({ submittedBy: null })), 'author@alluvion.eu');
  assert.equal(holderUser(holder({ submittedBy: null, createdBy: null })), '');
  assert.equal(holderUser(null), '');
});

test('the refusal names the partner, the request, its status and who has it', () => {
  const message = lockMessage(holder(), '20');
  assert.match(message, /Business Partner 20 is locked/u);
  assert.match(message, /Change request/u);
  assert.match(message, /requester@alluvion\.eu/u);
  assert.match(message, /in approval/u);
  assert.match(message, /completed or withdrawn/u);
});

test('an unattributed draft still produces a sentence, without a dangling "by"', () => {
  const message = lockMessage(
    holder({ status: 'draft', submittedBy: null, createdBy: null }), '20'
  );
  assert.equal(message.includes(' by '), false);
  assert.match(message, /a Change request is draft/u);
});

// ---------------------------------------------------------------------------------------------
// lockHolder
// ---------------------------------------------------------------------------------------------

test('lockHolder asks for exactly the locking statuses on that one partner', async () => {
  const { result, queries } = await withStagedRequests([holder()], () => lockHolder('20'));
  assert.equal(result.ID, 'cr-1');
  const { where, from } = queries[0].SELECT;
  assert.match(JSON.stringify(from), /ChangeRequests/u);
  const serialised = JSON.stringify(where);
  assert.match(serialised, /"20"/u);
  for (const status of LOCKING_STATUSES) {
    assert.match(serialised, new RegExp(`"${status}"`, 'u'));
  }
});

test('a partner nothing holds is not locked', async () => {
  const { result } = await withStagedRequests([], () => lockHolder('20'));
  assert.equal(result, null);
});

test('a request never locks itself out of its own resubmit', async () => {
  const { result } = await withStagedRequests(
    [holder({ ID: 'cr-1' })], () => lockHolder('20', { excludeRequest: 'cr-1' })
  );
  assert.equal(result, null);
});

test('excluding my own request still finds somebody else\'s', async () => {
  const { result } = await withStagedRequests(
    [holder({ ID: 'cr-1' }), holder({ ID: 'cr-2', status: 'draft' })],
    () => lockHolder('20', { excludeRequest: 'cr-1' })
  );
  assert.equal(result.ID, 'cr-2');
});

test('a create locks nothing: there is no partner number to lock', async () => {
  // No stub at all - lockHolder must not even reach for the database.
  assert.equal(await lockHolder(null), null);
  assert.equal(await lockHolder(''), null);
});

test('an unreadable lock throws rather than reading as unlocked', async () => {
  // The standing rule: a check that could not run must not read as a check that passed. The three
  // callers that GATE a write let this through; only the rendering one catches it.
  await assert.rejects(
    () => withStagedRequests(new Error('staging is down'), () => lockHolder('20')),
    /staging is down/u
  );
});

// ---------------------------------------------------------------------------------------------
// Where the gates are, and where they deliberately are not
// ---------------------------------------------------------------------------------------------

test('persist refuses a second request over a partner somebody else holds', () => {
  // Gated in `persist`, not in `submitRequest`, so saveRequest parks a draft under the same rule.
  const persist = crServiceJs.slice(
    crServiceJs.indexOf('const persist = async (req) => {'),
    crServiceJs.indexOf("this.on('saveRequest'")
  );
  assert.ok(persist.length > 0, 'persist was not found');
  assert.match(persist, /const holder = await lockHolder\(businessPartner, \{ excludeRequest:/u);
  assert.match(persist, /req\.reject\(409, lockMessage\(holder, businessPartner\)\)/u);
});

test('updateBusinessPartner is gated, so Mark for Deletion cannot walk over a request', () => {
  const handler = bpServiceJs.slice(
    bpServiceJs.indexOf("this.on('updateBusinessPartner'"),
    bpServiceJs.indexOf("this.on('saveBusinessPartner'")
  );
  assert.ok(handler.length > 0, 'updateBusinessPartner was not found');
  assert.match(handler, /if \(await rejectWhenLocked\(req, businessPartner\)\) return undefined;/u);
});

test('the three paths postToS4 uses are NOT gated, or an approved request refuses its own post', () => {
  // postToS4 sends saveBusinessPartner, saveBusinessPartnerEntity and deleteBusinessPartnerEntity
  // while the request holding the lock is `approved`. A guard on any of them deadlocks the post.
  for (const action of [
    'saveBusinessPartner', 'saveBusinessPartnerEntity', 'deleteBusinessPartnerEntity'
  ]) {
    const start = bpServiceJs.indexOf(`this.on('${action}'`);
    assert.ok(start > 0, `${action} was not found`);
    const handler = bpServiceJs.slice(start, start + 4000);
    assert.equal(
      /rejectWhenLocked/u.test(handler), false,
      `${action} is on postToS4's own path and must not be gated`
    );
  }
});

test('the lock read is exempt from the assistant cache invalidation', () => {
  // It is a GET that writes nothing and fires on every display open; left in, it would wipe the
  // cache and re-index every name on each of them.
  assert.match(
    bpServiceJs,
    /\['READ', 'askBusinessPartnerAssistant', 'businessPartnerLock'\]\.includes\(req\.event\)/u
  );
});

test('businessPartnerLock separates "not locked" from "could not tell"', () => {
  assert.match(bpServiceCds, /function businessPartnerLock\(/u);
  assert.match(bpServiceCds, /Readable\s+: Boolean;/u);
  const handler = bpServiceJs.slice(
    bpServiceJs.indexOf("this.on('businessPartnerLock'"),
    bpServiceJs.indexOf("this.on('personContactInfo'")
  );
  assert.ok(handler.length > 0, 'businessPartnerLock was not found');
  // The one caller that catches, because it renders rather than gates.
  assert.match(handler, /catch \(error\)/u);
  assert.match(handler, /Readable: false/u);
});

// ---------------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------------

function loadController() {
  let members;
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  vm.runInNewContext(controllerSource, {
    sap: {
      ui: {
        define: (dependencies, factory) => {
          const base = { extend: (name, definition) => { members = definition; return definition; } };
          factory(...dependencies.map((unused, index) => (index === 0 ? base : stub)));
        }
      }
    }
  });
  return members;
}

function screen(state, lockAnswer) {
  const controller = loadController();
  const model = { getData: () => state, refresh: () => {} };
  return Object.assign(Object.create(controller), {
    getView: () => ({ getModel: () => model }),
    _renderAll: () => {},
    _executeAction: async (name) => {
      if (name !== 'businessPartnerLock') return null;
      if (lockAnswer instanceof Error) throw lockAnswer;
      return lockAnswer;
    }
  });
}

test('_readLock passes the server\'s answer straight through', async () => {
  const answer = { Locked: true, Readable: true, Message: 'Business Partner 20 is locked: …' };
  assert.equal(await screen({}, answer)._readLock('20'), answer);
});

test('a lock read that fails leaves Edit offered and says why', async () => {
  // The gates are on the server. Hiding Edit on every partner over a staging hiccup is worse.
  const lock = await screen({}, new Error('service unavailable'))._readLock('20');
  assert.equal(lock.Locked, false);
  assert.equal(lock.Readable, false);
  assert.match(lock.Message, /could not be checked/u);
  assert.match(lock.Message, /may still be refused/u);
});

test('a partner with no number is not read at all', async () => {
  // Asserted field by field: the controller runs in its own vm realm, so its object literals do
  // not share this realm's Object prototype and deepEqual refuses them.
  const lock = await screen({}, new Error('should never be called'))._readLock('');
  assert.equal(lock.Locked, false);
  assert.equal(lock.Readable, true);
  assert.equal(lock.Message, '');
});

test('the edit route opens in display mode on a locked partner', () => {
  // `editing` is overwritten before the mode flags are set, so nothing paints an edit screen and
  // takes it back. Pinned as source, because the route handler needs the whole OData model to run.
  assert.match(
    controllerSource,
    /var lock = await this\._readLock\(businessPartner\);\s*if \(lock\.Locked\) editing = false;/u
  );
  assert.match(controllerSource, /state\.showEditButton = !editing && !lock\.Locked;/u);
  assert.match(controllerSource, /state\.locked = Boolean\(lock\.Locked\);/u);
});

test('onEdit refuses a locked partner even if the button binding never evaluated', () => {
  const state = { locked: true, mode: 'display', editing: false };
  screen(state).onEdit();
  assert.equal(state.editing, false, 'a locked partner must not enter edit mode');
  assert.equal(state.mode, 'display');

  const free = { locked: false, mode: 'display', editing: false };
  screen(free).onEdit();
  assert.equal(free.editing, true);
  assert.equal(free.mode, 'edit');
  assert.equal(free.requestType, 'change');
});

test('the lock has its own strip, so a missing Edit button is explained', () => {
  assert.match(viewSource, /id="maintenanceLockWarnings"/u);
  assert.match(viewSource, /\$\{maintenance>\/lockWarnings\}\.length > 0/u);
});
