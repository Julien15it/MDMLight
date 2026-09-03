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

// A scoped call must ask the model about that section only, not the whole record: the point of
// scoping is fewer tokens and no proposals for untouched sections.
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

// Country/Region casing is deterministic, so it survives an AI Core outage - but it must respect
// the scope too, or a root-scoped call would report an address field.
test('the deterministic proposals are scoped as well', async () => {
  const scoped = await proposeNormalisations({ payload: PAYLOAD, scope: 'root', env: {} });
  assert.ok(scoped.every((p) => p.target === 'root'), 'no address casing from a root-scoped call');

  const addresses = await proposeNormalisations({ payload: PAYLOAD, scope: 'Addresses', env: {} });
  assert.ok(addresses.some((p) => p.field === 'Country'), 'be -> BE is still proposed in scope');
});

// Propose and Scope outlive the trigger that used them: the duplicate check still sends
// Propose:false (it wants the register, not an LLM call), and Scope still narrows the
// normalisation proposals and keeps the SAP standard checks off a scoped call.
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
  // The duplicate check never proposes, whoever asked.
  assert.match(js, /runRequestChecks\(req, \{ propose: false, duplicates: true \}\)/u);

  // The SAP standard checks are the Check button's, and only for the whole record: a scoped call
  // must not pay for a remote round trip.
  assert.match(js, /standard: true/u);
  assert.match(js, /checkStandard: standard && !scope && stewardStep/u);
});

/**
 * The SAP standard checks moved to the data steward step (2026-09-01, asked for): "when a requestor
 * presses check or submit I don't want our standard S4 checks to be triggered, only in a Data
 * Steward step". Everything else about both buttons is unchanged - the validations, the derivations
 * and the proposals still run for a requester exactly as before.
 */
test('only the data steward step pays for the SAP standard checks', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8');
  assert.match(js, /const DATASTEWARD_ROLE = 'DataSteward';/u);
  // The screen's own role, not the narrowed one: `startsWith` so a specific "DataSteward Customer"
  // still gates them.
  assert.match(js, /const stewardStep = String\(req\.data\.Role \|\| ''\)\.startsWith\(DATASTEWARD_ROLE\)/u);

  // The screen names the step it is rendering, and the requester screen names Requester.
  assert.match(CONTROLLER, /state\.mode === "approve" \? "Approver" : \(state\.mode === "datasteward" \? "DataSteward" : "Requester"\)/u);
  // Every call that wants the standard findings sends it - the re-run after proposals included, or
  // it would refresh everything except the findings it exists for.
  const rerun = CONTROLLER.slice(CONTROLLER.indexOf('_rerunStandardChecks: async function'));
  assert.match(rerun.slice(0, rerun.indexOf('\n      },')), /Role: this\._checkRole\(state\)/u);
});

const CONTROLLER = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'controller',
    'BusinessPartnerMaintenance.controller.js'),
  'utf8'
);

/**
 * The automatic trigger is gone (2026-08-27, Maarten): "only trigger Derivations/Proposals after a
 * Check button was triggered. Now it's firing a lot when a user is typing because + or add buttons
 * trigger it as well."
 *
 * Every guard the trigger had worked as designed, and the feature was still wrong: opening a record
 * dialog COMMITS the cell behind it, so "+" and "Add" fired a check nobody asked for, mid-typing,
 * repeatedly. These tests pin the absence, because the machinery is easy to reintroduce by accident
 * -- a `setTimeout` in the commit hook is a one-line change.
 */
test('nothing schedules a check, and the trigger machinery is gone', () => {
  for (const gone of [
    'REGISTRY_TRIGGER_FIELDS', 'TRIGGER_DELAY_MS', 'TRIGGER_IDLE_MS',
    '_runTriggeredCheck', '_scheduleTrigger', '_flushPendingScope',
    '_triggerInFlight', '_lastTriggerKey', '_pendingScope', '_triggerTimer', '_idleTimer'
  ]) {
    assert.equal(CONTROLLER.includes(gone), false, `${gone} is gone`);
  }
});

// The commit hook is still there - it recomposes the full name and redraws the change summary - but
// it must not reach the server. A checkRequest from here is the bug, whatever debounce wraps it.
test('committing a field redraws locally and calls nothing', () => {
  const handler = CONTROLLER.slice(
    CONTROLLER.indexOf('_onFieldCommitted: function'),
    CONTROLLER.indexOf('_refreshFullName: function')
  );
  assert.ok(handler.length > 0, 'the commit hook still exists');
  assert.match(handler, /this\._refreshFullName\(true\)/u, 'the full name is recomposed');
  assert.match(handler, /this\._refreshChangeSummary\(\)/u, 'and the change summary redrawn');
  assert.equal(/_executeAction/u.test(handler), false, 'no server call');
  assert.equal(/checkRequest/u.test(handler), false, 'no check');
  assert.equal(/setTimeout/u.test(handler), false, 'nothing debounced either');
  assert.equal(/_offerProposals/u.test(handler), false, 'and no dialog while somebody is typing');
});

