'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const controllerSource = fs.readFileSync(
  path.join(APP, 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'),
  'utf8'
);
const view = fs.readFileSync(path.join(APP, 'ext', 'view', 'BusinessPartnerMaintenance.view.xml'), 'utf8');

// The controller is a UI5 module; only the pure message helpers are exercised here.
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

const answer = (findings, changeRequest = 'cr-1') => ({
  ChangeRequest: changeRequest,
  MessagesJson: JSON.stringify(findings)
});

const duplicate = (overrides = {}) => ({
  checkName: 'duplicate_check',
  severity: 'error',
  verdict: 'duplicate',
  candidateBP: '4711',
  message: 'Duplicate: Business Partner 4711 matches on Name (exact).',
  ...overrides
});

test('a clean submit says so rather than saying nothing', () => {
  const controller = loadController();
  const messages = controller._submitMessages.call(controller, answer([]), true);
  assert.equal(messages[0].type, 'Success');
  assert.match(messages[0].text, /cr-1 submitted for approval/u);
  assert.match(messages[1].text, /no duplicate detected/u);
});

test('an unconfirmed submit names the match and asks for a second press', () => {
  const controller = loadController();
  const messages = controller._submitMessages.call(controller, answer([duplicate()]), false);
  assert.equal(messages.length, 1, 'nothing was submitted, so nothing claims it was');
  assert.equal(messages[0].type, 'Warning');
  assert.match(messages[0].text, /might already exist/u);
  assert.match(messages[0].text, /4711 \(duplicate\)/u);
  assert.match(messages[0].text, /Submit again to confirm creation/u);
});

test('a pending request is named as one, not as a partner number', () => {
  const controller = loadController();
  const [message] = controller._submitMessages.call(
    controller,
    answer([duplicate({ candidateBP: null, candidateRequest: 'req-7', verdict: 'strong' })]),
    false
  );
  assert.match(message.text, /pending request req-7 \(strong\)/u);
});

// "No duplicate detected" must never cover for a check that could not run.
test('a check that failed is reported alongside the outcome', () => {
  const controller = loadController();
  const messages = controller._submitMessages.call(controller, answer([
    { checkName: 'duplicate_check', severity: 'info', message: 'The duplicate check could not run (db is away).' }
  ]), true);
  assert.equal(messages.some((message) => /could not run/u.test(message.text)), true);
});

test('malformed findings degrade to an empty list rather than throwing', () => {
  const controller = loadController();
  assert.deepEqual(controller._findingsFrom({ MessagesJson: 'not json' }).length, 0);
  assert.deepEqual(controller._findingsFrom({}).length, 0);
  assert.deepEqual(controller._findingsFrom({ MessagesJson: '{"a":1}' }).length, 0);
});

test('submitting no longer leaves the screen, and the messages have somewhere to render', () => {
  assert.equal(
    /navTo\("BusinessPartnersList", \{\}, true\);\s*\}\s*catch/u.test(controllerSource),
    false,
    'the submit branch must not navigate away'
  );
  assert.match(view, /items="\{ path: 'maintenance>\/messages'/u);
  assert.match(view, /<MessageStrip/u);
});

test('confirmation is tied to the payload that was warned about, not to a flag', () => {
  assert.match(controllerSource, /awaitingConfirmationFor === parameters\.DataJson/u);
  assert.match(controllerSource, /state\.awaitingConfirmationFor = parameters\.DataJson/u);
});
