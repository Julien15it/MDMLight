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
              information: (message) => information.push(message)
            },
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
    getHash: () => hash
  };
}

function context(number) {
  return {
    getProperty: (name) => name === 'BusinessPartner' ? number : undefined
  };
}

/** A row of the merged search list: either a pending create or a partner carrying a request. */
function searchRow(properties) {
  return { getProperty: (name) => properties[name] };
}

test('create action navigates directly to the maintenance route', () => {
  const runtime = loadActions();
  runtime.actions.openCreatePage();
  assert.equal(runtime.getHash(), 'BusinessPartners/create');
  assert.deepEqual(runtime.errors, []);
});

test('home action returns to the Business Partner list', () => {
  const runtime = loadActions('BusinessPartners/1/display');
  runtime.actions.openListPage();
  assert.equal(runtime.getHash(), '');
});

test('assistant uses the Fiori page model without requiring a selection', () => {
  const runtime = loadActions();
  const model = { name: 'main-service' };
  const view = { name: 'list-view' };
  runtime.actions.setEnvironment(model, view);
  runtime.actions.openAssistant();
  assert.deepEqual(runtime.assistantCalls, [{ model, view: null }]);
});

test('assistant can resolve a model from a wrapped Fiori context', () => {
  const runtime = loadActions();
  const model = { name: 'wrapped-service' };
  runtime.actions.openAssistant({
    bindingContext: {
      getProperty: () => undefined,
      getModel: () => model
    }
  });
  assert.deepEqual(runtime.assistantCalls, [{ model, view: null }]);
});

test('a late page initialization cannot erase the component OData model', () => {
  const runtime = loadActions();
  const model = { name: 'component-service' };
  runtime.actions.setEnvironment(model, null);
  runtime.actions.setEnvironment(null, { name: 'late-list-view' });
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

test('row navigation opens the complete Business Partner display page', () => {
  const runtime = loadActions();
  runtime.actions.openDisplayPage(context('3'));
  assert.equal(runtime.getHash(), 'BusinessPartners/3/display');
  assert.deepEqual(runtime.errors, []);
});

test('row navigation accepts the official Fiori bindingContext wrapper', () => {
  const runtime = loadActions();
  runtime.actions.openDisplayPage({ bindingContext: context('3') });
  assert.equal(runtime.getHash(), 'BusinessPartners/3/display');
  assert.deepEqual(runtime.errors, []);
});

test('list edit accepts contexts wrapped by the Fiori action runtime', () => {
  const runtime = loadActions();
  const actionParameters = { selectedContexts: [context('149')] };
  assert.equal(runtime.actions.isSingleSelection(actionParameters), true);
  runtime.actions.openEditPage(actionParameters);
  assert.equal(runtime.getHash(), 'BusinessPartners/149/maintain');
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

// Viewing is not editing: the edit and approve routes stay where they were.
test('even a draft opens on the display route, never the edit one', () => {
  const runtime = loadActions();
  runtime.actions.openDisplayPage(searchRow({
    IsChangeRequest: true,
    ChangeRequest: 'req-2',
    ChangeRequestStatus: 'draft'
  }));
  assert.equal(runtime.getHash(), 'ChangeRequests/req-2/display');
  assert.equal(/\/edit|\/approve/u.test(runtime.getHash()), false);
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

test('a partner marked with a pending request still opens its own display page', () => {
  const runtime = loadActions();
  runtime.actions.openDisplayPage(searchRow({
    IsChangeRequest: false,
    BusinessPartner: '4711',
    ChangeRequest: 'req-4',
    ChangeRequestStatus: 'inApproval'
  }));
  assert.equal(runtime.getHash(), 'BusinessPartners/4711/display');
  assert.deepEqual(runtime.information, []);
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
