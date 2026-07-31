'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadActions(initialHash = '') {
  let actions;
  let hash = initialHash;
  const errors = [];
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
            { error: (message) => errors.push(message) },
            { open: (model, view) => assistantCalls.push({ model, view }) }
          );
        }
      }
    }
  });

  return {
    actions,
    assistantCalls,
    errors,
    getHash: () => hash
  };
}

function context(number) {
  return {
    getProperty: (name) => name === 'BusinessPartner' ? number : undefined
  };
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
