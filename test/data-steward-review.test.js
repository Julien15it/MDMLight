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

test('a data steward review is editable and withdrawable, like a rework', () => {
  assert.ok(EDITABLE_STATUSES.includes('checkAndEnrich'));
  // Aliased on purpose - see the comment on WITHDRAWABLE_STATUSES in change-request-service.js.
  assert.deepEqual(WITHDRAWABLE_STATUSES, EDITABLE_STATUSES);
});

test('a partner under data steward review stays locked against a second editor', () => {
  assert.ok(ACTIVE_REQUEST_STATUSES.includes('checkAndEnrich'));
});

test('the conversation can name a data steward, alongside the requester and approver', () => {
  assert.match(staging, /role\s*:\s*String\(20\) enum \{ Requester; Approver; System; DataSteward \} not null/u);
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
  assert.match(complete, /runValidations\(/u);
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

test('both signals are unconfirmed placeholders, following the established capitalisation', () => {
  assert.equal(DATASTEWARD_COMPLETE_SIGNAL, 'DataStewardComplete');
  assert.equal(DATASTEWARD_REJECTED_SIGNAL, 'DataStewardRejected');
});

test('datastewardurl is built and sent in the workflow context', () => {
  // Empty string when WORKZONE_URL is unset (a missing link is diagnosable, not a 404) - the same
  // legal answer approveUrl/reworkUrl give, per requestUrl's own contract.
  assert.match(dataStewardUrl('abc'), /^$|#ChangeRequests\/abc\/datasteward$/u);
  assert.match(serviceJs, /function dataStewardUrl\(changeRequest\) \{/u);
  assert.match(serviceJs, /return requestUrl\(changeRequest, 'datasteward'\);/u);
  assert.match(serviceJs, /datastewardurl: dataStewardUrl\(changeRequest\),/u);
});

// --- The screen ----------------------------------------------------------------------------

test('the data steward route loads the datasteward mode', () => {
  assert.match(controller, /_onDataStewardRoute: function \(event\) \{/u);
  const route = controller.slice(controller.indexOf('_onDataStewardRoute: function'));
  assert.match(route.slice(0, route.indexOf('_loadStagedRequest: async function')), /"datasteward"/u);
  assert.match(controller, /\["ChangeRequestDataSteward", this\._onDataStewardRoute\]/u);
});

test('datasteward mode is editable, checks are offered, but there is no generic Save button', () => {
  const load = controller.slice(controller.indexOf('_loadStagedRequest: async function'));
  const head = load.slice(0, load.indexOf('maintenanceModel.setData(state)'));
  assert.match(head, /var reviewing = mode === "datasteward";/u);
  assert.match(head, /var editing = mode === "edit" \|\| reworking \|\| reviewing;/u);
  assert.match(head, /state\.showSaveButton = editing && !reviewing;/u);
  assert.match(head, /state\.showSaveRequestButton = editing && !reworking && !reviewing;/u);
});

test('the field property profile is read under the DataSteward role in datasteward mode', () => {
  assert.match(
    controller,
    /mode === "approve" \? "Approver" : \(reviewing \? "DataSteward" : "Requester"\)/u
  );
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

test('the data steward comment box is not embedded-only, like the rework one', () => {
  const box = view.slice(view.indexOf('id="dataStewardCommentBox"'), view.indexOf('id="dataStewardCommentBox"') + 400);
  assert.match(box, /visible="\{= \$\{maintenance>\/mode\} === 'datasteward' \}"/u);
  assert.equal(/env>\/embedded/u.test(box), false, 'not gated on embedded, unlike approverCommentBox');
  assert.match(box, /value="\{maintenance>\/dataStewardComment\}"/u);
});

test('the footer offers Complete Review and Reject, hidden embedded like every other footer button', () => {
  const footer = view.slice(view.indexOf('<footer>'), view.indexOf('</footer>'));
  assert.match(footer, /press="\.onCompleteDataStewardReview"/u);
  assert.match(footer, /press="\.onRejectDataStewardReview"/u);
  const guarded = footer.match(
    /visible="\{= \$\{maintenance>\/showDataStewardButtons\} &amp;&amp; !\$\{env>\/embedded\} \}"/gu
  ) || [];
  assert.equal(guarded.length, 2, 'both Complete Review and Reject');
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

test('_addDataStewardInboxActions publishes over the event bus, like rework, never completing the task directly', () => {
  const fn = taskComponent.slice(taskComponent.indexOf('_addDataStewardInboxActions: function'));
  const body = fn.slice(0, fn.indexOf('_workflowRuntimeBaseUrl:'));
  // Reject reuses the approve task type's own "reject" id - the two never coexist on one task.
  assert.match(body, /\{ id: "reject", label: "Reject", type: "reject" \}/u);
  assert.match(body, /\{ id: "enrich", label: "Complete Review", type: "accept" \}/u);
  assert.match(body, /eventBus\.publish\("taskform", outcome\.id\)/u);
  assert.equal(/_completeTask\(outcome\.id\)/u.test(body), false, 'no direct completion here');
});

test('reject is registered under two different handlers, never the same one', () => {
  const approveFn = taskComponent.slice(
    taskComponent.indexOf('_addInboxActions: function'), taskComponent.indexOf('/**\n             * Same shape as _addReworkInboxActions')
  );
  assert.match(approveFn, /function \(\) \{ this\._completeTask\(outcome\.id\); \}/u);
  const stewardFn = taskComponent.slice(taskComponent.indexOf('_addDataStewardInboxActions: function'));
  const body = stewardFn.slice(0, stewardFn.indexOf('_workflowRuntimeBaseUrl:'));
  assert.match(body, /function \(\) \{ eventBus\.publish\("taskform", outcome\.id\); \}/u);
});

test('both apps declare the datasteward route', () => {
  const route = { pattern: 'ChangeRequests/{changeRequest}/datasteward', name: 'ChangeRequestDataSteward' };
  for (const routes of [manifest['sap.ui5'].routing.routes, taskManifest['sap.ui5'].routing.routes]) {
    const found = routes.find((entry) => entry.name === route.name);
    assert.ok(found, 'the route is declared');
    assert.equal(found.pattern, route.pattern);
    assert.equal(found.target, 'BusinessPartnerMaintenance');
  }
});

test('the outcomes ids do not collide with the approve or rework task types', () => {
  const ids = taskManifest['sap.bpa.task'].outcomes.map((outcome) => outcome.id);
  assert.equal(new Set(ids).size, ids.length, 'every outcome id is unique');
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

test('the requester\'s own approvers are not read while a data steward has the request, and vice versa', () => {
  // approvers passed but status is checkAndEnrich - must not leak into the step meant for stewards.
  const review = currentProcessors({ status: 'checkAndEnrich' }, [{ value: 'x@y.com' }], []);
  assert.equal(review.processors.length, 0);
  const approval = currentProcessors({ status: 'inApproval' }, [], ['steward@y.com']);
  assert.equal(approval.step, STEPS.approval);
  assert.equal(approval.processors.length, 0);
});

test('workflowContext resolves data stewards for the processors strip only while checkAndEnrich', () => {
  const builder = serviceJs.slice(
    serviceJs.indexOf('const processorsFor ='), serviceJs.indexOf('const currentDuplicateFindings =')
  );
  assert.match(builder, /if \(header\.status === 'checkAndEnrich'\)/u);
  assert.match(builder, /dataStewards = await dataStewardEmails\(\);/u);
  assert.match(builder, /currentProcessors\(header, approvers, dataStewards\)/u);
});

test('a request under data steward review stays in the merged search list as in-progress', () => {
  assert.ok(IN_PROGRESS_REQUEST_STATUSES.includes('checkAndEnrich'));
  const status = statusOf({ requestType: 'create', status: 'checkAndEnrich' });
  assert.equal(status.RecordStatus, 'Create data steward review');
});
