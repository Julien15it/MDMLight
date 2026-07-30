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
            { error: (message) => errors.push(message) }
          );
        }
      }
    }
  });

  return {
    actions,
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
