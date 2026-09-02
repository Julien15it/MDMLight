'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadActions(initialHash = '', { assistantAvailable = true } = {}) {
  let actions;
  let hash = initialHash;
  const errors = [];
  const warnings = [];
  const information = [];
  const confirms = [];
  const toasts = [];
  const assistantCalls = [];
  const hashChanger = {
    getHash: () => hash,
    setHash: (value) => { hash = value; }
  };
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'businesspartner', 'webapp', 'ext', 'CustomActions.js'),
    'utf8'
  );

  vm.runInNewContext(source, {
    sap: {
      ui: {
        define: (_dependencies, factory) => {
          actions = factory(
            { getInstance: () => hashChanger },
            {
              error: (message) => errors.push(message),
              // A row under a change request is refused rather than opened, so the module needs
              // more of MessageBox than the one method the error paths used.
              warning: (message) => warnings.push(message),
              information: (message) => information.push(message),
              // Captured rather than auto-confirmed, so a test can assert on the message shown
              // before deciding whether the user pressed OK or Cancel.
              confirm: (message, options) => confirms.push({ message, options }),
              Action: { OK: 'OK', CANCEL: 'CANCEL' }
            },
            { show: (message) => toasts.push(message) },
            {
              open: (model, view) => assistantCalls.push({ model, view }),
              // Part of the module's interface, not an extra: openAssistant asks before it
              // opens, so an installation with AI assistance switched off is never offered
              // the assistant at all.
              isAvailable: () => assistantAvailable
            }
          );
        }
      }
    }
  });

  return {
    actions,
    assistantCalls,
    errors,
    warnings,
    information,
    confirms,
    toasts,
    getHash: () => hash
  };
}

function context(number) {
  return {
    getProperty: (name) => name === 'BusinessPartner' ? number : undefined
  };
}

/** A fake OData V4 model, just enough of bindContext(...).execute() for one unbound action call. */
function fakeModel({ fails = false } = {}) {
  const calls = [];
  return {
    calls,
    bindContext: (path) => {
      const parameters = {};
      return {
        setParameter: (name, value) => { parameters[name] = value; },
        execute: () => {
          calls.push({ path, parameters });
          return fails ? Promise.reject(new Error('S/4HANA rejected it')) : Promise.resolve();
        },
        getBoundContext: () => ({ getObject: () => ({}) }),
        destroy: () => {}
      };
    }
  };
}

/** A row of the merged search list: either a pending create or a partner carrying a request. */
function searchRow(properties, model) {
  return {
    getProperty: (name) => properties[name],
    getModel: () => model
  };
}

test('create action navigates directly to the maintenance route', () => {
  const runtime = loadActions();
  runtime.actions.openCreatePage();
  assert.equal(runtime.getHash(), 'BusinessPartners/create');
  assert.deepEqual(runtime.errors, []);
});

test('assistant uses the Fiori page model without requiring a selection', () => {
  const runtime = loadActions();
  const model = { name: 'main-service' };
  const view = { name: 'list-view' };
  runtime.actions.setEnvironment(model, view);
  runtime.actions.openAssistant();
  assert.deepEqual(runtime.assistantCalls, [{ model, view: null }]);
});

// The Fiori Elements actions bind their `visible` to the same flag, so with assistance off
// there is normally no button to press. This is the lock behind that binding: a press that
// arrives anyway must not open a dialog the installation is not allowed to use.
test('with AI assistance off the assistant does not open at all', () => {
  const runtime = loadActions('', { assistantAvailable: false });
  runtime.actions.setEnvironment({ name: 'main-service' }, { name: 'list-view' });
  runtime.actions.openAssistant();
  assert.deepEqual(runtime.assistantCalls, []);
  assert.equal(runtime.actions.isAssistantAvailable(), false);
});

test('list edit action accepts the selected Fiori Elements context', () => {
  const runtime = loadActions();
  assert.equal(runtime.actions.isSingleSelection(null, [context('3')]), true);
  runtime.actions.openEditPage(null, [context('3')]);
  assert.equal(runtime.getHash(), 'BusinessPartners/3/maintain');
  assert.deepEqual(runtime.errors, []);
});

test('object-page edit action uses its context or current object-page hash', () => {
  const direct = loadActions();
  direct.actions.openEditCurrentPage(context('149'));
  assert.equal(direct.getHash(), 'BusinessPartners/149/maintain');

  const fallback = loadActions("BusinessPartners('191')");
  fallback.actions.openEditCurrentPage();
  assert.equal(fallback.getHash(), 'BusinessPartners/191/maintain');
  assert.deepEqual(fallback.errors, []);
});

// --- The merged search list ---------------------------------------------------------------

// Seeing what has already been asked for is the point of showing the request in the list at all,
// and the list is open to everyone - so the read-only view is too.
test('a change request row opens read-only', () => {
  const runtime = loadActions();
  runtime.actions.openDisplayPage(searchRow({
    IsChangeRequest: true,
    ChangeRequest: 'req-1',
    ChangeRequestStatus: 'inApproval'
  }));
  assert.equal(runtime.getHash(), 'ChangeRequests/req-1/display');
  assert.deepEqual(runtime.information, []);
  assert.deepEqual(runtime.errors, []);
});

