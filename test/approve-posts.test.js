'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

const serviceJs = read('srv', 'change-request-service.js');
const serviceCds = read('srv', 'change-request-service.cds');
const automation = read('srv', 'wf', 'processAutomation.js');
const taskComponent = read('app', 'bptask', 'webapp', 'Component.js');
const approveController = read(
  'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
  'controller', 'BusinessPartnerMaintenance.controller.js'
);

const decideBody = serviceJs.slice(
  serviceJs.indexOf("this.on('decideRequest'"), serviceJs.indexOf("this.on('completeRequest'")
);
const approveBranch = decideBody.slice(decideBody.indexOf('// Approved'));
const postAndRecord = serviceJs.slice(
  serviceJs.indexOf('const postAndRecord ='), serviceJs.indexOf("this.on('decideRequest'")
);

const {
  awaitRelationNumber, RELATION_WAIT_ATTEMPTS, matchDeterminedRow, SELF_DETERMINED_NODES
} = require('../srv/change-request-service')._internals;

/**
 * Pressing Approve creates the business partner (changed 2026-08-25). It used to stop at `approved`
 * and leave the S/4 write to SPA calling completeRequest — while the approve screen already told the
 * approver the partner had been created, and its confirmation dialog already promised it would be.
 */
test('approving posts to S/4 rather than only recording the decision', () => {
  assert.match(approveBranch, /status: 'approved'/u, 'the decision is still recorded first');
  assert.match(approveBranch, /return postAndRecord\(req, \{ \.\.\.header, status: 'approved' \}\)/u);
  // The screen's promise, which the server now keeps.
  assert.match(approveController, /Approve this request and create the Business Partner in S\/4HANA\?/u);
});

test('a successful post is recorded as posted, with the number and no error', () => {
  const success = postAndRecord.slice(0, postAndRecord.indexOf('} catch (error)'));
  assert.match(success, /status: 'posted'/u);
  assert.match(success, /postedBP: businessPartner/u);
  assert.match(success, /postError: null/u);
  assert.match(success, /signalPostResult\(header, \{ businessPartner \}\)/u);
});

test('a failed post sends the request back to rework, not to failed', () => {
  const failure = postAndRecord.slice(postAndRecord.indexOf('} catch (error)'));
  assert.match(failure, /status: 'reworkRequired'/u);
  assert.match(failure, /postError: message\.slice\(0, 1000\)/u);
  assert.match(failure, /signalPostResult\(header, \{ errorMessage: message \}\)/u);
  assert.match(failure, /ErrorMessage: message\.slice\(0, 1000\)/u);
});

/**
 * `postError` on the header says THAT the post failed; the thread is what says WHAT failed to
 * whoever opens the request next. Authored as `'System'`/`'SYSTEM'`, never `'Approver'` - the
 * approver did not reject anything, S/4 did.
 */

/** `getRequestPayload` is how a reopened rework/view/approve screen learns why the post failed. */

/**
 * The trap this replaced. `req.reject` throws, CAP rolls the transaction back with it, and the
 * status write goes down with the rollback — so `completeRequest` used to set `failed` immediately
 * before rejecting, and the request stayed `approved` with nothing saying why. Reporting the failure
 * in the return value is what makes "back to rework" actually stick.
 */
test('the failure is returned, never rejected, so the status write survives', () => {
  assert.equal(
    /req\.reject/u.test(postAndRecord), false,
    'rejecting here would roll back the reworkRequired write'
  );
  assert.match(serviceCds, /ErrorMessage {4}: String\(1000\)/u);
  assert.equal((serviceCds.match(/ErrorMessage {4}: String\(1000\)/gu) || []).length, 2,
    'decideRequest and completeRequest both carry it');
});

/**
 * Both entry points run the one step. completeRequest is still reachable — a request approved
 * before this change, or one whose approve handler died between the status write and the post — and
 * two copies of "write the status, send the signal" would drift.
 */
