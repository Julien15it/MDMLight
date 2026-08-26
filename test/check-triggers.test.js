'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalisableFields, proposeNormalisations } = require('../srv/checks/normalise');

const PAYLOAD = {
  root: { OrganizationBPName1: 'alluvion bv' },
  sections: {
    Addresses: [{ StreetName: 'koedreef 12', CityName: 'brasschaat', Country: 'be' }],
    TaxNumbers: [{ BPTaxNumber: 'BE0404616494' }]
  }
};

// A section trigger must ask the model about the section the requester just left, not the whole
// record: the point of scoping is fewer tokens and no proposals for untouched sections.
test('an unscoped call offers every populated field, a scoped one only its target', () => {
  const all = normalisableFields(PAYLOAD).map((f) => `${f.target}.${f.field}`);
  assert.ok(all.includes('root.OrganizationBPName1'));
  assert.ok(all.some((k) => k.startsWith('Addresses.')));

  const addresses = normalisableFields(PAYLOAD, 'Addresses');
  assert.ok(addresses.length > 0, 'the address fields are still offered');
  assert.ok(addresses.every((f) => f.target === 'Addresses'), 'and nothing else is');

  const root = normalisableFields(PAYLOAD, 'root');
  assert.ok(root.every((f) => f.target === 'root'));
});

// BankDetails is a real section id but carries nothing normalisable, so a trigger there is silent.
test('a scope that matches nothing offers nothing rather than falling back to everything', () => {
  assert.deepEqual(normalisableFields(PAYLOAD, 'BankDetails'), []);
  assert.deepEqual(normalisableFields(PAYLOAD, 'nonsense'), []);
});

// Country/Region casing is deterministic, so it survives an AI Core outage - but it must respect
// the scope too, or a name-section trigger would report an address field.
test('the deterministic proposals are scoped as well', async () => {
  const scoped = await proposeNormalisations({ payload: PAYLOAD, scope: 'root', env: {} });
  assert.ok(scoped.every((p) => p.target === 'root'), 'no address casing from a root trigger');

  const addresses = await proposeNormalisations({ payload: PAYLOAD, scope: 'Addresses', env: {} });
  assert.ok(addresses.some((p) => p.field === 'Country'), 'be -> BE is still proposed in scope');
});

// Propose:false is what a tax-number trigger sends: it wants the register, not an LLM call.
test('the action declares Propose and Scope, and the runner threads both', () => {
  const cds = fs.readFileSync(path.join(__dirname, '..', 'srv', 'change-request-service.cds'), 'utf8');
  const checkAction = cds.slice(cds.indexOf('action checkRequest('), cds.indexOf('action duplicateCheckRequest('));
  assert.match(checkAction, /Propose\s+:\s+Boolean/u);
  assert.match(checkAction, /Scope\s+:\s+String\(40\)/u);

  const js = fs.readFileSync(path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8');
  // Open at the end on purpose: the three parameters this test is about must be threaded, but the
  // runner has since gained others (`standard`, for the SAP standard checks) and pinning the
  // closing brace made an additive change read as a broken contract.
  assert.match(js, /runRequestChecks = async \(req, \{ propose, duplicates, scope = null[^}]*\}\)/u);
  // Matched loosely on purpose: what matters is that the payload and the scope reach
  // proposeNormalisations, not how the call is wrapped - it also carries the AI switch now.
  const proposeCall = js.slice(js.indexOf('proposeNormalisations({'));
  assert.match(proposeCall, /payload: derived/u);
  assert.match(proposeCall, /scope: scope \|\| null/u);
  // Omitting Propose must keep the button's behaviour: propose everything.
  assert.match(js, /propose: req\.data\.Propose !== false/u);
  // The duplicate check never proposes, trigger or not.
  assert.match(js, /runRequestChecks\(req, \{ propose: false, duplicates: true \}\)/u);

  // The SAP standard checks are the Check button's, and only for the whole record: a field trigger
  // passes a scope and must not pay for a remote round trip on every commit.
  assert.match(js, /standard: true/u);
  assert.match(js, /checkStandard: standard && !scope/u);
});

const CONTROLLER = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'controller',
    'BusinessPartnerMaintenance.controller.js'),
  'utf8'
);

