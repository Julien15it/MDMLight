'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const REUSE = path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');
const controllerSource = fs.readFileSync(
  path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
  'utf8'
);
const view = fs.readFileSync(path.join(REUSE, 'view', 'BusinessPartnerMaintenance.view.xml'), 'utf8');

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

// Two questions, two buttons: "is this record right?" and "does it already exist?".
test('both check buttons are wired to their own action', () => {
  assert.match(view, /text="Check"/u);
  assert.match(view, /press="\.onCheck"/u);
  assert.match(view, /text="Duplicate Check"/u);
  assert.match(view, /press="\.onDuplicateCheck"/u);
  assert.match(view, /visible="\{maintenance>\/showCheckButton\}"/u);
  assert.match(controllerSource, /_executeAction\("checkRequest"/u);
  assert.match(controllerSource, /_executeAction\("duplicateCheckRequest"/u);

  // In the header, and NOT in the footer: on a long form the footer is a scroll away from the
  // fields being filled in, and they were briefly in both places, which just showed them twice.
  const footer = view.slice(view.indexOf('<footer>'));
  assert.equal(/press="\.onCheck"/u.test(footer), false, 'Check belongs to the header now');
  assert.equal(/press="\.onDuplicateCheck"/u.test(footer), false);
  assert.match(footer, /press="\.onSave"/u, 'the primary action stays in the footer');
});

// Check answers about the record, not about other partners.
test('the check action neither asks for nor reads duplicates', () => {
  const check = controllerSource.slice(
    controllerSource.indexOf('onCheck: async function'),
    controllerSource.indexOf('onDuplicateCheck: async function')
  );
  assert.equal(/DuplicatesJson|_confirmDuplicates|RanDuplicateCheck/u.test(check), false);
  assert.match(check, /_proposalRows\(derivations, normalisations\)/u);
});

// A banner above a long object page is easy to submit straight past; this is a decision.
test('the duplicate dialog offers Submit Request only where there is something to submit', () => {
  assert.match(controllerSource, /if \(result && result\.NeedsConfirmation\)[\s\S]{0,420}_confirmDuplicates/u);
  // Submit gets both buttons, Check gets Continue Editing alone - there is nothing to cancel.
  assert.match(controllerSource, /actions: confirmText \? \[confirmText, keepEditing\] : \[keepEditing\]/u);
  assert.match(controllerSource, /var keepEditing = "Continue Editing";/u);
  // The button names the action it will actually take: a rework resubmits, a data steward review
  // completes, rather than either submitting.
  assert.match(
    controllerSource,
    /confirmText: action === "resubmitRequest"\s*\n?\s*\? "Resubmit"\s*\n?\s*: \(action === "decideDataStewardReview" \? "Complete Review" : "Submit Request"\)/u
  );
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

// A derivation that filled a field is a proposal now, so it belongs in the dialog and not in a
// strip. One that carries no field could never be applied, so the strip is the only place for it.
test('the check strips carry validations and statements, never an appliable derivation', () => {
  const controller = loadController();
  const messages = controller._checkMessages.call(
    controller,
    [{ severity: 'warning', message: 'Search term is short.' }],
    [
      { field: 'Country', value: 'BE', message: 'Country was derived as BE.' },
      { message: 'A street is available but there is no Addresses row to hold it.' }
    ]
  );
  assert.deepEqual(Array.from(messages, (message) => message.type), ['Warning', 'Information']);
  assert.equal(messages.some((message) => /derived as BE/u.test(message.text)), false);
  assert.match(messages[1].text, /no Addresses row/u);
});

test('a blocked validation stops the duplicate check reporting anything about duplicates', () => {
  const controller = loadController();
  const messages = controller._duplicateCheckMessages.call(
    controller,
    [{ severity: 'error', message: 'Enter a grouping.' }],
    [],
    { Valid: false, RanDuplicateCheck: false }
  );
  assert.deepEqual(Array.from(messages, (message) => message.type), ['Error']);
  assert.equal(messages.some((message) => /duplicate/iu.test(message.text)), false);
});

// The one wrong answer the check must not give.
test('a duplicate check that did not run is never reported as no duplicates', () => {
  const controller = loadController();
  const messages = controller._duplicateCheckMessages.call(
    controller, [], [], { Valid: true, RanDuplicateCheck: false }
  );
  assert.equal(messages.some((message) => /no duplicate detected/u.test(message.text)), false);
  assert.match(messages[0].text, /did not run/u);
  assert.match(controllerSource, /RanDuplicateCheck === false[\s\S]{0,200}Nothing was ruled out/u);
});

// Dismissing the dialog used to be the only copy of the list, so checking a candidate meant
// pressing the button again to see who it was.
test('the duplicate findings stay on screen in a panel that collapses', () => {
  const controller = loadController();
  const state = { duplicates: [], duplicatesHeader: '' };
  controller._setDuplicatePanel.call(controller, state, [
    { verdict: 'duplicate', candidateBP: '4711', candidateName: 'Alluvion BV', message: 'Same VAT number.' },
    { verdict: 'possible', candidateRequest: 'abc', candidateName: 'Alluvion BVBA' },
    { message: 'A rule could not run.' }
  ], { RanDuplicateCheck: true });
  assert.equal(state.duplicates.length, 2, 'only findings with a verdict are duplicates');
  assert.match(state.duplicates[0].title, /4711/u);
  assert.match(state.duplicates[1].title, /pending request abc/u);
  assert.match(state.duplicatesHeader, /2 possible duplicates/u);
  assert.match(view, /expandable="true"[\s\S]{0,200}expanded="false"/u);
  assert.match(view, /<ScrollContainer[\s\S]{0,120}items="\{ path: 'maintenance>\/duplicates'/u);
});

// Clearing them would read as "checked again, and now clean".
test('a duplicate check that did not run leaves the previous findings standing', () => {
  const controller = loadController();
  const state = { duplicates: [{ title: '4711' }], duplicatesHeader: '1 possible duplicate' };
  controller._setDuplicatePanel.call(controller, state, [], { RanDuplicateCheck: false });
  assert.equal(state.duplicates.length, 1);
  // A check that did run and found nothing does clear them.
  controller._setDuplicatePanel.call(controller, state, [], { RanDuplicateCheck: true });
  assert.equal(state.duplicates.length, 0);
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
  // Duplicate Check passes no confirmText, which is what leaves it with one button and no arming.
  assert.match(
    controllerSource,
    /_confirmDuplicates\(duplicates, this\._requestDataJson\(state\), \{\}\)/u
  );
});

// --- The proposals dialog: derivations and normalisations in one list ------------------

test('derivations and normalisations become one list, labelled by what they do', () => {
  const controller = loadController();
  const rows = controller._proposalRows.call(
    controller,
    [
      { target: 'Addresses', index: 0, field: 'CityName', value: 'Gent', message: 'From VIES.' },
      { message: 'A street is available but there is no Addresses row.' }
    ],
    [{ target: 'root', index: 0, field: 'OrganizationBPName1', current: 'test nv', proposed: 'Test NV', reason: 'legal form' }]
  );
  assert.equal(rows.length, 2, 'a derivation with no field cannot be applied, so it is not a row');
  assert.equal(rows[0].change, 'Filled in');
  assert.equal(rows[0].current, '', 'a derivation only ever fills an empty field');
  assert.equal(rows[1].change, 'Reformatted');
  assert.equal(rows[1].current, 'test nv');
  assert.equal(rows.every((row) => row.accepted), true, 'everything starts ticked');
});

// Applying both would write the same field twice, and the normalised value is the better one.
test('a derived field the model then reformatted is one row, not two', () => {
  const controller = loadController();
  const rows = controller._proposalRows.call(
    controller,
    [{
      target: 'Addresses', index: 0, field: 'StreetName', value: 'koedreef st',
      label: 'GLEIF check', message: 'From GLEIF.'
    }],
    [{
      target: 'Addresses', index: 0, field: 'StreetName', current: 'koedreef st',
      proposed: 'Koedreef Straat', reason: 'Street type', detail: 'Spelled out as Straat.'
    }]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].change, 'Filled in');
  assert.equal(rows[0].proposed, 'Koedreef Straat', 'the normalised value wins');
  // The derivation's label leads — it is why the field has a value at all — and the reformatting
  // is said in the tooltip rather than growing the label past three words (2026-08-27).
  assert.equal(rows[0].reason, 'GLEIF check');
  assert.match(rows[0].detail, /From GLEIF\. Spelled out as Straat\./u);
});

// "st" needing to be resolved is right; resolving it to "Straat" rather than "Sint" may not be.
test('the proposed value is editable, and what was typed is what gets applied', () => {
  assert.match(controllerSource, /new Input\(\{ value: "\{proposed\}" \}\)/u);
  const controller = loadController();
  const state = { root: {}, sections: { Addresses: [{}] }, duplicates: [], duplicatesHeader: '' };
  controller._updatePreview = function () {};
  controller._renderAll = function () {};
  controller.getView = function () {
    return { getModel: function () { return { getData: function () { return state; } }; } };
  };
  controller._applyProposals.call(controller, [
    { target: 'Addresses', index: 0, field: 'StreetName', current: 'koedreef st', proposed: 'Koedreef Sint', accepted: true },
    { target: 'root', index: 0, field: 'SearchTerm1', current: 'abc', proposed: '   ', accepted: true }
  ]);
  assert.equal(state.sections.Addresses[0].StreetName, 'Koedreef Sint', 'the edited value, not the proposed one');
  assert.equal(state.root.SearchTerm1, undefined, 'an emptied field is a decline, not a blanking');
});

// Only Duplicate Check and Submit ever match, so clearing the findings on Check would leave the
// screen looking clean on the strength of a check nobody ran.
test('applying a proposal drops the confirmation but keeps the duplicate findings', () => {
  const controller = loadController();
  const state = {
    root: {},
    sections: {},
    awaitingConfirmation: true,
    awaitingConfirmationFor: 'old-payload',
    duplicates: [{ title: '4711' }],
    duplicatesHeader: '1 possible duplicate'
  };
  controller._updatePreview = function () {};
  controller._renderAll = function () {};
  controller.getView = function () {
    return { getModel: function () { return { getData: function () { return state; } }; } };
  };
  controller._applyProposals.call(controller, [
    { target: 'root', index: 0, field: 'SearchTerm1', current: 'abc', proposed: 'ABC', accepted: true }
  ]);
  assert.equal(state.root.SearchTerm1, 'ABC');
  assert.equal(state.awaitingConfirmation, false, 'the payload changed, so the confirmation lapses');
  assert.equal(state.duplicates.length, 1, 'the findings stand until something matches again');
  assert.equal(state.duplicatesHeader, '1 possible duplicate');
});

// Submit matches as well, so its findings replace the panel rather than sitting next to it.
test('a submit that found duplicates refreshes the panel', () => {
  assert.match(
    controllerSource,
    /NeedsConfirmation[\s\S]{0,320}_setDuplicatePanel\(state, this\._findingsFrom\(result\), \{ RanDuplicateCheck: true \}\)/u
  );
});

test('an applied proposal can land on an address row, not only on the root', () => {
  assert.match(controllerSource, /proposal\.target === "root"[\s\S]{0,200}state\.sections\[proposal\.target\]/u);
  // Without marking the row changed, an accepted field never reaches staging.
  assert.match(controllerSource, /record\.__state = "changed"/u);
});

/**
 * Asked for 2026-08-20: a derivation whose conditions are met should not wait for the requester to
 * press Add before it can propose anything. The server creates the row in its own copy and flags
 * the proposal; accepting it is what creates the row on the screen - so nothing is added without a
 * tick, which is the rule every proposal has followed since 2026-08-14.
 */
test('accepting a proposal can create the row it needs', () => {
  // Its own label: adding a record nobody added is a bigger thing than filling an empty field.
  // The ternary moved into _proposalRows when a KEYED row became one line (2026-08-28) -- an
  // unkeyed one, which is what the registry's address proposal is, still gets a line per field
  // and still says "Row added" on each.
  assert.match(controllerSource, /entry\.createsRow \? "Row added" : "Filled in"/u);
  assert.match(controllerSource, /this\._derivationRow\(lead, "Row added",/u);
  assert.match(controllerSource, /createsRow: Boolean\(entry\.createsRow\)/u);
  // Accepting is what creates it, and it stages as a C - an update to a row S/4 does not have
  // would be replayed as one by postToS4.
  assert.match(controllerSource, /if \(proposal\.createsRow && proposal\.target && proposal\.target !== "root"\)/u);
  assert.match(controllerSource, /added = \{ __state: "new" \}/u);
  // Accepting the same proposal twice, or accepting one the requester already added by hand,
  // must not produce a second row.
  assert.match(controllerSource, /duplicate = rows\.some\(/u);
  assert.match(controllerSource, /if \(duplicate\) return;/u);
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
  // submitRequest, resubmitRequest and decideRequest's approve gate share one validation runner
  // (2026-08-31), so the "no derivation" and "configured validations" guarantees live on that
  // shared function now rather than being copied into each handler.
  const runnerFnAt = service.indexOf('const runSubmitValidations =');
  const runnerFnBody = service.slice(runnerFnAt, service.indexOf('this.on(', runnerFnAt));
  assert.match(runnerFnBody, /runValidations\(/u);
  assert.match(runnerFnBody, /configured\.validations/u);
  assert.equal(
    /runDerivations|registry\.derivations|configured\.derivations/u.test(runnerFnBody),
    false,
    'no derivation on submit, from the registry or the configured table'
  );

  const submitAt = service.indexOf("this.on('submitRequest'");
  const submitBody = service.slice(submitAt, service.indexOf("this.on('getRequestPayload'", submitAt));
  assert.match(submitBody, /runSubmitValidations\(/u);
  assert.equal(
    /runDerivations|registry\.derivations|configured\.derivations/u.test(submitBody),
    false,
    'no derivation on submit, from the registry or the configured table'
  );
  // Both buttons derive, through the one runner they share — and since 2026-08-19 from both
  // sources: the steward's derivation table as well as VIES/GLEIF.
  const runnerAt = service.indexOf('const runRequestChecks =');
  const runnerBody = service.slice(runnerAt, service.indexOf("this.on('checkRequest'", runnerAt));
  assert.match(
    runnerBody,
    /derivations: \[\.\.\.configured\.derivations, \.\.\.registry\.derivations,\s*\.\.\.createCviStages\(\)\.derivations, \.\.\.createDerivationStages\(\)\.derivations\]/u
  );
});

// decideRequest re-runs the same validations before approving (2026-08-31, "heel belangrijk"):
// configuration behind a rule can change between submit and approval, and approving is the last
// point before S/4 ever sees the data. Still no derivations - nothing on the approve screen is
// editable, so there is nobody left to show a proposal to.
test('approve re-validates before posting, and still does not derive', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );
  const decideAt = service.indexOf("this.on('decideRequest'");
  const decideBody = service.slice(decideAt, service.indexOf("this.on('completeRequest'", decideAt));
  assert.match(decideBody, /runSubmitValidations\(req, approvalPayload\)/u);
  assert.match(decideBody, /loadStagedPayload\(changeRequest\)/u);
  assert.match(decideBody, /severity === BLOCKING/u);
  assert.equal(
    /runDerivations|registry\.derivations|configured\.derivations/u.test(decideBody),
    false,
    'no derivation on approve either'
  );
});

// Duplicate Check derives in memory so a rule conditioned on a field nobody typed still fires,
// but returns nothing about it: applying values is the other button's job.
test('the duplicate check derives without reporting what it derived', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );
  const body = service.slice(service.indexOf("this.on('duplicateCheckRequest'"));
  assert.match(body, /propose: false, duplicates: true/u);
  assert.equal(/DerivationsJson|NormalisationsJson/u.test(body), false);
  // And Check is the other way round: proposals, no matching.
  const check = service.slice(
    service.indexOf("this.on('checkRequest'"),
    service.indexOf("this.on('duplicateCheckRequest'")
  );
  // Propose defaults to true, so the button still proposes; only a field trigger passes false.
  assert.match(check, /propose: req\.data\.Propose !== false/u);
  assert.match(check, /duplicates: false/u);
  assert.equal(/DuplicatesJson|RanDuplicateCheck/u.test(check), false);
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

/**
 * Every exit from a submit has to carry the new fields, or the client reads undefined and treats a
 * perfectly good submit as invalid. Checked per handler rather than over one slice: `resubmitRequest`
 * now sits between `submitRequest` and `getRequestPayload`, and counting across both would pass on
 * six-of-any-shape while one handler was missing a field.
 */
test('every submit outcome reports Valid and ValidationsJson', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );
  const bodyOf = (name, endsAt) => service.slice(
    service.indexOf(`this.on('${name}'`), service.indexOf(`this.on('${endsAt}'`)
  );
  // Both share the same three exits: a blocking validation, an unconfirmed duplicate, and success.
  for (const [name, endsAt] of [
    ['submitRequest', 'resubmitRequest'],
    ['resubmitRequest', 'withdrawRequest']
  ]) {
    const body = bodyOf(name, endsAt);
    assert.equal((body.match(/Valid:/gu) || []).length, 3, `${name}: blocked, unconfirmed and submitted`);
    assert.equal((body.match(/ValidationsJson:/gu) || []).length, 3, `${name}: every exit reports why`);
  }
});

// Numbers alone made several distinct partners look like one repeated entry.
test('the duplicate dialog names each partner, not only its number', () => {
  assert.match(controllerSource, /finding\.candidateName \? " " \+ finding\.candidateName : ""/u);
});


// --- Declining a proposal ------------------------------------------------------------

/**
 * A decline is remembered against the PROPOSAL, not against the payload - the register answering
 * something different is a new question. Written for the automatic trigger (two identical dialogs
 * from one register answer, 2026-08-21); the trigger went on 2026-08-27 and nothing filters on the
 * record now, so this is the audit trail of what was offered and refused. See check-triggers.test.js.
 */
test('a proposal the requester turned down is recorded as declined', () => {
  const controller = loadController();
  const derivation = { target: 'root', index: 0, field: 'OrganizationBPName1', value: 'Alluvion BV', message: 'From GLEIF.' };
  const rows = controller._proposalRows.call(controller, [derivation], []);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].key, 'a row carries the identity a decline is remembered against');
  assert.equal(controller._isDeclined.call(controller, rows[0]), false, 'nothing declined yet');

  // Not Now: everything in the dialog was declined.
  controller._rememberDeclined.call(controller, rows, false);

  // The second check derives the same thing from the same register answer, so it is silent.
  const again = controller._proposalRows.call(controller, [derivation], []);
  assert.equal(controller._isDeclined.call(controller, again[0]), true);
});

// Keyed on the proposal, not on the payload: the register answering something DIFFERENT is a new
// question and a decline must not swallow it.
test('a different proposed value, or a different field, is still asked', () => {
  const controller = loadController();
  const first = controller._proposalRows.call(
    controller, [{ target: 'root', index: 0, field: 'OrganizationBPName1', value: 'Alluvion BV' }], []
  );
  controller._rememberDeclined.call(controller, first, false);

  const changed = controller._proposalRows.call(
    controller, [{ target: 'root', index: 0, field: 'OrganizationBPName1', value: 'Alluvion NV' }], []
  );
  assert.equal(controller._isDeclined.call(controller, changed[0]), false, 'a new value is a new question');

  const other = controller._proposalRows.call(
    controller, [{ target: 'Addresses', index: 0, field: 'CityName', value: 'Gent' }], []
  );
  assert.equal(controller._isDeclined.call(controller, other[0]), false, 'and another field is untouched');
});

// After Apply Selected the unticked rows are declines too - unticking one is deliberate - while an
// applied row is not remembered as refused.
test('unticking is a decline, applying is not', () => {
  const controller = loadController();
  const rows = controller._proposalRows.call(
    controller,
    [
      { target: 'root', index: 0, field: 'OrganizationBPName1', value: 'Alluvion BV' },
      { target: 'Addresses', index: 0, field: 'CityName', value: 'Gent' }
    ],
    []
  );
  rows[0].accepted = true;
  rows[1].accepted = false;
  controller._rememberDeclined.call(controller, rows, true);
  assert.equal(controller._isDeclined.call(controller, rows[0]), false, 'the applied one is not refused');
  assert.equal(controller._isDeclined.call(controller, rows[1]), true, 'the unticked one is');
});

/**
 * The key is stamped when the row is built, not read off it later: `proposed` is two-way bound to an
 * editable Input, so a requester who edits the value and then declines must not have the decline
 * recorded against what they typed.
 */
test('the key is the value that was proposed, not the value that was typed over it', () => {
  const controller = loadController();
  const rows = controller._proposalRows.call(
    controller, [{ target: 'root', index: 0, field: 'OrganizationBPName1', value: 'Alluvion BV' }], []
  );
  const stamped = rows[0].key;
  rows[0].proposed = 'Something Else Entirely';
  assert.equal(rows[0].key, stamped, 'editing the cell does not move the key');
});

// --- The message area collapses ----------------------------------------------------------------

test('the message area is a panel whose header carries the leading message', () => {
  const controller = loadController();
  assert.equal(controller.messagesHeader([]), '');
  assert.equal(
    controller.messagesHeader([{ type: 'Information', text: 'Current step: Approval - with a@b.eu' }]),
    'Current step: Approval - with a@b.eu'
  );
  // The rest are counted, not concatenated: a panel header is one line.
  assert.equal(
    controller.messagesHeader([
      { type: 'Warning', text: 'Sent back by the approver: wrong VAT number' },
      { type: 'Information', text: 'Current step: Rework' }
    ]),
    'Sent back by the approver: wrong VAT number (+1 more)'
  );
});

test('a long message is elided rather than wrapped out of the header', () => {
  const controller = loadController();
  const header = controller.messagesHeader([{ type: 'Error', text: 'x'.repeat(400) }]);
  assert.ok(header.length < 130, `header was ${header.length} characters`);
  assert.match(header, /…$/u);
});

test('newlines in a message do not break the one-line header', () => {
  const controller = loadController();
  assert.equal(
    controller.messagesHeader([{ type: 'Error', text: 'Enter a Country.\n  Enter a City.' }]),
    'Enter a Country. Enter a City.'
  );
});

// A blocked submit or a rejection reason is not something to make somebody click for.
test('anything above Information opens the panel by itself', () => {
  const controller = loadController();
  assert.equal(controller.messagesNeedAttention([{ type: 'Error', text: 'x' }]), true);
  assert.equal(controller.messagesNeedAttention([{ type: 'Warning', text: 'x' }]), true);
  assert.equal(controller.messagesNeedAttention([{ type: 'Success', text: 'x' }]), true);
  assert.equal(controller.messagesNeedAttention([
    { type: 'Information', text: 'x' },
    { type: 'Warning', text: 'y' }
  ]), true);
});

// Which is the case this panel exists for: the processors strip and the read-only note.
test('an information-only set stays out of the way', () => {
  const controller = loadController();
  assert.equal(controller.messagesNeedAttention([
    { type: 'Information', text: 'Current step: Approval' },
    { type: 'Information', text: 'Shown read-only.' }
  ]), false);
  assert.equal(controller.messagesNeedAttention([]), false);
  assert.equal(controller.messagesNeedAttention(), false);
});

test('the panel is wired to those two formatters, and still holds the strips', () => {
  assert.match(view, /id="maintenanceMessagePanel"/u);
  assert.match(view, /expanded="\{ path: 'maintenance>\/messages', formatter: '\.messagesNeedAttention' \}"/u);
  assert.match(view, /headerText="\{ path: 'maintenance>\/messages', formatter: '\.messagesHeader' \}"/u);
  // The strips themselves are unchanged, inside the panel now.
  assert.match(view, /id="maintenanceMessages"[\s\S]{0,200}<MessageStrip/u);
});

// --- The findings follow the request ------------------------------------------------------------

// Written at submit and never read back, so an approver opening the task saw nothing - which is
// indistinguishable from "no duplicate was found".
test('the approve screen fills the duplicate panel from the request own findings', () => {
  assert.match(
    controllerSource,
    /this\._setDuplicatePanel\(state, this\._parseJsonArray\(payload && payload\.FindingsJson\)\)/u
  );
});

test('a persisted finding renders without the candidate name staging never stored', () => {
  const controller = loadController();
  const state = { duplicates: [], duplicatesHeader: '' };
  // The shape CheckFindings actually holds: no candidateName column exists.
  controller._setDuplicatePanel.call(controller, state, [
    { verdict: 'duplicate', candidateBP: '4711', message: 'Duplicate: Business Partner 4711 matches on TaxNumber.' }
  ]);
  assert.equal(state.duplicates.length, 1);
  assert.equal(state.duplicates[0].title, '4711');
  assert.match(state.duplicates[0].description, /matches on TaxNumber/u);
  assert.match(state.duplicatesHeader, /1 possible duplicate/u);
});

// --- The read-only full name ------------------------------------------------------------------

// S/4 derives it and refuses to be told it, so nothing fills the field until the partner exists.
test('a committed name field recomposes the read-only full name', () => {
  const source = controllerSource;
  assert.match(
    source,
    /section\.kind === "root" && NAME_FIELDS\.indexOf\(field\.name\) !== -1/u
  );
  assert.match(source, /this\._refreshFullName\(true\);/u);
  // And a request that arrives without one gets it: staging has no such column.
  assert.match(source, /this\._refreshFullName\(\);/u);
});

// On a partner read from S/4 that value is S/4's own derivation; replacing it with a composition
// would show something S/4 does not say.
test('an existing value is only recomposed when a name was actually edited', () => {
  assert.match(
    controllerSource,
    /if \(!recompose && String\(root\.BusinessPartnerFullName \|\| ""\)\.trim\(\)\) return;/u
  );
});

// Reported 2026-08-27: typing "Test", then accepting a VIES-proposed "Alluvion BV", left the
// read-only full name reading "Test". Accepting a proposal writes straight into state.root and
// never fires _onFieldCommitted, which was the only thing recomposing the name.
test('a name accepted from a proposal recomposes the full name, as typing it would', () => {
  const controller = loadController();
  const state = {
    root: {
      BusinessPartnerCategory: '2',
      OrganizationBPName1: 'Test',
      BusinessPartnerFullName: 'Test'
    },
    sections: {},
    duplicates: [],
    duplicatesHeader: ''
  };
  const model = { getData: function () { return state; }, refresh: function () {} };
  controller._updatePreview = function () {};
  controller._renderAll = function () {};
  controller.getView = function () { return { getModel: function () { return model; } }; };

  controller._applyProposals.call(controller, [{
    target: 'root', index: 0, field: 'OrganizationBPName1',
    current: 'Test', proposed: 'Alluvion BV', accepted: true
  }]);

  assert.equal(state.root.OrganizationBPName1, 'Alluvion BV');
  assert.equal(state.root.BusinessPartnerFullName, 'Alluvion BV', 'the full name followed the name');
});

// A proposal on any other field must not touch it: on a partner read from S/4 that value is S/4's
// own derivation, and recomposing would show something S/4 does not say.
test('a proposal on a field that is not a name leaves the full name alone', () => {
  const controller = loadController();
  const state = {
    root: {
      BusinessPartnerCategory: '2',
      OrganizationBPName1: 'Alluvion',
      BusinessPartnerFullName: 'Alluvion BV (S/4 derived)',
      SearchTerm1: 'old'
    },
    sections: {},
    duplicates: [],
    duplicatesHeader: ''
  };
  const model = { getData: function () { return state; }, refresh: function () {} };
  controller._updatePreview = function () {};
  controller._renderAll = function () {};
  controller.getView = function () { return { getModel: function () { return model; } }; };

  controller._applyProposals.call(controller, [{
    target: 'root', index: 0, field: 'SearchTerm1',
    current: 'old', proposed: 'ALLUVION', accepted: true
  }]);

  assert.equal(state.root.SearchTerm1, 'ALLUVION');
  assert.equal(state.root.BusinessPartnerFullName, 'Alluvion BV (S/4 derived)');
});

test('the additional fields dialog recomposes only when it changed a name', () => {
  // Guarded rather than unconditional: the dialog holds root fields that are not names, and
  // recomposing on every Apply would overwrite an S/4-derived name.
  assert.match(
    controllerSource,
    /var renamed = NAME_FIELDS\.some\(function \(field\) \{[\s\S]*?\(field in record\) && record\[field\] !== state\.root\[field\]/u
  );
  assert.match(controllerSource, /Object\.assign\(state\.root, record\);\s*\n\s*if \(renamed\) this\._refreshFullName\(true\);/u);
});