test('completeRequest shares the post step instead of repeating it', () => {
  const complete = serviceJs.slice(serviceJs.indexOf("this.on('completeRequest'"));
  const body = complete.slice(0, complete.indexOf('await super.init()'));
  assert.match(body, /return postAndRecord\(req, header\)/u);
  assert.equal(/postToS4\(/u.test(body), false, 'the post itself lives in the shared step');
});

/**
 * `notifyWorkflow` is declared with `const` inside the decideRequest handler. completeRequest
 * referenced it anyway, so every completion threw a ReferenceError *after* creating the partner in
 * S/4 — on the success path and on the failure path both. Fixed by the shared step; pinned here so
 * a future edit cannot reintroduce a cross-handler reference.
 */
test('notifyWorkflow is only used where it is declared', () => {
  const declaredIn = serviceJs.indexOf('const notifyWorkflow =');
  assert.ok(declaredIn > -1);
  const decideEnd = serviceJs.indexOf("this.on('completeRequest'");
  for (const match of serviceJs.matchAll(/notifyWorkflow\(/gu)) {
    assert.ok(
      match.index > declaredIn && match.index < decideEnd,
      `notifyWorkflow is called at ${match.index}, outside the handler that declares it`
    );
  }
});

// --- The signal ---------------------------------------------------------------------------------

test('the post result goes to its own trigger, with no result key', () => {
  assert.match(
    automation,
    /POST_RESULT_TRIGGER_ID = "eu10\.alluvion-dev-cf\.mdmlightapproval\.waitForResult"/u
  );
  const fn = automation.slice(automation.indexOf('async function triggerPostResult'));
  // To the closing brace of the function, not to the first one inside the payload literal.
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /postTrigger\(POST_RESULT_TRIGGER_ID, "post result", \{ executionId, inputs \}\)/u);
  assert.equal(/result/u.test(body.replace(/POST_RESULT|"post result"/gu, '')), false,
    'inputs are passed through, never spread over a result');
});

/** executionId is the process instance from our own header, not the change request UUID. */

/**
 * Staging has no BusinessPartnerFullName column — the screen's read-only field is composed there
 * too — so the name has to be composed here rather than read.
 */

/** A signalling failure must not lose a partner that already exists in S/4. */

/**
 * SignalWorkflow false is the task form saying "completing the task already delivers the decision".
 * It must not silence the post result: that is a different wait, and the process needs it whichever
 * way the decision arrived.
 */

// --- Not creating the partner twice -------------------------------------------------------------

/**
 * The risk the rework path introduces. A create whose post half-succeeded leaves a real partner in
 * S/4; the requester then reworks and resubmits, and a second approve would create another one
 * unless the number is remembered and the retry stops being a create.
 */
test('a create that already has a number is a retry, not a second create', () => {
  const post = serviceJs.slice(serviceJs.indexOf('const postToS4 ='));
  assert.match(
    post, /const isCreate = header\.requestType === 'create' && !header\.businessPartner;/u
  );
});

test('the number is persisted before the child nodes can fail', () => {
  const post = serviceJs.slice(serviceJs.indexOf('const postToS4 ='));
  const persistAt = post.indexOf('UPDATE(HEADER).set({ businessPartner })');
  const loopAt = post.indexOf('for (const [section, config] of Object.entries(NODES))');
  assert.ok(persistAt > -1, 'the number S/4 handed over is written to the header');
  assert.ok(loopAt > -1);
  assert.ok(persistAt < loopAt, 'and written before anything else can throw');
});

// --- What the approver is told -------------------------------------------------------------------

/**
 * An empty BusinessPartner used to mean "rejected" and nothing else. Now it can also mean "approved
 * and the post failed", and both screens have to tell those apart.
 */
test('the approve screen reports a failed post as a failure, not as a rejection', () => {
  const decide = approveController.slice(approveController.indexOf('_decide: async function'));
  const body = decide.slice(0, decide.indexOf('onApprove:'));
  assert.match(body, /if \(result && result\.ErrorMessage\)/u);
  assert.match(body, /MessageBox\.error\(/u);
  assert.match(body, /sent back to the requester for rework/u);
  // And the rejection toast is still there, on the branch that really is a rejection.
  assert.match(body, /MessageToast\.show\("Request rejected\."\)/u);
});

/**
 * Multiple approvers (redesigned 2026-09-02): CAP counts its own approvals now, not the task form.
 * The earlier design had `app/bptask` read `currentapprover`/`totalapprovers` off the BPA task
 * context to decide client-side whether to call `decideRequest` at all - which broke silently the
 * moment the task app's version drifted from what the SBPA Lobby had re-pointed to (see
 * test/task-form.test.js, "currentapprover/totalapprovers are gone"), and posted on the FIRST
 * approval of every multi-approver chain. `decideRequest` now increments and persists
 * `approvalsReceived` on every approve, and only posts once it reaches `requiredApprovals` - a
 * value CAP itself set at (re)submit time from its own `approvers` array, independent of anything a
 * client or BPA supplies afterwards.
 */
test('an approve only posts once CAP has counted enough of them, and always records one', () => {
  // The approve-side counting logic, scoped past the reject branch above it - both branches call
  // appendComment(..., 'Approver', ...), so a plain decideBody search finds the reject branch's
  // call first.
  const countingBody = decideBody.slice(decideBody.indexOf('const requiredApprovals ='));
  assert.match(countingBody, /const requiredApprovals = header\.requiredApprovals \|\| 1;/u);
  assert.match(countingBody, /const approvalsReceived = \(header\.approvalsReceived \|\| 0\) \+ 1;/u);
  // Recorded before the finality check, so a comment lands on the thread whichever approval this is.
  const countedAt = countingBody.indexOf('const approvalsReceived =');
  const commentAt = countingBody.indexOf("appendComment(db, changeRequest, 'Approver'");
  assert.ok(countedAt > -1 && commentAt > -1 && countedAt < commentAt);

  // Not final: status stays inApproval, nothing is posted, and the caller is told how many are in.
  const notFinal = countingBody.slice(countingBody.indexOf('if (approvalsReceived < requiredApprovals)'));
  const notFinalBody = notFinal.slice(0, notFinal.indexOf('// Approved, and posted from here'));
  assert.match(notFinalBody, /Status: 'inApproval'/u);
  assert.match(notFinalBody, /BusinessPartner: null/u);
  assert.match(notFinalBody, /ApprovalsReceived: approvalsReceived/u);
  assert.match(notFinalBody, /RequiredApprovals: requiredApprovals/u);
  assert.equal(/postAndRecord/u.test(notFinalBody), false, 'not final: nothing is posted');

  // Final: the existing post path, unchanged, just reached one approval later.
  assert.match(approveBranch, /return postAndRecord\(req, \{ \.\.\.header, status: 'approved' \}\)/u);
});

// The task form no longer decides finality at all - see test/task-form.test.js for the removal of
// _isFinalApprover, isIntermediateApproval and the currentapprover/totalapprovers task inputs.
test('every approve reaches decideRequest, whichever approval in the chain it is', () => {
  const complete = taskComponent.slice(taskComponent.indexOf('_completeTask: async function'));
  const completeBody = complete.slice(0, complete.indexOf('\n            },'));
  assert.match(completeBody, /var decision = await this\._decideOnServer\(outcomeId\);/u);
  assert.match(completeBody, /await this\._patchTaskInstance\(outcomeId\);/u);
  assert.equal(completeBody.includes('_isFinalApprover'), false);
});

/**
 * Reported live 2026-09-03: an approver was told the post had failed, the requester opened the
 * rework screen, and the business partner was already there and active.
 *
 * With CVI configured, creating the BP with an FLCU01/FLVN01 role is what creates the customer or
 * vendor - in POSTPROCESSING, after the root create has already returned. Read in that window,
 * `to_Customer` honestly 404s on a partner that is about to have one, and the post either refused a
 * child ("has no Customer record yet") or tried to CREATE the role node S/4 was already creating.
 * Either way the whole request went to rework carrying an S/4 error, over a partner that existed.
 */
test('the relation number is waited for, because CVI creates it after the root create returns', async () => {
  let calls = 0;
  const waits = [];
  const number = await awaitRelationNumber({}, '4711', 'Customer', {
    resolve: async () => { calls += 1; return calls < 3 ? null : '0000004711'; },
    wait: async (ms) => { waits.push(ms); }
  });
  assert.strictEqual(number, '0000004711');
  assert.strictEqual(calls, 3, 'it keeps asking while the answer is "not there"');
  assert.strictEqual(waits.length, 2, 'and waits between attempts, not after the last one');
});

test('a number that is there immediately costs no wait at all', async () => {
  const waits = [];
  const number = await awaitRelationNumber({}, '4711', 'Customer', {
    resolve: async () => '0000004711',
    wait: async (ms) => { waits.push(ms); }
  });
  assert.strictEqual(number, '0000004711');
  assert.deepStrictEqual(waits, [], 'a landscape that answers at once must not be slowed down');
});

// Still null once the attempts are used up - the same answer it always gave, because the caller
// decides what absence means (nothing to hang a child on, or a role node that has to be created).
test('giving up answers null rather than throwing, so the caller still decides', async () => {
  let calls = 0;
  const number = await awaitRelationNumber({}, '4711', 'Supplier', {
    resolve: async () => { calls += 1; return null; },
    wait: async () => {}
  });
  assert.strictEqual(number, null);
  assert.strictEqual(calls, RELATION_WAIT_ATTEMPTS);
});

// The race only exists straight after a root create: on a retry or a change request the partner has
// existed for minutes, and a record absent by then is not coming. Waiting there would slow every
// approve for nothing, which is what forced the budget to be short in the first version of this.
test('the wait is spent only where CVI might still be working', () => {
  const postToS4 = serviceJs.slice(
    serviceJs.indexOf('const postToS4 ='), serviceJs.indexOf('const postAndRecord =')
  );
  assert.match(postToS4, /const createdRootNow = isCreate;/u);
  assert.match(
    postToS4, /attempts: createdRootNow \? RELATION_WAIT_ATTEMPTS : 1/u,
    'a retry reads once; only a fresh create waits'
  );
  // Captured BEFORE the row loop, which declares an isCreate of its own per node.
  assert.ok(
    postToS4.indexOf('const createdRootNow = isCreate;') < postToS4.indexOf('for (const [section, config]'),
    'it must be read before the loop shadows isCreate, or it means the wrong thing'
  );
});

/**
 * The second half of the same report. postToS4 persists the number the moment the ROOT create
 * succeeds, so a header carrying one means the partner EXISTS and something after it failed. Saying
 * "the Business Partner could not be created" then is false, and it is what sent a requester looking
 * for a partner that was already active under a number the message never mentioned.
 */
test('a post that failed AFTER the partner was created says so, and names it', () => {
  assert.match(postAndRecord, /const created = header\.businessPartner \|\| null;/u);
  assert.match(postAndRecord, /WAS created in S\/4HANA/u);
  assert.match(postAndRecord, /could not be created in S\/4HANA/u);
  // The number has to survive on a FAILED decision, or the client cannot tell the two apart.
  assert.match(postAndRecord, /BusinessPartner: created/u);
  // One sentence, written once, used for the comment thread.
  assert.match(postAndRecord, /appendComment\(db, changeRequest, 'System', 'SYSTEM', summary\)/u);
});

test('the task app branches on the same thing rather than assuming a failure means nothing exists', () => {
  const completeTask = taskComponent.slice(taskComponent.indexOf('_completeTask:'));
  assert.match(completeTask, /decision\.BusinessPartner\s*\?\s*"Approved\. Business Partner "/u);
  assert.match(completeTask, /WAS created in S\/4HANA/u);
});

/**
 * A customer sales area runs its partner determination procedure on creation, so SP/BP/PY/SH exist
 * the moment the sales area does - and derivation-checks.js proposes exactly those, from the same
 * TKUPA/TPAER the procedure reads. Posting them afterwards got `Customer 295: Partner role SP
 * already exists (only provided once)` and sent the whole request to rework (reported 2026-09-03).
 */
test('a partner function S/4 determined for itself is matched on its natural key', () => {
  const config = SELF_DETERMINED_NODES.CustomerSalesPartnerFunctions;
  const existing = [
    { SalesOrganization: '1710', DistributionChannel: '10', Division: '00', PartnerFunction: 'SP', PartnerCounter: '001' },
    { SalesOrganization: '1710', DistributionChannel: '10', Division: '00', PartnerFunction: 'BP', PartnerCounter: '002' }
  ];
  const staged = { SalesOrganization: '1710', DistributionChannel: '10', Division: '00', PartnerFunction: 'SP' };
  const found = matchDeterminedRow(existing, config, staged);
  assert.strictEqual(found && found.PartnerCounter, '001', 'the counter only a read can supply');

  // A different sales area is a different row, however well the function matches.
  assert.strictEqual(
    matchDeterminedRow(existing, config, { ...staged, Division: '01' }, config), null
  );
  assert.strictEqual(matchDeterminedRow(existing, config, { ...staged, PartnerFunction: 'SH' }), null);
});

// Null means "could not ask", and the caller must fall back to the create it would have done -
// never to an update, which has no counter to address the row with.
test('an unreadable existing set is not mistaken for an empty one', () => {
  const config = SELF_DETERMINED_NODES.CustomerSalesPartnerFunctions;
  assert.strictEqual(matchDeterminedRow(null, config, { PartnerFunction: 'SP' }), null);
  assert.strictEqual(matchDeterminedRow(undefined, config, { PartnerFunction: 'SP' }), null);
  assert.strictEqual(matchDeterminedRow([], config, { PartnerFunction: 'SP' }), null);
});

test('the post decides create-vs-update from what S/4 holds, not from the staged action', () => {
  const postToS4 = serviceJs.slice(
    serviceJs.indexOf('const postToS4 ='), serviceJs.indexOf('const postAndRecord =')
  );
  assert.match(postToS4, /const selfDetermined = SELF_DETERMINED_NODES\[section\];/u);
  // The counter is merged into the row, or the update cannot address it.
  assert.match(postToS4, /data\[selfDetermined\.assignedKey\] = determined\[selfDetermined\.assignedKey\]/u);
  assert.match(postToS4, /determined \? false : action !== 'U'/u);
  // Read once per section, not once per row.
  assert.match(postToS4, /if \(!\(section in determinedRows\)\)/u);
});

// Both sides of the same customizing: TKUPA for the customer, T077K for the supplier.
test('both partner-function sections are covered', () => {
  assert.deepStrictEqual(
    Object.keys(SELF_DETERMINED_NODES).sort(),
    ['CustomerSalesPartnerFunctions', 'SupplierPartnerFunctions']
  );
  for (const config of Object.values(SELF_DETERMINED_NODES)) {
    assert.equal(config.assignedKey, 'PartnerCounter');
    assert.ok(config.matchOn.includes('PartnerFunction'));
  }
});
