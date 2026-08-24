'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  STEPS, kindOf, currentProcessors, describeProcessors
} = require('../srv/request-processors');

test('a draft is the requester\'s, and says so', () => {
  const current = currentProcessors({ status: 'draft', createdBy: 'maarten' });
  assert.equal(current.step, STEPS.submit);
  // A requester is a person whatever their user id looks like; only an approver can be a role.
  assert.deepEqual(current.processors, [{ value: 'maarten', kind: 'user', role: 'requester' }]);
  assert.match(current.note, /Not submitted yet/u);
});

test('the submitter outranks the creator, since they are who sent it', () => {
  const current = currentProcessors({
    status: 'reworkRequired', createdBy: 'julien', submittedBy: 'maarten@alluvion.eu'
  });
  assert.equal(current.step, STEPS.rework);
  assert.deepEqual(current.processors, [
    { value: 'maarten@alluvion.eu', kind: 'user', role: 'requester' }
  ]);
});

test('a request in approval names the approvers the rules resolved', () => {
  const current = currentProcessors({ status: 'inApproval' }, [
    { step: 'Approve', kind: 'user', value: 'julien@alluvion.eu' },
    { step: 'Approve', kind: 'role', value: 'Sales Approver' }
  ]);
  assert.equal(current.step, STEPS.approval);
  assert.deepEqual(current.processors, [
    { value: 'julien@alluvion.eu', kind: 'user', role: 'approver' },
    { value: 'Sales Approver', kind: 'role', role: 'approver' }
  ]);
  // No note: the names are in the strip already, and where they come from is a caveat for whoever
  // maintains this rather than something a requester reading the screen can act on.
  assert.equal(current.note, '');
});

