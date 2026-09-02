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

// Same rule as the wire: what SBPA gets is a flat list and an `@` is what marks a person.
test('an @ makes a user, anything else a role', () => {
  assert.equal(kindOf('maarten@alluvion.eu'), 'user');
  assert.equal(kindOf('Sales Approver'), 'role');
  assert.equal(kindOf(''), 'role');
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

/**
 * The "Current step: ... - with <approver>" strip was removed from the maintenance screen
 * altogether on 2026-08-28 (asked for: "haal de infomessage uit de app... dit is niet meer
 * nodig"). Only the CLIENT-SIDE reading of it went - `ProcessorsJson`/`processorsFor` on the
 * server are untouched (see the tests above), so this stays available to build a different
 * surface on later; nothing in the maintenance screen reads it into a message any more.
 */
test('the processor strip is gone from the maintenance screen', () => {
  const controller = root(
    'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
    'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  for (const gone of ['processorMessage', 'processorStrip', 'state.processors', 'parseProcessors']) {
    assert.equal(controller.includes(gone), false, `${gone} should no longer appear`);
  }
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

// Every mode branch ASSIGNS state.messages, so anything set before them is wiped.
test('the submitted warnings are appended after the branches, not before', () => {
  const controller = root(
    'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
    'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  assert.match(controller, /var submittedWarnings = this\._validationMessages\(/u);
  assert.match(
    controller,
    /state\.messages = \(state\.messages \|\| \[\]\)\.concat\(submittedWarnings\);/u
  );
});