// Only the Check button and the pre-submit/approve check (_runPreActionCheck, 2026-08-31) ever open
// this dialog, and both go through the one vetted function: a derivation is still never written
// without a tick, and there is still exactly one place proposals reach the screen.
test('a proposal only ever reaches the screen through the one vetted dialog function', () => {
  // Two callers: onCheck calls it as `this.`, _runPreActionCheck as `self.` (it is inside a
  // `.then` callback where `this` is no longer the controller) - both are still calls, not a
  // second definition, so they are counted together.
  const offers = (CONTROLLER.match(/(?:this|self)\._offerProposals\(/gu) || []).length;
  assert.equal(offers, 2, 'onCheck, and the pre-submit/approve check');
  const check = CONTROLLER.slice(
    CONTROLLER.indexOf('onCheck: async function'),
    CONTROLLER.indexOf('onDuplicateCheck: async function')
  );
  // The second argument is the standard findings the dialog holds back for the duration -- see
  // _resolveStandardChecks.
  assert.match(check, /this\._offerProposals\(proposals, standard\)/u, 'and it is onCheck');
  assert.equal(/_applyProposals/u.test(check), false, 'onCheck never applies anything itself');

  const pre = CONTROLLER.slice(
    CONTROLLER.indexOf('_runPreActionCheck: function'), CONTROLLER.indexOf('onCheck: async function')
  );
  assert.match(
    pre,
    /self\._offerProposals\(proposals, standard, function \(effectiveStandard\) \{\s*resolve\(blockOnStandard\(effectiveStandard\)\);\s*\}\)/u
  );
  assert.equal(/_applyProposals/u.test(pre), false, 'it never applies anything itself either');
});

/**
 * Approve never opens the dialog even when a derivation finds something: nothing on that screen is
 * editable and decideRequest takes no DataJson, so an accepted proposal there would have nowhere to
 * go - see CLAUDE.md, "Derivations/Proposals... geblocked... in Approval stap". It still runs and
 * blocks on the SAME S/4 standard check though (2026-08-31, asked for) - skipping proposals is about
 * having nothing to apply one into, not a reason to let an S/4 objection through unchecked.
 */

// Submit/Resubmit and Approve run the same check the Check button does, from the button press
// itself - not while typing, not automatically - satisfying "automatisch de check nog eens wordt
// geactiveerd" without reopening the door the automatic trigger was removed through.
test('onSave and onApprove run the pre-action check before doing anything else', () => {
  const save = CONTROLLER.slice(
    CONTROLLER.indexOf('onSave: async function'), CONTROLLER.indexOf('_completeEmbeddedOutcome:')
  );
  assert.match(save, /this\._runPreActionCheck\(state, false\)/u);
  assert.match(save, /if \(!proceed\) return;/u);
  const checkAt = save.indexOf('_runPreActionCheck');
  const sendAt = save.indexOf('_sendChangeRequest(action)');
  assert.ok(checkAt > 0 && sendAt > checkAt, 'the check runs before the request is actually sent');

  const approve = CONTROLLER.slice(
    CONTROLLER.indexOf('onApprove: async function'), CONTROLLER.indexOf('onReject: function')
  );
  assert.match(approve, /this\._runPreActionCheck\(state, true\)/u);
  const approveCheckAt = approve.indexOf('_runPreActionCheck');
  const confirmAt = approve.indexOf('MessageBox.confirm(');
  assert.ok(approveCheckAt > 0 && confirmAt > approveCheckAt, 'checked before the confirm dialog even opens');
});

/**
 * `_cancelPendingTrigger` survives the machinery it was named for. There is no timer left to cancel;
 * what it does is empty the declined-proposal record, so pressing a check button asks again --
 * "declining is not ticking it, and the next Check proposes it again".
 */
test('every button that checks clears the declined proposals first', () => {
  const reset = CONTROLLER.slice(CONTROLLER.indexOf('_cancelPendingTrigger: function'));
  assert.match(reset.slice(0, reset.indexOf('\n      },')), /this\._declinedProposals = \{\}/u);

  const heads = {
    'onCheck: async function': 'Check',
    'onDuplicateCheck: async function': 'Duplicate Check',
    '_sendChangeRequest: async function': 'Save/Submit/Resubmit',
    '_withdraw: async function': 'Withdraw',
    // The pre-submit/approve check (2026-08-31) - onSave/onApprove call this before anything else,
    // so it is where the reset actually has to happen for those two buttons now.
    '_runPreActionCheck: function': 'Submit/Resubmit/Approve, via the pre-action check'
  };
  for (const [entry, label] of Object.entries(heads)) {
    const at = CONTROLLER.indexOf(entry);
    assert.ok(at > 0, `${label} exists`);
    // Comment lines are stripped first: onCheck explains this very ordering in a comment that
    // contains the word "return", and a naive search matches that ahead of the statement.
    const head = CONTROLLER.slice(at, at + 600)
      .split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');
    assert.match(head, /this\._cancelPendingTrigger\(\)/u, `${label} resets the declines`);
    const cancelAt = head.indexOf('_cancelPendingTrigger');
    const returnAt = head.search(/\breturn\b/u);
    if (returnAt > -1) {
      assert.ok(cancelAt < returnAt, `${label} resets before it can return early`);
    }
  }
});

// --- The S/4 standard check actually blocks Submit/Resubmit/Approve now (2026-08-31) --------------

/** Extracts a plain object-literal method (`name: function (...) {...}`) as a callable function -
 *  same technique as change-highlighting.test.js's extractMethod, for a method with no `this`. */
function extractMethod(source, name) {
  const label = name + ': function';
  const labelAt = source.indexOf(label);
  const fnStart = labelAt + name.length + 2;
  const braceStart = source.indexOf('{', fnStart);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const code = source.slice(fnStart, end);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + code + ')')();
}

