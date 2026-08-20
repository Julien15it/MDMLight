'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Editing used to write straight to S/4: onEdit set `editing` but not `mode`, which onSave routes on.

const APP = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const REUSE = path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');
const controllerSource = fs.readFileSync(
  path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
  'utf8'
);

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

// Just enough around the controller to press a button and record what it sent.
function screen(state) {
  const controller = loadController();
  const sent = [];
  const model = { getData: () => state, refresh: () => {} };
  return {
    state,
    sent,
    controller: Object.assign(Object.create(controller), {
      getView: () => ({ getModel: () => model }),
      _renderAll: () => {},
      _validationErrors: () => [],
      _sendChangeRequest: (action) => { sent.push(action); }
    })
  };
}

const displayed = (overrides = {}) => ({
  mode: 'display',
  editing: false,
  businessPartner: '4711',
  root: {},
  sections: {},
  ...overrides
});

test('pressing Edit puts the screen in edit mode, not just in editing state', () => {
  const { state, controller } = screen(displayed());
  controller.onEdit();
  assert.equal(state.mode, 'edit');
  assert.equal(state.editing, true);
  assert.equal(state.requestType, 'change');
});

test('creating is still a create when Edit is pressed on the create form', () => {
  const { state, controller } = screen(displayed({ mode: 'create' }));
  controller.onEdit();
  assert.equal(state.mode, 'create');
  assert.notEqual(state.requestType, 'change');
});

test('submitting a change raises a change request instead of writing to S/4', async () => {
  const { sent, controller } = screen(displayed());
  controller.onEdit();
  await controller.onSave();
  assert.deepEqual(sent, ['submitRequest']);
});

test('submitting a create still raises a change request', async () => {
  const { sent, controller } = screen(displayed({ mode: 'create' }));
  await controller.onSave();
  assert.deepEqual(sent, ['submitRequest']);
});

// Nothing should ever reach here, which is exactly why it must not be a direct S/4 call.
test('an unrecognised mode refuses rather than writing to S/4', async () => {
  const { sent, controller } = screen(displayed({ mode: 'approve' }));
  await controller.onSave();
  assert.deepEqual(sent, []);
});

test('the client has no path to S/4 left at all', () => {
  for (const action of [
    'saveBusinessPartner"',
    'saveBusinessPartnerEntity"',
    'deleteBusinessPartnerEntity"',
    'startBusinessPartnerApprovalWorkflow"'
  ]) {
    assert.equal(
      controllerSource.includes(action),
      false,
      `${action} is a direct write; posting to S/4 belongs to the approval path only`
    );
  }
});
