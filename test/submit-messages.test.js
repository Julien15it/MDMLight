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

// The duplicate belongs to the dialog the user already confirmed through. Repeating it above the
// submitted request is the noise this replaced.
test('a submitted request never repeats the duplicate at the top of the screen', () => {
  const controller = loadController();
  const messages = controller._submitMessages.call(controller, answer([duplicate()]));
  assert.equal(messages[0].type, 'Success');
  assert.equal(messages.some((message) => /might already exist/u.test(message.text)), false);
  assert.equal(messages.some((message) => /4711/u.test(message.text)), false);
  // The finding is still written to CheckFindings for the approver, so nothing is lost.
});

test('a pending request is named as one in the dialog, not as a partner number', () => {
  assert.match(controllerSource, /pending request " \+ finding\.candidateRequest/u);
  assert.match(controllerSource, /finding\.candidateBP \|\| \("pending request/u);
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
  // Submit only carries Confirm when the payload still matches the one that was warned about.
  // Where the arming happens is pinned by 'confirming from Check carries over to Submit' below —
  // it moved into _confirmDuplicates so Check and Submit can share one confirmation.
  assert.match(controllerSource, /awaitingConfirmationFor === parameters\.DataJson/u);
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
test('the duplicate dialog offers Submit Request only where there is something to submit', () => {
  assert.match(controllerSource, /if \(result && result\.NeedsConfirmation\)[\s\S]{0,420}_confirmDuplicates/u);
  // Submit gets both buttons, Check gets Continue Editing alone - there is nothing to cancel.
  assert.match(controllerSource, /actions: confirmText \? \[confirmText, keepEditing\] : \[keepEditing\]/u);
  assert.match(controllerSource, /var keepEditing = "Continue Editing";/u);
  assert.match(controllerSource, /confirmText: "Submit Request"/u);
  // No Cancel on this dialog. The delete confirmation keeps its own, so the check is scoped.
  const dialog = controllerSource.slice(
    controllerSource.indexOf('_confirmDuplicates: function'),
    controllerSource.indexOf('_submitMessages: function')
  );
  assert.equal(/MessageBox\.Action\.CANCEL/u.test(dialog), false);
  // Carrying on editing confirms nothing, so an unchanged payload is asked about again.
  assert.match(controllerSource, /state\.awaitingConfirmationFor = "";/u);
});

// The message told people to press a button that no longer has to be pressed, which is worse than
// no message: it was still on screen after the submit it was asking for had already happened.
test('no message tells the user to press submit again', () => {
  assert.equal(/Press Submit Request to confirm/u.test(controllerSource), false);
  assert.equal(/again to confirm/u.test(controllerSource), false);
});

// One re-entry and no more: a server that somehow asked twice would otherwise submit in a loop.
test('the dialog submits once and cannot re-enter itself', () => {
  assert.match(controllerSource, /_sendChangeRequest: async function \(action, confirmed\)/u);
  assert.match(controllerSource, /onConfirm: confirmed \? null : function \(\) \{\s*this\._sendChangeRequest\(action, true\);/u);
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
  assert.deepEqual(Array.from(messages, (message) => message.type), ['Warning', 'Information', 'Success']);
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
  assert.deepEqual(Array.from(messages, (message) => message.type), ['Error']);
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

// Lengths and fields, not deepEqual: the controller runs in its own vm realm, so both its arrays
// and the objects inside them fail a prototype-strict comparison against ones built out here.
test('malformed json from the check degrades to an empty list', () => {
  const controller = loadController();
  const parse = (text) => controller._parseJsonArray.call(controller, text);
  assert.equal(parse('not json').length, 0);
  assert.equal(parse('{"a":1}').length, 0, 'an object is not a list of findings');
  assert.equal(parse(undefined).length, 0);
  const parsed = parse('[{"a":1}]');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].a, 1);
});


// Check reports, Submit decides. Acknowledging a duplicate on Check is not a confirmation, so it
// arms nothing; only the dialog's own Submit Request does, tied to the exact payload it showed.
test('only the submit dialog arms the confirmation, and only for its own payload', () => {
  assert.match(controllerSource, /_confirmDuplicates: function \(findings, dataJson, options\)/u);
  assert.match(controllerSource, /if \(confirmText && action === confirmText\)/u);
  assert.match(controllerSource, /state\.awaitingConfirmationFor = dataJson \|\| "";/u);
  // Armed on the decision, not when the dialog opens: closing it must leave nothing behind.
  assert.equal(/awaitingConfirmationFor = parameters\.DataJson;/u.test(controllerSource), false);
  // Check arms against the payload as it stands after enrichment, which is what Submit will send.
  // Check passes no confirmText, which is what leaves it with one button and no arming.
  assert.match(
    controllerSource,
    /_confirmDuplicates\(duplicates, this\._requestDataJson\(state\), \{\s*after: offerNormalisations\s*\}\)/u
  );
});

test('a derived value can land on an address row, not only on the root', () => {
  assert.match(controllerSource, /entry\.target === "root"[\s\S]{0,120}state\.sections\[entry\.target\]/u);
  // Without marking the row changed, an enriched field never reaches staging.
  assert.match(controllerSource, /record\.__state = "changed"/u);
});

test('the check reports enrichment and validation at the top, duplicates only in the dialog', () => {
  const controller = loadController();
  const messages = controller._checkMessages.call(
    controller,
    [],
    [{ target: 'Addresses', index: 0, field: 'StreetName', message: 'StreetName was filled in as "Kerkstraat" from GLEIF.' }],
    [{ verdict: 'duplicate', candidateBP: '4711' }],
    { Valid: true, RanDuplicateCheck: true }
  );
  assert.equal(messages.some((message) => /from GLEIF/u.test(message.text)), true);
  assert.equal(messages.some((message) => /4711/u.test(message.text)), false);
  assert.equal(messages.some((message) => /might already exist/u.test(message.text)), false);
});

// "Cancel" cancels nothing once the request is in approval, and every other footer button is
// already gone by then, so the whole toolbar goes rather than leaving an empty bar.
test('a submitted request has no cancel button, and no empty footer', () => {
  assert.match(view, /visible="\{maintenance>\/showCancelButton\}"/u);
  assert.match(controllerSource, /showCancelButton: true,/u, 'it starts visible');
  assert.match(
    controllerSource,
    /state\.showCancelButton = false;\s*state\.showFooter = false;/u
  );
  // Nobody is stranded: the object page header carries a permanent way back to the list.
  assert.match(view, /text="Business Partners"[\s\S]{0,200}press="\.onBackToList"/u);
});

// --- Submit runs the validations, but never the derivations ----------------------------

// A derivation changes the data, and the requester has to have seen what they asked for.
// Check is the derivation trigger; submit only validates.
test('submit validates but does not derive', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );
  const submitAt = service.indexOf("this.on('submitRequest'");
  const submitBody = service.slice(submitAt, service.indexOf("this.on('getRequestPayload'", submitAt));
  assert.match(submitBody, /runValidations\(/u);
  assert.equal(/runDerivations|registry\.derivations/u.test(submitBody), false, 'no derivation on submit');
  // The Check action is where derivations do run.
  const checkAt = service.indexOf("this.on('checkRequest'");
  const checkBody = service.slice(checkAt, service.indexOf("this.on('submitRequest'", checkAt));
  assert.match(checkBody, /derivations: registry\.derivations/u);
});

test('a blocking validation stops the submit and leaves it a draft', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );
  assert.match(service, /validations\.some\(\(message\) => message\.severity === BLOCKING\)/u);
  assert.match(service, /Status: 'draft',\s*NeedsConfirmation: false,\s*Valid: false/u);
});

// At the top of the screen, not in a dialog: these are things to go and fix in the form,
// with the fields right there behind them — unlike a duplicate, which is a decision.
test('validation errors render as message strips, not a popup', () => {
  assert.match(controllerSource, /if \(result && result\.Valid === false\)/u);
  assert.match(controllerSource, /_parseJsonArray\(result\.ValidationsJson\)/u);
  const branch = controllerSource.slice(
    controllerSource.indexOf('result.Valid === false'),
    controllerSource.indexOf('result.NeedsConfirmation')
  );
  assert.equal(/MessageBox/u.test(branch), false, 'no dialog for a validation');
  assert.match(branch, /type: entry\.severity === "error" \? "Error" : "Warning"/u);
});

// Every exit from submitRequest has to carry the new fields, or the client reads undefined
// and treats a perfectly good submit as invalid.
test('every submit outcome reports Valid and ValidationsJson', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );
  const submitAt = service.indexOf("this.on('submitRequest'");
  const submitBody = service.slice(submitAt, service.indexOf("this.on('getRequestPayload'", submitAt));
  assert.equal((submitBody.match(/Valid:/gu) || []).length, 3, 'blocked, unconfirmed and submitted');
  assert.equal((submitBody.match(/ValidationsJson:/gu) || []).length, 3);
});

// Numbers alone made several distinct partners look like one repeated entry.
test('the duplicate dialog names each partner, not only its number', () => {
  assert.match(controllerSource, /finding\.candidateName \? " " \+ finding\.candidateName : ""/u);
});
