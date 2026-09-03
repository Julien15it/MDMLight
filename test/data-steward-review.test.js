'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'businesspartner', 'webapp');
const TASK_APP = path.join(ROOT, 'app', 'bptask');
const REUSE = path.join(ROOT, 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const staging = read(ROOT, 'db', 'staging.cds');
const serviceCds = read(ROOT, 'srv', 'change-request-service.cds');
const serviceJs = read(ROOT, 'srv', 'change-request-service.js');
const controller = read(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js');
const view = read(REUSE, 'view', 'BusinessPartnerMaintenance.view.xml');
const manifest = JSON.parse(read(APP, 'manifest.json'));
const taskManifest = JSON.parse(read(TASK_APP, 'webapp', 'manifest.json'));
const taskComponent = read(TASK_APP, 'webapp', 'Component.js');

const {
  EDITABLE_STATUSES, WITHDRAWABLE_STATUSES, DATASTEWARD_COMPLETE_SIGNAL, DATASTEWARD_REJECTED_SIGNAL,
  dataStewardUrl
} = require('../srv/change-request-service')._internals;
const { ACTIVE_REQUEST_STATUSES } = require('../srv/business-partner-service')._internals;
const { currentProcessors, describeProcessors, STEPS } = require('../srv/request-processors');
const { IN_PROGRESS_REQUEST_STATUSES, statusOf } = require('../srv/search-results');

// --- The model ---------------------------------------------------------------------------

test('checkAndEnrich is its own status, parallel to reworkRequired rather than a step inside it', () => {
  assert.match(
    staging, /draft; inApproval; approved; rejected; reworkRequired; checkAndEnrich; posted; failed/u
  );
  assert.ok('checkAndEnrich'.length <= 20);
});

// --- The actions ---------------------------------------------------------------------------

test('claimDataStewardReview and decideDataStewardReview are declared', () => {
  assert.match(serviceCds, /action claimDataStewardReview\(/u);
  assert.match(serviceCds, /action decideDataStewardReview\(/u);
  assert.match(serviceCds, /Decision\s*:\s*String\(10\) not null,/u);
});

/** The claimRework pattern, copied for the data steward step - see the comment on both in the service. */
test('claimDataStewardReview moves a request out of inApproval, and signals nothing', () => {
  const claim = serviceJs.slice(
    serviceJs.indexOf("this.on('claimDataStewardReview'"), serviceJs.indexOf("this.on('decideDataStewardReview'")
  );
  assert.match(claim, /header\.postedBP \|\| header\.status !== 'inApproval'/u);
  assert.match(claim, /status: 'checkAndEnrich'/u);
  assert.match(claim, /Claimed: true/u);
  assert.equal(/trigger(ApprovalDecision|RequesterCallback)/u.test(claim), false, 'no workflow signal');
});

test('decideDataStewardReview only accepts complete or reject', () => {
  const decide = serviceJs.slice(serviceJs.indexOf("this.on('decideDataStewardReview'"));
  const body = decide.slice(0, decide.indexOf('// Rework, out of existence.') === -1
    ? decide.length
    : decide.indexOf('// Rework, out of existence.'));
  assert.match(body, /if \(!\['complete', 'reject'\]\.includes\(decision\)\)/u);
  assert.match(body, /if \(before\.status !== 'checkAndEnrich'\)/u);
});

test('reject sends the request to reworkRequired, with the steward as the speaker', () => {
  const decide = serviceJs.slice(serviceJs.indexOf("this.on('decideDataStewardReview'"));
  const reject = decide.slice(decide.indexOf("if (decision === 'reject')"), decide.indexOf("// decision === 'complete'"));
  assert.match(reject, /status: 'reworkRequired'/u);
  assert.match(reject, /rejectionComment: req\.data\.Reason \|\| null/u);
  assert.match(reject, /appendComment\(db, changeRequest, 'DataSteward', requestingUserEmail\(req\), req\.data\.Reason\)/u);
  assert.match(reject, /triggerRequesterCallback\(before\.processInstanceId, DATASTEWARD_REJECTED_SIGNAL/u);
});

/**
 * The complete branch is resubmitRequest's own body - same gates, same duplicate-confirm dance,
 * ending at inApproval on the SAME parked instance rather than starting a new workflow.
 */
test('complete runs the same gates as resubmit, and hands the same instance back to inApproval', () => {
  const decide = serviceJs.slice(serviceJs.indexOf("this.on('decideDataStewardReview'"));
  const complete = decide.slice(decide.indexOf("// decision === 'complete'"));
  assert.match(complete, /if \(!before\.processInstanceId\)/u);
  assert.match(complete, /const changeRequestId = await persist\(req\);/u);
  // Shared with submit/resubmit/decideRequest's approve gate since 2026-08-31.
  assert.match(complete, /runSubmitValidations\(/u);
  assert.match(complete, /recordDuplicateFindings\(/u);
  assert.match(complete, /!req\.data\.Confirm/u);
  assert.match(complete, /const context = await workflowContext\(req, changeRequestId, header, findings\);/u);
  assert.match(complete, /triggerRequesterCallback\(before\.processInstanceId, DATASTEWARD_COMPLETE_SIGNAL, context\)/u);
  assert.match(complete, /status: 'inApproval'/u);
  assert.match(complete, /appendComment\(db, changeRequestId, 'DataSteward', requestingUserEmail\(req\), req\.data\.Reason\)/u);
  assert.match(complete, /ContextJson: JSON\.stringify\(context\)/u);
  // Blocked and needs-confirmation both leave the request at checkAndEnrich, not reworkRequired -
  // it is still the steward's to fix, nobody has been asked to rework anything.
  assert.match(complete, /Status: 'checkAndEnrich'/u);
});

test('datastewardurl is built and sent in the workflow context', () => {
  // Empty string when WORKZONE_URL is unset (a missing link is diagnosable, not a 404) - the same
  // legal answer approveUrl/reworkUrl give, per requestUrl's own contract.
  assert.match(dataStewardUrl('abc'), /^$|#ChangeRequests\/abc\/datasteward$/u);
  assert.match(serviceJs, /function dataStewardUrl\(changeRequest\) \{/u);
  assert.match(serviceJs, /return requestUrl\(changeRequest, 'datasteward'\);/u);
  assert.match(serviceJs, /datastewardurl: dataStewardUrl\(changeRequest\),/u);
});

test('opening the screen claims the review out of inApproval, the same way rework claims its own', () => {
  const load = controller.slice(controller.indexOf('_loadStagedRequest: async function'));
  const body = load.slice(0, load.indexOf('} else if (viewing)'));
  assert.match(body, /else if \(reviewing\) \{/u);
  assert.match(body, /if \(state\.requestStatus === "inApproval"\) \{/u);
  assert.match(
    body, /state\.requestStatus = await this\._claimDataStewardReview\(changeRequest, state\.requestStatus\);/u
  );
  assert.match(body, /var awaitingReview = state\.requestStatus === "checkAndEnrich";/u);
  assert.match(body, /state\.showDataStewardButtons = awaitingReview;/u);
});

// Asked for (2026-09-02): S/4's own standard checks used to need a Check press before a steward saw
// them at all. The only page-load check trigger in the app, and deliberately narrow - see CLAUDE.md,
// "Checks run on a button press, and only on a button press".
test('the data steward screen checks itself, every time it opens, once there is something to review', () => {
  const load = controller.slice(controller.indexOf('_loadStagedRequest: async function'));
  const body = load.slice(0, load.indexOf('_loadChangeBaseline: async function'));

  // After the finally block, not inside it or inside the `reviewing` branch: it must run once
  // loading, rendering and the "nothing to review" message are all settled, not before.
  const afterFinally = body.slice(body.indexOf('} finally {'));
  assert.match(afterFinally, /this\._renderAll\(\);\s*\n\s*\}\s*\n/u);
  assert.match(
    afterFinally,
    /if \(mode === "datasteward" && state\.requestStatus === "checkAndEnrich"\) \{\s*\n\s*await this\.onCheck\(\);/u
  );
  // The same call a press makes - not a second copy of its body, so the two can never disagree.
  assert.equal((afterFinally.match(/this\.onCheck\(\)/gu) || []).length, 1);
  // Not gated on `awaitingReview` alone reused from the branch above (which is a `var` inside the
  // try) - the same expression is re-checked directly off `state`, so it still holds even when the
  // load hit the catch branch and never reached the `reviewing` branch at all.
  assert.equal(/awaitingReview/u.test(afterFinally), false);
});

test('the two outcomes are wired to decideDataStewardReview, complete through the shared gates and reject directly', () => {
  assert.match(controller, /onCompleteDataStewardReview: function \(\) \{/u);
  assert.match(controller, /return this\._sendChangeRequest\("decideDataStewardReview"\);/u);
  assert.match(controller, /onRejectDataStewardReview: function \(\) \{/u);
  assert.match(controller, /_declineDataStewardReview: async function \(\) \{/u);
  const decline = controller.slice(controller.indexOf('_declineDataStewardReview: async function'));
  const body = decline.slice(0, decline.indexOf('onBackToList:'));
  assert.match(body, /Decision: "reject"/u);
  assert.match(body, /Reason: state\.dataStewardComment \|\| null/u);
  // "reject" - the same outcome id the approve task type uses, not a new one.
  assert.match(body, /this\._completeEmbeddedOutcome\("reject"\)/u);
});

// --- The task app ----------------------------------------------------------------------------

test('tasktype "datasteward" opens the data steward review and registers its own inbox actions', () => {
  assert.match(taskComponent, /context\.tasktype === "datasteward"/u);
  assert.match(
    taskComponent,
    /if \(context\.changerequestid\) \{\s+this\._openDataStewardReview\(context\.changerequestid\);/u
  );
  assert.match(taskComponent, /this\._addDataStewardInboxActions\(\);\s*\n\s*return;/u);
});

// --- Who has it now, and the search list ----------------------------------------------------

test('the processors strip names the data steward, or says nobody could be resolved', () => {
  const named = currentProcessors(
    { status: 'checkAndEnrich' }, [], ['a@b.com', 'c@d.com']
  );
  assert.equal(named.step, STEPS.review);
  assert.deepEqual(named.processors.map((entry) => entry.value), ['a@b.com', 'c@d.com']);
  assert.deepEqual(named.processors.map((entry) => entry.kind), ['user', 'user']);
  assert.equal(named.note, '');
  assert.equal(describeProcessors(named), 'Current step: Data Steward Review - with a@b.com, c@d.com');

  const empty = currentProcessors({ status: 'checkAndEnrich' }, [], []);
  assert.match(empty.note, /No data steward could be resolved/u);
  assert.deepEqual(empty.processors, []);
});

test('workflowContext resolves data stewards for the processors strip only while checkAndEnrich', () => {
  const builder = serviceJs.slice(
    serviceJs.indexOf('const processorsFor ='), serviceJs.indexOf('const currentDuplicateFindings =')
  );
  assert.match(builder, /if \(header\.status === 'checkAndEnrich'\)/u);
  assert.match(builder, /dataStewards = await dataStewardEmails\(\);/u);
  assert.match(builder, /currentProcessors\(header, approvers, dataStewards\)/u);
});

/**
 * Asked for 2026-09-03, after two requests were approved and then refused at the post - a partner
 * role that already existed, and a missing standard address. Both had been reported by S/4's own
 * checks beforehand, as warnings a data steward could walk past. An ERROR now stops the completion
 * rather than travelling on to an approver.
 */
test('an S/4 error blocks the data steward completing the review', () => {
  const complete = serviceJs.slice(
    serviceJs.indexOf("// decision === 'complete'"),
    serviceJs.indexOf('const findings = await recordDuplicateFindings')
  );
  assert.match(complete, /standard: true, stewardStep: true/u);
  assert.match(complete, /\.filter\(\(finding\) => finding\.severity === BLOCKING\)/u);
  assert.match(complete, /if \(blockingStandard\.length\)/u);
  // Refused, not recorded and passed on: the request stays where it is.
  assert.match(complete, /Status: 'checkAndEnrich',\s*
\s*NeedsConfirmation: false,\s*
\s*Valid: false/u);
});

// The server decides it is the steward step from the request's own status. Asking the client would
// be no gate at all - Role is a rendering hint that can only ever ADD this cost to its own press.
test('the steward step is asserted by the server, not taken from the client Role', () => {
  assert.match(serviceJs, /const stewardStep = forceStewardStep \|\| String\(req\.data\.Role \|\| ''\)/u);
});

// The standard checks must see systemDerived - typed values plus cvi_account_group, which is what
// creates the Customers/Suppliers node. Handed the raw staged payload they send no relation node
// and the customer and vendor tiers examine nothing at all.
test('the gate runs through runRequestChecks, so the checks see systemDerived', () => {
  const complete = serviceJs.slice(serviceJs.indexOf("// decision === 'complete'"));
  assert.match(complete, /const stewardCheck = await runRequestChecks\(req, \{/u);
  assert.equal(
    /createBpCheckStage\(/u.test(complete), false,
    'never the stage directly - that would skip the derivations it depends on'
  );
});
