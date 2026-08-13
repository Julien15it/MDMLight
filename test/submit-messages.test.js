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
  const messages = controller._submitMessages.call(controller, answer([]));
  assert.equal(messages[0].type, 'Success');
  assert.match(messages[0].text, /cr-1 submitted for approval/u);
  assert.match(messages[1].text, /no duplicate detected/u);
});

// The unconfirmed case is a dialog now. _submitMessages only ever reports a request that really
// was submitted, so it must never again produce a "submit again" instruction.
test('a submitted request that had a duplicate says it went through anyway', () => {
  const controller = loadController();
  const messages = controller._submitMessages.call(controller, answer([duplicate()]));
  assert.equal(messages[0].type, 'Success');
  assert.match(messages[1].text, /might already exist/u);
  assert.match(messages[1].text, /4711 \(duplicate\)/u);
  assert.equal(/Submit again to confirm/u.test(messages[1].text), false);
});

test('a pending request is named as one, not as a partner number', () => {
  const controller = loadController();
  const messages = controller._submitMessages.call(
    controller,
    answer([duplicate({ candidateBP: null, candidateRequest: 'req-7', verdict: 'strong' })])
  );
  assert.ok(messages.some((message) => /pending request req-7 \(strong\)/u.test(message.text)));
});

// "No duplicate detected" must never cover for a check that could not run.
test('a check that failed is reported alongside the outcome', () => {
  const controller = loadController();
  const messages = controller._submitMessages.call(controller, answer([
    { checkName: 'duplicate_check', severity: 'info', message: 'The duplicate check could not run (db is away).' }
  ]));
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


// --- Preview removed, Check added ------------------------------------------------------------

// One less step between wanting a business partner and asking for one. Submit runs the same
// validation the Preview gate used to.
test('the preview step is gone from the screen and the controller', () => {
  assert.equal(/showPreviewButton/u.test(controllerSource), false);
  assert.equal(/onPreview/u.test(controllerSource), false);
  assert.equal(/showPreviewButton/u.test(view), false);
  assert.equal(/text="Preview"/u.test(view), false);
  // All three have to be reachable straight away: Preview used to be what revealed Submit and
  // Save Request, so without it an empty create form would have nothing but Cancel.
  assert.match(
    controllerSource,
    /showCheckButton: true,\s*showSaveButton: true,\s*showSaveRequestButton: true,/u
  );
});

test('the check button is wired to the pipeline action', () => {
  assert.match(view, /text="Check"/u);
  assert.match(view, /press="\.onCheck"/u);
  assert.match(view, /visible="\{maintenance>\/showCheckButton\}"/u);
  assert.match(controllerSource, /_executeAction\("checkRequest"/u);
});

// A banner above a long object page is easy to submit straight past; this is a decision.
test('an unconfirmed duplicate opens a dialog with Continue and Cancel', () => {
  assert.match(controllerSource, /if \(result && result\.NeedsConfirmation\)[\s\S]{0,320}_confirmDuplicates/u);
  assert.match(controllerSource, /actions: \["Continue", MessageBox\.Action\.CANCEL\]/u);
  // Continue arms the next press rather than submitting for the user.
  assert.match(controllerSource, /Press Submit Request again to confirm/u);
  // Cancel drops the arming, so an unchanged payload is checked again rather than waved through.
  assert.match(controllerSource, /state\.awaitingConfirmationFor = "";/u);
});

test('the check reports validations, derivations and duplicates in that order', () => {
  const controller = loadController();
  const messages = controller._checkMessages.call(
    controller,
    [{ severity: 'warning', message: 'Search term is short.' }],
    [{ field: 'Country', value: 'BE', message: 'Country was derived as BE.' }],
    [],
    { Valid: true, RanDuplicateCheck: true }
  );
  assert.deepEqual(messages.map((message) => message.type), ['Warning', 'Information', 'Success']);
});

test('a blocked validation stops the check reporting anything about duplicates', () => {
  const controller = loadController();
  const messages = controller._checkMessages.call(
    controller,
    [{ severity: 'error', message: 'Enter a grouping.' }],
    [],
    [],
    { Valid: false, RanDuplicateCheck: false }
  );
  assert.deepEqual(messages.map((message) => message.type), ['Error']);
  assert.equal(messages.some((message) => /duplicate/iu.test(message.text)), false);
});

// The one wrong answer the check must not give.
test('a duplicate check that did not run is never reported as no duplicates', () => {
  const controller = loadController();
  const messages = controller._checkMessages.call(
    controller, [], [], [], { Valid: true, RanDuplicateCheck: false }
  );
  assert.equal(messages.some((message) => /no duplicate detected/u.test(message.text)), false);
  assert.match(messages[0].text, /did not run/u);
  assert.match(controllerSource, /RanDuplicateCheck === false[\s\S]{0,200}Nothing was ruled out/u);
});

test('malformed json from the check degrades to an empty list', () => {
  const controller = loadController();
  assert.deepEqual(controller._parseJsonArray.call(controller, 'not json'), []);
  assert.deepEqual(controller._parseJsonArray.call(controller, '{"a":1}'), []);
  assert.deepEqual(controller._parseJsonArray.call(controller, undefined), []);
  assert.deepEqual(controller._parseJsonArray.call(controller, '[{"a":1}]'), [{ a: 1 }]);
});