// Empty is a legitimate answer everywhere else in this table's code, so it is one here too.
test('no rule matched says the workflow routes it, rather than naming nobody', () => {
  const current = currentProcessors({ status: 'inApproval' }, []);
  assert.equal(current.step, STEPS.approval);
  assert.deepEqual(current.processors, []);
  assert.match(current.note, /routes it itself/u);
  assert.match(current.note, /approver's inbox/u);
});

// A draft's approvers are not resolved at all, so a stray list must not be shown as responsible.
test('approvers are ignored for anything that is not in approval', () => {
  const approvers = [{ step: 'Approve', value: 'julien@alluvion.eu' }];
  assert.deepEqual(currentProcessors({ status: 'draft', createdBy: 'm' }, approvers).processors, [
    { value: 'm', kind: 'user', role: 'requester' }
  ]);
  assert.deepEqual(currentProcessors({ status: 'approved' }, approvers).processors, []);
});

test('a rejected request reads as the rework it has become', () => {
  // Never written any more, but it cannot be dropped from the enum - so it must not fall through.
  const current = currentProcessors({ status: 'rejected', createdBy: 'maarten' });
  assert.equal(current.step, STEPS.rework);
  assert.equal(current.processors.length, 1);
});

test('the steps nobody holds say what is waiting instead of naming a person', () => {
  const approved = currentProcessors({ status: 'approved' });
  assert.equal(approved.step, STEPS.post);
  assert.deepEqual(approved.processors, []);
  assert.match(approved.note, /not a person/u);

  const posted = currentProcessors({ status: 'posted' });
  assert.equal(posted.step, STEPS.done);
  assert.match(posted.note, /Nothing is outstanding/u);

  const failed = currentProcessors({ status: 'failed' });
  assert.equal(failed.step, STEPS.failed);
  assert.match(failed.note, /data steward/u);
  assert.match(failed.note, /will not retry itself/u);
});

test('an unknown status reports the status rather than inventing a step', () => {
  const current = currentProcessors({ status: 'somethingNew' });
  assert.equal(current.step, 'somethingNew');
  assert.deepEqual(current.processors, []);
  assert.equal(currentProcessors({}).step, '');
});

// Same rule as the wire: what SBPA gets is a flat list and an `@` is what marks a person.
test('an @ makes a user, anything else a role', () => {
  assert.equal(kindOf('maarten@alluvion.eu'), 'user');
  assert.equal(kindOf('Sales Approver'), 'role');
  assert.equal(kindOf(''), 'role');
});

test('one line for the strip', () => {
  assert.equal(
    describeProcessors(currentProcessors({ status: 'inApproval' }, [{ value: 'a@b.eu' }])),
    'Current step: Approval - with a@b.eu'
  );
  assert.equal(
    describeProcessors(currentProcessors({ status: 'approved' })),
    'Current step: Post'
  );
});

// --- Wiring ---------------------------------------------------------------------------------

const root = (...segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');

test('getRequestPayload carries the processors, so every request screen gets them', () => {
  assert.match(root('srv', 'change-request-service.cds'), /ProcessorsJson\s*: LargeString;/u);
  assert.match(
    root('srv', 'change-request-service.js'),
    /ProcessorsJson: JSON\.stringify\(await processorsFor\(header, \{ root, sections \}\)\)/u
  );
});

// Resolving them for a draft would name people who are not responsible for anything yet.
test('the approvers are only resolved while a request is in approval', () => {
  const service = root('srv', 'change-request-service.js');
  assert.match(service, /if \(header\.status === 'inApproval'\) \{\s*try \{\s*approvers = await approversFor/u);
});

// It goes last. Every message a mode branch sets explains the screen - why a rework link offers
// nothing, why a request is read-only, what a rejection said - and the panel header shows the
// LEADING message, so leading with the step would collapse the explanation out of sight.
test('the strip goes last, so a message explaining the screen still leads', () => {
  const controller = root(
    'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
    'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  assert.match(controller, /var processorStrip = processorMessage\(state\.processors\);/u);
  assert.match(
    controller,
    /if \(processorStrip\) state\.messages = \(state\.messages \|\| \[\]\)\.concat\(\[processorStrip\]\);/u
  );
  // Never prepended: that is the version that hid the "nothing to rework" note behind the step.
  assert.equal(/\[processorStrip\]\.concat/u.test(controller), false);
});

// --- The findings an approver judges on ---------------------------------------------------------

// CheckFindings only ever held duplicate_check rows, so a VIES name mismatch or a warning-level
// configured rule was shown to the requester at submit and then dropped: the approver judged a
// request without the findings it was submitted with.
test('a submit records its non-blocking validations, superseding the previous set', () => {
  const service = root('srv', 'change-request-service.js');
  assert.match(service, /const recordValidationFindings = async \(changeRequest, validations\)/u);
  // Superseded, not deleted - an earlier verdict stays auditable across a resubmit.
  assert.match(service, /set\(\{ isStale: true \}\)\s*\.where`request_ID = \$\{changeRequest\} and checkName != 'duplicate_check'`/u);
  // Both submit paths, and after the blocking gate so nothing blocking can be stored.
  assert.equal(
    (service.match(/await recordValidationFindings\(changeRequest, validations\);/gu) || []).length,
    2,
    'submitRequest and resubmitRequest both record'
  );
});

test('the request carries them back for the approve screen', () => {
  assert.match(root('srv', 'change-request-service.cds'), /ValidationsJson : LargeString;/u);
  const service = root('srv', 'change-request-service.js');
  assert.match(service, /ValidationsJson: JSON\.stringify\(await currentValidationFindings\(changeRequest\)\)/u);
  // Duplicates keep their own panel; these are statements about the record, so they are strips.
  assert.match(service, /const currentValidationFindings = async \(changeRequest\)/u);
});

// Every mode branch ASSIGNS state.messages, so anything set before them is wiped.
test('the submitted warnings are appended after the branches, not before', () => {
  const controller = root(
    'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
    'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  assert.match(controller, /var submittedWarnings = this\._validationMessages\(/u);
  assert.match(
    controller,
    /state\.messages = \(state\.messages \|\| \[\]\)\s*\.concat\(submittedWarnings\)\s*\.concat\(processorStrip \? \[processorStrip\] : \[\]\);/u
  );
});
