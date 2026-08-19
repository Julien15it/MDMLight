'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'businesspartner', 'webapp');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const staging = read(ROOT, 'db', 'staging.cds');
const serviceCds = read(ROOT, 'srv', 'change-request-service.cds');
const serviceJs = read(ROOT, 'srv', 'change-request-service.js');
const partnerJs = read(ROOT, 'srv', 'business-partner-service.js');
const controller = read(APP, 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js');
const view = read(APP, 'ext', 'view', 'BusinessPartnerMaintenance.view.xml');
const manifest = JSON.parse(read(APP, 'manifest.json'));

const {
  EDITABLE_STATUSES, WITHDRAWABLE_STATUSES, RESUBMITTED_SIGNAL, WITHDRAWN_SIGNAL, reworkUrl
} =
  require('../srv/change-request-service')._internals;
const { ACTIVE_REQUEST_STATUSES } = require('../srv/business-partner-service')._internals;

// --- The lifecycle ---------------------------------------------------------------------

/**
 * A rejection is a loop, not an end. This is the change the whole feature rests on, so it is pinned
 * at the model and at the handler: `rejected` stays in the enum because cds-deploy refuses to drop
 * it, but nothing writes it any more.
 */
test('a rejection hands the request back instead of ending it', () => {
  assert.match(staging, /reworkRequired/u);
  const decide = serviceJs.slice(serviceJs.indexOf("this.on('decideRequest'"));
  const reject = decide.slice(decide.indexOf("if (decision === 'reject')"), decide.indexOf('// Approved'));
  assert.match(reject, /status: 'reworkRequired'/u);
  assert.equal(/status: 'rejected'/u.test(reject), false, 'rejected is no longer written');
  // The instance stays parked: resubmit hands the request back to it rather than starting a new one.
  assert.match(reject, /notifyWorkflow\('rejected'\)/u);
});

/**
 * The approver's comment must not land on the requester's `reason`. It was harmless while a
 * rejection was terminal; now the requester reopens this record, and would find their own
 * justification replaced by the verdict on it - then resubmit the approver's words as their reason.
 */
test('the rejection comment is kept apart from the requester reason', () => {
  assert.match(staging, /rejectionComment\s*:\s*String\(250\)/u);
  const decide = serviceJs.slice(serviceJs.indexOf("this.on('decideRequest'"));
  const reject = decide.slice(decide.indexOf("if (decision === 'reject')"), decide.indexOf('// Approved'));
  assert.match(reject, /rejectionComment: req\.data\.Comment/u);
  assert.equal(/reason: req\.data\.Comment/u.test(reject), false, 'reason is not overwritten');
  // And it reaches the screen, because "rejected" with no reason is not actionable.
  assert.match(serviceCds, /RejectionComment : String\(250\)/u);
  assert.match(serviceJs, /RejectionComment: header\.rejectionComment/u);
});

// String(12) could not hold 'reworkRequired'. Widening a string is one of the few non-lossy changes
// cds-deploy performs; renaming or dropping the old value would have failed the deploy.
test('the status column was widened rather than renamed', () => {
  assert.match(staging, /type ChangeRequestStatus : String\(20\) enum/u);
  assert.match(staging, /draft; inApproval; approved; rejected; reworkRequired; posted; failed/u);
  assert.equal(/Status\s+: String\(12\)/u.test(serviceCds), false, 'the action returns were widened too');
  assert.ok('reworkRequired'.length <= 20);
});

// The guard that decides whether rework is possible at all. It was draft-only.
test('a request awaiting rework is editable, and nothing further along is', () => {
  assert.deepEqual(EDITABLE_STATUSES, ['draft', 'reworkRequired']);
  assert.match(serviceJs, /if \(!EDITABLE_STATUSES\.includes\(existing\.status\)\)/u);
  for (const closed of ['inApproval', 'approved', 'posted', 'failed', 'rejected']) {
    assert.equal(EDITABLE_STATUSES.includes(closed), false, `${closed} is not editable`);
  }
});

/**
 * It looks finished - the approver said no - but the requester is about to edit and resubmit it, so
 * the partner is still claimed. Leaving it out would unlock the partner for a second editor
 * mid-rework, which is exactly what this list exists to prevent.
 */
test('a partner in rework stays locked against a second editor', () => {
  assert.ok(ACTIVE_REQUEST_STATUSES.includes('reworkRequired'));
  assert.equal(ACTIVE_REQUEST_STATUSES.includes('posted'), false);
});

// --- Resubmit --------------------------------------------------------------------------

/**
 * A reworked request is one nobody has judged, and the requester may have changed the very fields
 * the duplicate check reads - so every gate a first submit runs, runs again.
 */
test('resubmit runs the same gates as a first submit', () => {
  const resubmit = serviceJs.slice(
    serviceJs.indexOf("this.on('resubmitRequest'"),
    serviceJs.indexOf("this.on('withdrawRequest'")
  );
  assert.match(resubmit, /runValidations\(/u);
  assert.match(resubmit, /configured\.validations, \.\.\.registry\.validations/u);
  assert.match(resubmit, /recordDuplicateFindings\(/u);
  assert.match(resubmit, /!req\.data\.Confirm/u);
  // Derivations still do not run on a submit path - a derivation changes the data.
  assert.equal(/configured\.derivations|runDerivations/u.test(resubmit), false);
});

/**
 * The payload shape Arthur specified on 2026-08-19:
 *
 *   { executionId: "<process instance>", inputs: { result: "Resubmitted", ...bp data } }
 *
 * The BP data is **flat inside `inputs`, next to `result`** - not nested under a key - which is why
 * the trigger spreads its third argument.
 */
test('the resubmit signal carries the BP context flat inside inputs', () => {
  const wf = read(ROOT, 'srv', 'wf', 'processAutomation.js');
  assert.match(wf, /async function sendTrigger\(triggerId, label, executionId, result, extraInputs = \{\}\)/u);
  assert.match(wf, /inputs: \{ result, \.\.\.extraInputs \}/u);
  // executionId is the process instance, not the change request UUID. Arthur calls it the CR id;
  // swapping the two would leave the trigger unable to resolve the parked instance.
  assert.match(wf, /executionId,/u);
  const resubmit = serviceJs.slice(
    serviceJs.indexOf("this.on('resubmitRequest'"),
    serviceJs.indexOf("this.on('withdrawRequest'")
  );
  assert.match(resubmit, /triggerRequesterCallback\(before\.processInstanceId, RESUBMITTED_SIGNAL, context\)/u);
  // His spelling, capitalised, unlike approved/rejected. A signal that does not match leaves the
  // request parked forever, so this is pinned rather than tidied.
  assert.equal(RESUBMITTED_SIGNAL, 'Resubmitted');
});

/**
 * One builder for both paths. Two copies of this object would drift the first time one grew a key,
 * and the approver would be shown a different shape depending on which route the request took.
 */
test('submit and resubmit send the same BP context, built once', () => {
  assert.match(serviceJs, /const workflowContext = async \(req, changeRequest, header, findings\)/u);
  assert.equal((serviceJs.match(/await workflowContext\(/gu) || []).length, 2, 'both paths use it');
  // The context literal exists in exactly one place.
  assert.equal((serviceJs.match(/changerequestid:/gu) || []).length, 1);
  for (const key of ['businesspartnerinput', 'bpduplicates', 'bpurl', 'reworkurl', 'requesttype']) {
    assert.match(serviceJs, new RegExp(`${key}:`, 'u'), `${key} is in the context`);
  }
});

/**
 * The reason the rebuild is ordered, not incidental: `before` is the pre-rework header, so sending
 * its data would hand the approver exactly the version they had already rejected.
 */
test('the resubmit context is rebuilt after the edits, not before', () => {
  const resubmit = serviceJs.slice(
    serviceJs.indexOf("this.on('resubmitRequest'"),
    serviceJs.indexOf("this.on('withdrawRequest'")
  );
  const persistAt = resubmit.indexOf('await persist(req)');
  const contextAt = resubmit.indexOf('await workflowContext(');
  const signalAt = resubmit.indexOf('triggerRequesterCallback');
  assert.ok(persistAt < contextAt, 'the payload is saved before the context is built');
  assert.ok(contextAt < signalAt, 'and the context is built before it is sent');
  // Built from a fresh read, not from the header fetched before the guard.
  assert.match(resubmit.slice(persistAt, contextAt), /SELECT\.one\.from\(HEADER\)/u);
});

/**
 * Two triggers, and which one a signal goes to is the contract. Arthur gave `requesterCallBack` for
 * the requester's actions on 2026-08-19; approve and reject stay on the approver's `zApproved_wf`.
 * Sending one down the other's trigger reaches a process step that is not waiting for it.
 */
test('the requester actions use their own trigger, the approver actions keep theirs', () => {
  const wf = read(ROOT, 'srv', 'wf', 'processAutomation.js');
  assert.match(wf, /REQUESTER_CALLBACK_TRIGGER_ID = "eu10\.alluvion-dev-cf\.mdmlightapproval\.requesterCallBack"/u);
  assert.match(wf, /APPROVAL_DECISION_TRIGGER_ID = "eu10\.alluvion-dev-cf\.mdmlightapproval\.zApproved_wf"/u);
  // The host stays with the destination. Writing the gateway in here would bypass the proxy and the
  // token that `sbpa-destination` provides.
  assert.equal(/spa-api-gateway/u.test(wf), false, 'the gateway host is not hardcoded');
  assert.match(wf, /path: `\/unified\/v1\/triggers\/api\/\$\{triggerId\}\?environmentId=bpapprovalpoc`/u);
  // Approve and reject are untouched by the rework work.
  for (const call of ["notifyWorkflow('rejected')", "notifyWorkflow('approved')"]) {
    assert.ok(serviceJs.includes(call), `${call} is unchanged`);
  }
  assert.match(serviceJs, /triggerApprovalDecision\(header\.processInstanceId, workflowResult\)/u);
  // Following his `Resubmitted` convention, not his instruction - he never specified this one.
  assert.equal(WITHDRAWN_SIGNAL, 'Withdrawn');
  assert.equal(RESUBMITTED_SIGNAL, 'Resubmitted');
});

/** Resume, not restart: one instance per request means one audit thread on Arthur's side. */
test('resubmit signals the parked instance and never starts a new one', () => {
  const resubmit = serviceJs.slice(
    serviceJs.indexOf("this.on('resubmitRequest'"),
    serviceJs.indexOf("this.on('withdrawRequest'")
  );
  // The call shape and the signal value are pinned by "the resubmit signal carries the BP context
  // flat inside inputs" - this test is about the instance being reused rather than replaced.
  assert.equal(/startWorkflow/u.test(resubmit), false, 'no second workflow for one request');
  // No parked instance means nothing to hand back to. Starting one silently would give the request
  // two audit threads and possibly two approver tasks.
  assert.match(resubmit, /if \(!before\.processInstanceId\)/u);
  // Only from rework: a resubmit of anything else is a status error, not a second submit.
  assert.match(resubmit, /before\.status !== 'reworkRequired'/u);
});

// Same reasoning as a failed start leaving a submit in `draft`: a request in `inApproval` that no
// process is waiting on sits in nobody's inbox, and the requester could not try again.
test('a failed signal leaves the request reworkable rather than stranded', () => {
  const resubmit = serviceJs.slice(
    serviceJs.indexOf("this.on('resubmitRequest'"),
    serviceJs.indexOf("this.on('withdrawRequest'")
  );
  const signalAt = resubmit.indexOf('triggerRequesterCallback');
  const statusAt = resubmit.indexOf("status: 'inApproval'");
  assert.ok(signalAt < statusAt, 'the signal is sent before the status moves');
  assert.match(resubmit.slice(signalAt, statusAt), /req\.reject\(502/u);
});

// --- Withdraw --------------------------------------------------------------------------

test('withdraw deletes the request and everything staged on it', () => {
  const withdraw = serviceJs.slice(serviceJs.indexOf("this.on('withdrawRequest'"));
  assert.match(withdraw, /for \(const node of Object\.values\(NODES\)\)/u);
  assert.match(withdraw, /DELETE\.from\(GENERAL\)/u);
  assert.match(withdraw, /DELETE\.from\(FINDINGS\)/u);
  assert.match(withdraw, /DELETE\.from\(HEADER\)/u);
  assert.match(serviceCds, /action withdrawRequest\(/u);
});

/**
 * The guard that must never be relaxed: deleting a posted request destroys `postedBP`, and an SPA
 * retry would then create a second business partner for the same request.
 */
test('a request that has already posted can never be withdrawn', () => {
  const withdraw = serviceJs.slice(serviceJs.indexOf("this.on('withdrawRequest'"));
  assert.match(withdraw, /if \(header\.postedBP\)/u);
  const postedAt = withdraw.indexOf('header.postedBP');
  const deleteAt = withdraw.indexOf('DELETE.from(HEADER)');
  assert.ok(postedAt < deleteAt, 'the guard is checked before anything is deleted');
  assert.deepEqual(WITHDRAWABLE_STATUSES, EDITABLE_STATUSES);
  for (const closed of ['inApproval', 'approved', 'posted', 'failed']) {
    assert.equal(WITHDRAWABLE_STATUSES.includes(closed), false, `${closed} is not withdrawable`);
  }
});

// Idempotent rather than a 404: a double press or a retried call is not an error to interpret.
test('withdrawing an already-deleted request is not an error', () => {
  const withdraw = serviceJs.slice(serviceJs.indexOf("this.on('withdrawRequest'"));
  assert.match(withdraw, /if \(!header\) return \{ ChangeRequest: changeRequest, Deleted: false \}/u);
});

// A BPA outage must not stop a requester withdrawing their own request, but the failure is surfaced
// rather than swallowed - an open approver task may be left needing a human.
test('withdraw tells the process, best-effort, and says so when it could not', () => {
  const withdraw = serviceJs.slice(serviceJs.indexOf("this.on('withdrawRequest'"));
  assert.match(withdraw, /triggerRequesterCallback\(header\.processInstanceId, WITHDRAWN_SIGNAL/u);
  assert.match(withdraw, /req\.info\(200,/u);
  const signalAt = withdraw.indexOf('triggerRequesterCallback');
  assert.ok(signalAt < withdraw.indexOf('DELETE.from(HEADER)'));
});

// --- The screen ------------------------------------------------------------------------

// The change request list is steward-gated, so the deep link is the requester's only way in.
test('rework is reachable by its own route and by nothing else', () => {
  const route = manifest['sap.ui5'].routing.routes.find((entry) => entry.name === 'ChangeRequestRework');
  assert.ok(route, 'the route exists');
  assert.equal(route.pattern, 'ChangeRequests/{changeRequest}/rework');
  assert.equal(route.target, 'BusinessPartnerMaintenance');
  assert.match(controller, /getRoute\("ChangeRequestRework"\)\.attachPatternMatched\(this\._onReworkRoute/u);
  // Sent with the initial context, because SPA owns the rejection branch.
  assert.match(serviceJs, /reworkurl: reworkUrl\(changeRequest\)/u);
  assert.match(reworkUrl('abc'), /^$|#ChangeRequests\/abc\/rework$/u);
});

/** The draft view with a different primary action - that is the whole design of this screen. */
test('rework is the draft view with Resubmit in place of Submit', () => {
  const load = controller.slice(controller.indexOf('_loadStagedRequest: async function'));
  const head = load.slice(0, load.indexOf('maintenanceModel.setData(state)'));
  assert.match(head, /state\.saveButtonText = reworking \? "Resubmit" : "Submit Request"/u);
  assert.match(head, /state\.showSaveButton = editing/u);
  assert.match(controller, /if \(state\.mode === "rework"\)\s*\{\s*return this\._sendChangeRequest\("resubmitRequest"\)/u);
  // Check stays: the requester has to be able to ask whether the record will pass on resubmit.
  assert.match(head, /state\.showCheckButton = reworking/u);
});

/**
 * Save Request would drop the screen out of editing and offer Edit, which re-enters "edit" mode -
 * and onSave would then route to submitRequest, starting a second workflow for a request whose own
 * instance is still parked.
 */
test('rework offers no Save Request', () => {
  const load = controller.slice(controller.indexOf('_loadStagedRequest: async function'));
  const head = load.slice(0, load.indexOf('maintenanceModel.setData(state)'));
  assert.match(head, /state\.showSaveRequestButton = editing && !reworking/u);
});

test('withdraw is confirmed, and the confirmation says it cannot be undone', () => {
  assert.match(view, /text="Withdraw"[\s\S]{0,160}press="\.onWithdraw"/u);
  assert.match(view, /visible="\{maintenance>\/showReworkButtons\}"/u);
  const withdraw = controller.slice(controller.indexOf('onWithdraw: function'));
  assert.match(withdraw.slice(0, withdraw.indexOf('_withdraw: ')), /cannot be undone/u);
  assert.match(withdraw, /MessageBox\.Action\.DELETE/u);
  // Cancel is emphasized, not the destructive action.
  assert.match(withdraw, /emphasizedAction: MessageBox\.Action\.CANCEL/u);
});

/**
 * The link outlives the state it was sent for. A requester who already resubmitted, or whose request
 * someone else withdrew, must not be offered the buttons again - the same rule the approve view
 * follows for a task that has already been decided.
 */
test('a stale rework link offers nothing and says why', () => {
  const load = controller.slice(controller.indexOf('_loadStagedRequest: async function'));
  assert.match(load, /awaitingRework = state\.requestStatus === "reworkRequired"/u);
  assert.match(load, /state\.showReworkButtons = awaitingRework/u);
  assert.match(load, /state\.editing = awaitingRework/u);
  assert.match(load, /nothing to rework/u);
  // And why it came back is the first thing on screen when there is something to do.
  assert.match(load, /Sent back by the approver/u);
});

// Once it is back with the approver it is not the requester's to withdraw.
test('a resubmitted request stops offering Withdraw', () => {
  const send = controller.slice(controller.indexOf('_sendChangeRequest: async function'));
  assert.match(send, /state\.showReworkButtons = false/u);
  assert.match(send, /action === "resubmitRequest"\s*\n?\s*\? "Request resubmitted for approval"/u);
  // The duplicate gate's dialog names the action it will actually take.
  assert.match(send, /confirmText: action === "resubmitRequest" \? "Resubmit" : "Submit Request"/u);
  assert.match(send, /action === "submitRequest" \|\| action === "resubmitRequest"/u);
});
