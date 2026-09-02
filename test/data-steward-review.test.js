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