// A tax number earns a register lookup on its own. Nothing else does - everything else waits for
// the requester to leave the scope, so one address block is one AI Core call, not four.
test('only the tax number triggers on its own, and it never asks for a proposal', () => {
  assert.match(CONTROLLER, /REGISTRY_TRIGGER_FIELDS = \{ BPTaxNumber: true \}/u);
  const handler = CONTROLLER.slice(
    CONTROLLER.indexOf('_onFieldCommitted: function'),
    CONTROLLER.indexOf('_flushPendingScope: function')
  );
  assert.match(handler, /_scheduleTrigger\(\{ propose: false, scope: null \}\)/u, 'register only');
  assert.match(handler, /section\.kind === "root" \? "root" : section\.id/u, 'scope is the section id');
});

// liveChange fires per keystroke; the trigger must hang off the committed value only.
test('the commit hook is a change handler on text inputs, not a liveChange', () => {
  assert.match(CONTROLLER, /if \(control instanceof Input\) this\._attachCommitTrigger\(/u);
  const attach = CONTROLLER.slice(
    CONTROLLER.indexOf('_attachCommitTrigger: function'),
    CONTROLLER.indexOf('_onFieldCommitted: function')
  );
  assert.match(attach, /control\.attachChange\(/u);
  assert.equal(/attachLiveChange/u.test(attach), false, 'never per keystroke');
});

// The requester is still typing: a trigger that popped a MessageBox or blocked the form would be
// worse than no trigger at all.
test('a triggered check is quiet, guarded and de-duplicated', () => {
  const run = CONTROLLER.slice(
    CONTROLLER.indexOf('_runTriggeredCheck: async function'),
    CONTROLLER.indexOf('onCheck: async function')
  );
  assert.equal(/MessageBox\.\w+\(/u.test(run), false, 'no modal from a trigger');
  assert.equal(/state\.busy = true/u.test(run), false, 'never blocks the form');
  assert.match(run, /if \(state\.busy \|\| this\._triggerInFlight\) return/u, 'one at a time');
  assert.match(run, /if \(key === this\._lastTriggerKey\) return/u, 'unchanged data costs nothing');
  assert.match(run, /Propose: options\.propose/u);
  assert.match(run, /Scope: options\.scope \|\| null/u);
  // Proposals go through the same vetted dialog, so nothing is written without a tick - and only
  // when there is something left to ask and nothing already being asked.
  assert.match(run, /if \(proposals\.length && !this\._proposalsOpen\) this\._offerProposals\(proposals\)/u);
  assert.equal(/_applyProposals/u.test(run), false, 'a trigger never applies anything itself');
  assert.match(run, /catch \(error\)[\s\S]{0,200}console\.warn/u, 'a failed trigger never interrupts');
});

/**
 * Check derived twice, reported 2026-08-19.
 *
 * The guard was one-directional: `_runTriggeredCheck` refused to start while `state.busy`, but
 * nothing stopped an already *scheduled* trigger from firing the moment the button released busy.
 * Commit a field, press Check inside TRIGGER_IDLE_MS, and the derivation ran twice - a second
 * proposals dialog for the same record.
 */
test('a button press cancels the trigger that was about to fire', () => {
  const cancel = CONTROLLER.slice(
    CONTROLLER.indexOf('_cancelPendingTrigger: function'),
    CONTROLLER.indexOf('_runTriggeredCheck: async function')
  );
  // Both timers, or the other one still fires. `_idleTimer` is the pending scope, `_triggerTimer`
  // the debounce after it flushes.
  assert.match(cancel, /clearTimeout\(this\._idleTimer\)/u);
  assert.match(cancel, /clearTimeout\(this\._triggerTimer\)/u);
  // And the scope, or the next commit in a different scope flushes this stale one.
  assert.match(cancel, /this\._pendingScope = null/u);
});

// Every button that runs a check of its own, not just Check - Duplicate Check asks the same
// question, and Save/Submit/Resubmit/Withdraw move the request past the point a trigger reports on.
test('every button that checks cancels the pending trigger first', () => {
  const heads = {
    'onCheck: async function': 'Check',
    'onDuplicateCheck: async function': 'Duplicate Check',
    '_sendChangeRequest: async function': 'Save/Submit/Resubmit',
    '_withdraw: async function': 'Withdraw'
  };
  for (const [entry, label] of Object.entries(heads)) {
    const at = CONTROLLER.indexOf(entry);
    assert.ok(at > 0, `${label} exists`);
    // Comment lines are stripped first: onCheck explains this very ordering in a comment that
    // contains the word "return", and a naive search matches that ahead of the statement.
    const head = CONTROLLER.slice(at, at + 600)
      .split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');
    assert.match(head, /this\._cancelPendingTrigger\(\)/u, `${label} cancels the pending trigger`);
    const cancelAt = head.indexOf('_cancelPendingTrigger');
    const returnAt = head.search(/\breturn\b/u);
    if (returnAt > -1) {
      assert.ok(cancelAt < returnAt, `${label} cancels before it can return early`);
    }
  }
});

/**
 * Cancelling timers cannot help a trigger that is already mid-flight, and the busy check happens
 * before the await - so a button pressed *during* a trigger would still have produced two dialogs.
 * The counter is what closes that half: an explicit press is the answer the requester asked for.
 */
test('a trigger overtaken by a button press drops its result', () => {
  const run = CONTROLLER.slice(
    CONTROLLER.indexOf('_runTriggeredCheck: async function'),
    CONTROLLER.indexOf('onCheck: async function')
  );
  assert.match(run, /var startedUnder = this\._buttonRun \|\| 0;/u);
  assert.match(run, /if \(startedUnder !== \(this\._buttonRun \|\| 0\)\) return;/u);
  // Dropped before anything reaches the screen: the strips and the proposals dialog both come after.
  const guardAt = run.indexOf('startedUnder !== ');
  assert.ok(guardAt > -1);
  assert.ok(guardAt < run.indexOf('state.messages = this._checkMessages'), 'before the strips');
  assert.ok(guardAt < run.indexOf('_offerProposals'), 'before the dialog');
  // The key is still recorded, so the wasted call is not repeated by the next identical commit.
  assert.ok(run.indexOf('this._lastTriggerKey = key') < guardAt);
});


/**
 * The same derivation was offered twice, reported 2026-08-21: fill in a name, press Add on Tax
 * Numbers, and "Not Now" had to be pressed on two identical dialogs.
 *
 * Both halves of the cause are real. Committing the name schedules a `root` check; opening Add
 * commits the tax number cell, which is a registry trigger field and schedules a second check with
 * no scope at all. `Scope` narrows only the normalisation proposals - derivations always run over
 * the whole payload - so both checks derive the same thing, and `_lastTriggerKey` cannot tell them
 * apart: it is keyed on the payload, which the new row changed.
 *
 * So the trigger filters what the requester has already turned down. What a decline means is
 * exercised in submit-messages.test.js, where the dialog's own tests live.
 */
test('a triggered check does not re-offer what was declined, or stack a second dialog', () => {
  const run = CONTROLLER.slice(
    CONTROLLER.indexOf('_runTriggeredCheck: async function'),
    CONTROLLER.indexOf('onCheck: async function')
  );
  assert.match(run, /\.filter\(function \(proposal\) \{ return !this\._isDeclined\(proposal\); \}, this\)/u);
  assert.match(run, /!this\._proposalsOpen/u, 'one dialog at a time');
});

/**
 * Only the automatic checks are silenced. "Declining is not ticking it, and the next Check proposes
 * it again" is the documented contract of this dialog, so every button clears the record - which is
 * exactly what `_cancelPendingTrigger` already runs for.
 */
test('pressing a button asks again, and a fresh record forgets', () => {
  const cancel = CONTROLLER.slice(CONTROLLER.indexOf('_cancelPendingTrigger: function'));
  assert.match(cancel.slice(0, cancel.indexOf('\n      },')), /this\._declinedProposals = \{\}/u);
  // A record leaving the screen takes its declines with it.
  const empty = CONTROLLER.slice(CONTROLLER.indexOf('_emptyState: function'));
  assert.match(empty.slice(0, empty.indexOf('return {')), /this\._declinedProposals = \{\}/u);
});

// Recorded on the way out rather than on the Not Now button: Escape closes the dialog too, and that
// is a decline as well.
test('every way out of the proposals dialog records what was not applied', () => {
  const offer = CONTROLLER.slice(CONTROLLER.indexOf('_offerProposals: function'));
  const body = offer.slice(0, offer.indexOf('_applyProposals: function'));
  assert.match(body, /afterClose: function \(\) \{[\s\S]{0,200}_rememberDeclined/u);
  assert.match(body, /applied = true;/u, 'Apply Selected says so, and afterClose reads it');
  assert.match(body, /this\._proposalsOpen = true;/u);
  assert.match(body, /this\._proposalsOpen = false;/u);
});