/**
 * `runChecks` caps a standard finding at `warning`, never `error` (see bp-check.js's own
 * MAX_SEVERITY) - so gating on `severity === 'error'`, as the local ValidationsJson check does,
 * would never actually fire. `_standardBlocks` treats anything above `info` as blocking instead,
 * which is the practical threshold given that cap.
 */
test('_standardBlocks: a warning blocks, info does not, and an unreadable result blocks too', () => {
  const standardBlocks = extractMethod(CONTROLLER, '_standardBlocks');
  assert.equal(standardBlocks([]), false, 'nothing found is not a block');
  assert.equal(standardBlocks([{ severity: 'info', message: 'FYI' }]), false);
  assert.equal(standardBlocks([{ severity: 'warning', message: 'City is required' }]), true);
  assert.equal(standardBlocks([{ severity: 'error', message: 'should not occur, but still blocks' }]), true);
  // A re-run that failed reports `null` (see _rerunStandardChecks) - not an array, so it cannot be
  // read as "nothing found". A check that could not be confirmed must not read as one that passed.
  assert.equal(standardBlocks(null), true);
  assert.equal(standardBlocks(undefined), true);
});

/**
 * Reported live 2026-09-03: an approval was refused with "an error about a std address missing",
 * and the message the approver read listed every validation the check returned - warnings and info
 * among them - under "The data is not valid yet". The GATE was already right (the server sets
 * `Valid: false` only on `error`); it was the LIST that made a warning look like the blocker.
 */
test('the "not valid yet" dialog lists only what actually blocked', () => {
  const blockingReasons = extractMethod(CONTROLLER, '_blockingReasons');
  const mixed = [
    { severity: 'warning', message: 'No standard address is maintained.' },
    { severity: 'error', message: 'Enter a Business Partner category.' },
    { severity: 'info', message: 'VIES could not be reached.' }
  ];
  const listed = blockingReasons(mixed);
  assert.ok(listed.includes('Enter a Business Partner category.'));
  assert.equal(listed.includes('No standard address is maintained.'), false,
    'a warning must not be read out as the reason the approval was refused');
  assert.equal(listed.includes('VIES could not be reached.'), false);
});

// Should not happen - the server only blocks when an error is present - but an empty error box
// would leave the approver with a refusal and no reason at all.
test('a block with no error in the list still says something', () => {
  const blockingReasons = extractMethod(CONTROLLER, '_blockingReasons');
  for (const input of [[], null, undefined, [{ severity: 'warning', message: 'w' }]]) {
    assert.match(blockingReasons(input), /could not be completed/u);
  }
});

// One rule, three dialogs: the pre-action gate, Check and Duplicate Check all used to inline the
// same unfiltered map, which is how the same defect existed in three places.
test('every "not valid yet" dialog goes through the one filter', () => {
  const inlined = CONTROLLER.match(/not valid yet[^;]*validations\.map/gu) || [];
  assert.equal(inlined.length, 0, 'no dialog builds its own unfiltered list any more');
  assert.equal((CONTROLLER.match(/_blockingReasons\(validations\)/gu) || []).length, 3);
});

/**
 * The whole point of this feature: an S/4 warning that survives to the end (no proposal touched it,
 * or a re-run still reports it) stops the button's own action from ever being called - it is not
 * merely displayed as before.
 */
test('_runPreActionCheck resolves false, without proceeding, when S/4 still objects', () => {
  const fn = CONTROLLER.slice(CONTROLLER.indexOf('_runPreActionCheck: function'));
  const body = fn.slice(0, fn.indexOf('\n      },\n\n      onCheck'));
  // Checked in every branch: approve, no-proposals, and after the proposals dialog closes.
  assert.match(body, /if \(forApprove\) return blockOnStandard\(standard\);/u);
  assert.match(body, /if \(!proposals\.length\) return blockOnStandard\(standard\);/u);
  assert.match(body, /resolve\(blockOnStandard\(effectiveStandard\)\);/u);
});