// Nothing to open. Says what the row is instead of navigating to a route with no id in it.
test('a request row with no id reports itself rather than navigating', () => {
  const runtime = loadActions();
  runtime.actions.openDisplayPage(searchRow({
    IsChangeRequest: true,
    ChangeRequest: null,
    RecordStatus: 'Create draft'
  }));
  assert.equal(runtime.getHash(), '');
  assert.equal(runtime.information.length, 1);
  assert.match(runtime.information[0], /Create draft/u);
});

// Hiding the row used to be what prevented a second request over the same partner. A message is now.
test('editing a partner under a request in flight is refused and names the request', () => {
  const runtime = loadActions();
  runtime.actions.openEditPage(null, [searchRow({
    IsChangeRequest: false,
    BusinessPartner: '4711',
    ChangeRequest: 'req-5',
    ChangeRequestStatus: 'inApproval',
    RecordStatus: 'Change in approval',
    RequestedBy: 'julien'
  })]);
  assert.equal(runtime.getHash(), '');
  assert.equal(runtime.warnings.length, 1);
  assert.match(runtime.warnings[0], /Change in approval/u);
  assert.match(runtime.warnings[0], /julien/u);
  assert.deepEqual(runtime.errors, []);
});

// There is no partner to edit yet, so Edit shows what there is: the request, read-only.
test('editing a pending create opens it read-only instead', () => {
  const runtime = loadActions();
  runtime.actions.openEditPage(null, [searchRow({
    IsChangeRequest: true,
    ChangeRequest: 'req-6',
    ChangeRequestStatus: 'draft',
    RecordStatus: 'Create draft'
  })]);
  assert.equal(runtime.getHash(), 'ChangeRequests/req-6/display');
  assert.deepEqual(runtime.warnings, []);
});

test('a partner with no request in flight is edited exactly as before', () => {
  const runtime = loadActions();
  runtime.actions.openEditPage(null, [searchRow({
    IsChangeRequest: false,
    BusinessPartner: '4711',
    ChangeRequest: null
  })]);
  assert.equal(runtime.getHash(), 'BusinessPartners/4711/maintain');
  assert.deepEqual(runtime.warnings, []);
});

// --- Mark for Deletion ----------------------------------------------------------------------
// S/4 has no DELETE verb for a Business Partner: "deleting" one from the search page sets the
// central IsMarkedForArchiving flag directly, no staging or approval - the same trust level as an
// edit, not a create.

test('nothing selected refuses rather than asking what to confirm', () => {
  const runtime = loadActions();
  runtime.actions.markForDeletion(null, []);
  assert.equal(runtime.errors.length, 1);
  assert.deepEqual(runtime.confirms, []);
});

test('a pending create has no Business Partner number, so it is refused outright', () => {
  const runtime = loadActions();
  runtime.actions.markForDeletion(null, [searchRow({ IsChangeRequest: true, ChangeRequest: 'req-1' })]);
  assert.equal(runtime.errors.length, 1);
  assert.match(runtime.errors[0], /no Business Partner number/u);
  assert.deepEqual(runtime.confirms, []);
});

test('confirming marks the selected partner and refreshes the list', async () => {
  const runtime = loadActions();
  const model = fakeModel();
  const extensionAPI = { refreshed: 0, refresh: function () { this.refreshed += 1; } };
  runtime.actions.setEnvironment(null, null, extensionAPI);

  runtime.actions.markForDeletion(null, [
    searchRow({ IsChangeRequest: false, BusinessPartner: '4711', BusinessPartnerFullName: 'Acme NV' }, model)
  ]);

  assert.equal(runtime.confirms.length, 1);
  assert.match(runtime.confirms[0].message, /4711/u);
  assert.match(runtime.confirms[0].message, /Acme NV/u);

  await runtime.confirms[0].options.onClose('OK');
  // onClose's own promise chain resolves on a later microtask than the await above.
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(model.calls, [{
    path: '/updateBusinessPartner(...)',
    parameters: { BusinessPartner: '4711', IsMarkedForArchiving: true }
  }]);
  assert.equal(runtime.toasts.length, 1);
  assert.equal(extensionAPI.refreshed, 1);
});

test('cancelling the confirmation calls nothing', async () => {
  const runtime = loadActions();
  const model = fakeModel();
  runtime.actions.markForDeletion(null, [searchRow({ IsChangeRequest: false, BusinessPartner: '4711' }, model)]);

  await runtime.confirms[0].options.onClose('CANCEL');
  assert.deepEqual(model.calls, []);
  assert.deepEqual(runtime.toasts, []);
});

test('a pending create among the selection is skipped and named, the real partner still marked', async () => {
  const runtime = loadActions();
  const model = fakeModel();
  runtime.actions.markForDeletion(null, [
    searchRow({ IsChangeRequest: false, BusinessPartner: '4711', BusinessPartnerFullName: 'Acme NV' }, model),
    searchRow({ IsChangeRequest: true, ChangeRequest: 'req-9' }, model)
  ]);

  assert.match(runtime.confirms[0].message, /1 pending create row\(s\) were skipped/u);
  await runtime.confirms[0].options.onClose('OK');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].parameters.BusinessPartner, '4711');
});

test('a failed update is reported, not swallowed', async () => {
  const runtime = loadActions();
  const model = fakeModel({ fails: true });
  runtime.actions.markForDeletion(null, [searchRow({ IsChangeRequest: false, BusinessPartner: '4711' }, model)]);

  await runtime.confirms[0].options.onClose('OK');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(runtime.errors.length, 1);
  assert.match(runtime.errors[0], /Could not mark for deletion/u);
  assert.deepEqual(runtime.toasts, []);
});
