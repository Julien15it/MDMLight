'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'businesspartner', 'webapp');
const REUSE = path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const staging = read(ROOT, 'db', 'staging.cds');
const serviceCds = read(ROOT, 'srv', 'change-request-service.cds');
const serviceJs = read(ROOT, 'srv', 'change-request-service.js');
const partnerJs = read(ROOT, 'srv', 'business-partner-service.js');
const controller = read(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js');
const view = read(REUSE, 'view', 'BusinessPartnerMaintenance.view.xml');
const manifest = JSON.parse(read(APP, 'manifest.json'));

const {
  EDITABLE_STATUSES, WITHDRAWABLE_STATUSES, RESUBMITTED_SIGNAL, WITHDRAWN_SIGNAL, reworkUrl,
  rowAction, stateOfAction, UNTOUCHED
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

/**
 * A rework loop can run several rounds, and `rejectionComment`/`reason` only ever held the latest
 * side's word - which reads as amnesia the second time a request comes back. ChangeRequestComments
 * is the running thread underneath both: every decideRequest and resubmitRequest appends to it, and
 * neither legacy field's own behaviour changes (pinned above).
 */
test('every decision and resubmit appends to the running thread, not just the latest fields', () => {
  assert.match(staging, /entity ChangeRequestComments\s*:\s*cuid,\s*managed\s*\{/u);
  assert.match(staging, /role\s*:\s*String\(20\) enum \{ Requester; Approver; System; DataSteward \} not null/u);
  assert.match(staging, /comments\s*:\s*Composition of many ChangeRequestComments/u);
  assert.match(
    serviceCds, /@readonly entity ChangeRequestComments as projection on staging\.ChangeRequestComments/u
  );
  assert.match(serviceCds, /CommentsJson\s*:\s*LargeString/u);

  assert.match(serviceJs, /async function appendComment\(db, changeRequest, role, author, text\)/u);
  // Blank is not a message anyone sent.
  const appendFn = serviceJs.slice(
    serviceJs.indexOf('async function appendComment'), serviceJs.indexOf('async function appendComment') + 300
  );
  assert.match(appendFn, /if \(!trimmed\) return;/u);

  const decide = serviceJs.slice(
    serviceJs.indexOf("this.on('decideRequest'"), serviceJs.indexOf("this.on('completeRequest'")
  );
  const reject = decide.slice(decide.indexOf("if (decision === 'reject')"), decide.indexOf('// Approved'));
  assert.match(
    reject, /appendComment\(db, changeRequest, 'Approver', requestingUserEmail\(req\), req\.data\.Comment\)/u
  );
  const approve = decide.slice(decide.indexOf('// CAP decides finality itself'));
  assert.match(
    approve, /appendComment\(db, changeRequest, 'Approver', requestingUserEmail\(req\), req\.data\.Comment\)/u
  );

  const resubmit = serviceJs.slice(
    serviceJs.indexOf("this.on('resubmitRequest'"), serviceJs.indexOf("this.on('withdrawRequest'")
  );
  assert.match(
    resubmit, /appendComment\(db, changeRequest, 'Requester', requestingUserEmail\(req\), req\.data\.Reason\)/u
  );

  assert.match(serviceJs, /CommentsJson: JSON\.stringify\(comments\.map/u);
});

// Unlike the approver's box, this is NOT embedded-only: rework is reached standalone too, by the
// reworkurl deep link SPA sends on a rejection, and context>/comment does not exist there.
test('rework offers its own comment box, not the embedded-only approver one', () => {
  const box = view.slice(view.indexOf('id="reworkCommentBox"'), view.indexOf('id="reworkCommentBox"') + 400);
  assert.match(box, /visible="\{= \$\{maintenance>\/mode\} === 'rework' \}"/u);
  assert.match(box, /value="\{maintenance>\/reworkComment\}"/u);
  assert.equal(/env>\/embedded/u.test(box), false, 'not gated on embedded, unlike approverCommentBox');
});

// The guard that decides whether rework is possible at all. It was draft-only, then reworkRequired
// joined it, then checkAndEnrich for the same reason: a data steward mid-edit is editing a payload.
test('a request awaiting rework or data steward review is editable, and nothing further along is', () => {
  assert.deepEqual(EDITABLE_STATUSES, ['draft', 'reworkRequired', 'checkAndEnrich']);
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
  // Submit, resubmit and decideRequest's approve gate share one validation runner (2026-08-31) so
  // the three cannot drift on what "the check" means - the stage list itself is asserted once,
  // on that shared function, rather than once per caller.
  assert.match(resubmit, /runSubmitValidations\(/u);
  assert.match(resubmit, /recordDuplicateFindings\(/u);
  assert.match(resubmit, /!req\.data\.Confirm/u);
  // Derivations still do not run on a submit path - a derivation changes the data.
  assert.equal(/configured\.derivations|runDerivations/u.test(resubmit), false);

  const runner = serviceJs.slice(
    serviceJs.indexOf('const runSubmitValidations ='),
    serviceJs.indexOf("this.on('checkRequest'")
  );
  assert.match(runner, /runValidations\(/u);
  // node_required sits with the offline stages from 2026-08-28, between configured and the cached
  // CVI read - see quality-rules-page.test.js for why the order is what it is.
  assert.match(runner, /configured\.validations, \.\.\.nodeRequiredStages\.validations,\s*\.\.\.createCviStages\(\)\.validations, \.\.\.registry\.validations/u);
  assert.equal(/configured\.derivations|runDerivations/u.test(runner), false);
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
test('submit, resubmit and a data steward completing review send the same BP context, built once', () => {
  assert.match(serviceJs, /const workflowContext = async \(req, changeRequest, header, findings\)/u);
  // submitRequest, resubmitRequest, decideDataStewardReview's `complete` branch.
  assert.equal((serviceJs.match(/await workflowContext\(/gu) || []).length, 3, 'all three paths use it');
  // Scoped to the builder, not the whole file: withdraw also sends `changerequestid`, but as a
  // single field on its own signal rather than a second copy of the context.
  const builder = serviceJs.slice(
    serviceJs.indexOf('const workflowContext ='), serviceJs.indexOf('const persist =')
  );
  assert.equal((builder.match(/changerequestid:/gu) || []).length, 1, 'one context literal');
  for (const key of [
    'businesspartnerinput', 'bpduplicates', 'bpurl', 'reworkurl', 'datastewardurl', 'requesttype',
    'prefix', 'criticalfield'
  ]) {
    assert.match(builder, new RegExp(`${key}[,:]`, 'u'), `${key} is in the context`);
  }
  // Last key in the object, shorthand, no trailing comma - checked in its own test below.
  assert.match(builder, /\n\s*datastewards\n\s*\};/u, 'datastewards is in the context');
});

/**
 * `criticalfield` is a scalar 'X'/' ' flag, not a list - a marker for a data steward, not a gate:
 * CAP itself blocks or warns on nothing here. Best-effort like `approvers`: an unreadable profile
 * table leaves it ' ' rather than losing the submit. Lowercase on the wire like every other key in
 * this context; the local variable keeps its camelCase name for readability.
 */
test('criticalfield is X only when a critical entity was actually filled in on this request', () => {
  const builder = serviceJs.slice(
    serviceJs.indexOf('const workflowContext ='), serviceJs.indexOf('const persist =')
  );
  assert.match(builder, /let criticalField = ' ';/u);
  assert.match(builder, /const resolved = await resolvedProperties\(requesterContext\(req\)\);/u);
  assert.match(builder, /const critical = resolved\.criticalEntities \|\| \[\];/u);
  assert.match(builder, /if \(critical\.some\(\(section\) => sectionRows\(payload, section\)\.length > 0\)\) criticalField = 'X';/u);
  assert.match(builder, /catch \(error\) \{\s*console\.error\(`Could not resolve the critical fields/u);
  assert.match(builder, /criticalfield: criticalField,/u);
});

/**
 * `datastewards` is read straight from the BTP subaccount's role collections (srv/wf/data-stewards.js),
 * the same way `approvers` is fetched fresh at submit time - not through the WorkflowRules table.
 * Sent as the role collection NAMES since 2026-08-31 (reverted, same as `approvers`), not resolved
 * to member e-mails - SBPA resolves BTP role collection membership itself now.
 */
test('datastewards is fetched from BTP role collections, the same way approvers is fetched', () => {
  assert.match(serviceJs, /const \{ dataStewardEmails, dataStewardRoles \} = require\('\.\/wf\/data-stewards'\)/u);
  const builder = serviceJs.slice(
    serviceJs.indexOf('const workflowContext ='), serviceJs.indexOf('const persist =')
  );
  assert.match(builder, /const datastewards = await dataStewardRoles\(\);/u);
  assert.match(builder, /datastewards$/mu);
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
  // A rejection still signals the decision, and still through the approver's trigger.
  assert.ok(serviceJs.includes("notifyWorkflow('rejected')"), 'the rejection signal is unchanged');
  assert.match(serviceJs, /triggerApprovalDecision\(header\.processInstanceId, workflowResult\)/u);
  // An approve no longer does (changed 2026-08-25). It creates the business partner and the
  // instance is told the *outcome* through `waitForResult`, which is a different wait with a
  // different payload — see test/approve-posts.test.js. The `notifyWorkflow('approved')` this used
  // to pin lived in completeRequest, referencing a const declared inside the decideRequest handler,
  // so it threw a ReferenceError on every completion rather than signalling anything.
  assert.equal(serviceJs.includes("notifyWorkflow('approved')"), false);
  assert.match(wf, /POST_RESULT_TRIGGER_ID = "eu10\.alluvion-dev-cf\.mdmlightapproval\.waitForResult"/u);
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

/**
 * Reversed 2026-08-24: this used to be `req.reject(502)`, leaving a genuinely reworked, valid
 * request stuck at `reworkRequired` whenever the parked instance was not (or not yet) waiting on
 * this exact message - a BPA-side gap, not a problem with the data. Best-effort now, like
 * `withdrawRequest`'s own callback: the rework task itself completing (the PATCH
 * _completeEmbeddedOutcome sends once this action returns, carrying ContextJson as the task's
 * businesspartnerinput output) is what resumes the process, so a failed signal must not block it.
 */
test('a failed signal is logged and does not block the resubmit', () => {
  const resubmit = serviceJs.slice(
    serviceJs.indexOf("this.on('resubmitRequest'"),
    serviceJs.indexOf("this.on('withdrawRequest'")
  );
  const signalAt = resubmit.indexOf('triggerRequesterCallback');
  const statusAt = resubmit.indexOf("status: 'inApproval'");
  assert.ok(signalAt < statusAt, 'the signal is attempted before the status moves regardless');
  assert.match(resubmit.slice(signalAt, statusAt), /console\.error\(/u);
  assert.equal(
    /req\.reject\(502/u.test(resubmit), false,
    'a signal failure no longer blocks the resubmit'
  );
});

// --- The missing reject callback --------------------------------------------------------

/**
 * Arthur's rejection branch notifies the requester but does not call `decideRequest`, so the request
 * is still `inApproval` when the rework screen opens it and every gate downstream refuses. The
 * screen claims it instead, on the grounds that the `reworkurl` is only ever sent on a rejection.
 * Temporary by construction: delete this and the handler once the callback exists.
 */
test('a request the approver sent back is claimed out of inApproval', () => {
  assert.match(serviceCds, /action claimRework\(/u);
  const claim = serviceJs.slice(
    serviceJs.indexOf("this.on('claimRework'"), serviceJs.indexOf("this.on('withdrawRequest'")
  );
  assert.match(claim, /header\.status !== 'inApproval'/u);
  assert.match(claim, /status: 'reworkRequired'/u);
  // The process already took its rejection branch; a second decision is not one it waits for.
  assert.equal(/trigger(ApprovalDecision|RequesterCallback)/u.test(claim), false, 'no workflow signal');
});

/** Same guard as withdraw: a posted request has a business partner behind it, whatever the status. */

/** Only the rework route claims, and only when the status has not moved on its own. */

/** A rejection with no reason recorded is the normal case until the callback lands. */

/**
 * The 500 a resubmit threw on 2026-08-20, and it was never about the workflow: `action` is
 * `not null` on every staged node, and `rowAction` returned **null** for a row nobody had touched.
 * A first submit never noticed - every row carries `__state: 'new'` - but a resubmit reloads the
 * request from staging, where nothing carries `__state` at all, so the insert hit the constraint
 * before anything reached BPA. The same trap was waiting for a change request over untouched rows.
 */

/**
 * The half that the null was hiding. A resubmit reloads the request from staging, so without the
 * stored action coming back as `__state` every untouched row would restage as `N` - and an approved
 * resubmit would post a partner with no addresses, silently. `N` made the 500 go away; this is what
 * makes the round trip correct.
 */
test('a reloaded row remembers whether it was a create or an update', () => {
  assert.deepEqual(stateOfAction('C'), { __state: 'new' });
  assert.deepEqual(stateOfAction('U'), { __state: 'modified' });
  // Untouched and deleted rows need no state: N restages as N, and D is handed back through
  // `deleted` and restaged as D whatever it carries.
  assert.deepEqual(stateOfAction('N'), {});
  assert.deepEqual(stateOfAction(null), {});
  assert.deepEqual(stateOfAction('D'), {});
  // And the round trip is closed: what comes back out stages as what went in.
  for (const action of ['C', 'U']) {
    assert.equal(rowAction(stateOfAction(action)), action, `${action} survives a reload`);
  }
  assert.equal(rowAction(stateOfAction('N')), UNTOUCHED);
  const payload = serviceJs.slice(serviceJs.indexOf("this.on('getRequestPayload'"));
  assert.match(payload, /\.\.\.rest, \.\.\.stateOfAction\(action\)/u);
});

/** N means the same as the old null: staged so the approver sees the whole partner, never replayed. */

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
  // Attached from the route table in onInit, which skips a route its host does not declare - the
  // task app routes two of the six, the partner app all of them.
  assert.match(controller, /\["ChangeRequestRework", this\._onReworkRoute\]/u);
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
  // The if/else-per-mode shape gave way to one ternary computing `action` when the pre-submit
  // check (2026-08-31) needed a single place to run before whichever action gets sent - rework
  // still resolves to resubmitRequest, just no longer through its own branch.
  assert.match(
    controller,
    /: \(state\.mode === "rework" \? "resubmitRequest" : null\)/u
  );
  assert.match(controller, /return this\._sendChangeRequest\(action\);/u);
  // Check stays, and since 2026-08-21 it is on the approve view too - both buttons only read. The
  // one screen it is off is the read-only view of a request, which re-runs nothing.
  assert.match(head, /state\.showCheckButton = !viewing;/u);
  assert.doesNotMatch(head, /state\.showCheckButton = reworking/u);
});

/**
 * Save Request would drop the screen out of editing and offer Edit, which re-enters "edit" mode -
 * and onSave would then route to submitRequest, starting a second workflow for a request whose own
 * instance is still parked.
 */

/**
 * The link outlives the state it was sent for. A requester who already resubmitted, or whose request
 * someone else withdrew, must not be offered the buttons again - the same rule the approve view
 * follows for a task that has already been decided.
 */

/**
 * A failed S/4 post also sends the request to `reworkRequired`, but nobody rejected anything - the
 * generic "sent back by the approver" wording would put words in the approver's mouth. `postError` is
 * checked first because, unlike `rejectionComment`, it is always cleared on the next successful post
 * and rewritten on the next failed one - it cannot go stale across rounds the way a comment can.
 */
test('a failed post is told apart from a rejection on the rework screen', () => {
  const load = controller.slice(controller.indexOf('_loadStagedRequest: async function'));
  assert.match(load, /state\.postError = \(payload && payload\.PostError\) \|\| ""/u);
  // Two sentences since 2026-09-03, chosen by whether a partner number came back: a post that
  // failed AFTER the root create leaves a real, active partner, and telling the requester it
  // could not be created is what sent one looking for something that was already there.
  assert.match(load, /state\.businessPartner\s*\n\s*\? "Approved\. Business Partner "/u);
  assert.match(load, /WAS created in S\/4HANA, but the rest of the request could not be posted: "/u);
  assert.match(load, /: "Approved, but the Business Partner could not be created in S\/4HANA: "\)/u);
  const postErrorAt = load.indexOf('} else if (state.postError) {');
  const rejectionAt = load.indexOf('} else if (state.rejectionComment) {');
  assert.ok(postErrorAt > -1 && rejectionAt > -1);
  assert.ok(postErrorAt < rejectionAt, 'postError is checked before the rejection wording');
});
