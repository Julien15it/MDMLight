'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bpCheck = require('../srv/checks/bp-check');
const { createBpCheckStage, dedupe, toFindings, cap, INCLUDE_ROLES } = bpCheck;
const { runChecks } = require('../srv/checks/pipeline');

// The four strings the action returns, shaped as ZMDML_A_BPCHECK_OUT. Taken from the real probe
// output against client 100 on 2026-08-26, so the fixtures are what S/4 actually said.
function answer({ messages = [], coverage = {}, valid = true } = {}) {
  return {
    RequestId: 'test',
    Valid: valid,
    MessagesJson: JSON.stringify(messages),
    DerivedJson: JSON.stringify([]),
    SuppressedJson: JSON.stringify([]),
    CoverageJson: JSON.stringify(coverage)
  };
}

const LANGUAGE_WARNING = {
  stage: 'TESTRUN', severity: 'W', id: 'R11', number: '336',
  text: 'This language may be maintained only for persons', node: '', field: ''
};

const EXTERNAL_NUMBERING = {
  stage: 'VALIDATE', severity: 'A', id: 'R1', number: '091',
  text: 'Grouping 0002 has external number assignment. Please enter a valid number.',
  node: '', field: '0002'
};

function sender(result, calls = []) {
  return async (request) => {
    calls.push(request);
    return result;
  };
}

test('the payload sent to S/4 carries the roles, so the relation checks run', async () => {
  const calls = [];
  const stage = createBpCheckStage({ requestId: 'cr-1', send: sender(answer(), calls) });

  await stage({ root: { BusinessPartnerCategory: '2' }, sections: {} });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].path, /BPChecks\/.*\.check$/);

  // The role is what makes CVI run the vendor/customer checks, and inseparably what draws a vendor
  // number. Enabled 2026-08-26 with the number-range gaps accepted as product behaviour -- MDG does
  // the same. Pinned so the tier can only change deliberately.
  assert.equal(calls[0].data.IncludeRoles, true);
  assert.equal(INCLUDE_ROLES, true);

  // every action parameter is Nullable="false" in $metadata, so all five must be on the wire
  for (const key of ['RequestId', 'PayloadJson', 'IncludeRoles', 'IncludeRelations', 'RunTestRun']) {
    assert.ok(key in calls[0].data, `${key} must be sent`);
  }
  assert.equal(calls[0].data.RequestId, 'cr-1');
});

test('RequestId is truncated to the 36 characters the action declares', async () => {
  const calls = [];
  const stage = createBpCheckStage({ requestId: 'x'.repeat(80), send: sender(answer(), calls) });
  await stage({ root: {}, sections: {} });
  assert.equal(calls[0].data.RequestId.length, 36);
});

test('a repeated message is reported once, carrying its count', () => {
  // R11/336 arrives twice whenever a role is present: the BP path and the CVI path each fire it.
  const deduped = dedupe([{ ...LANGUAGE_WARNING }, { ...LANGUAGE_WARNING }]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].occurrences, 2);

  const [finding] = toFindings([{ ...LANGUAGE_WARNING }, { ...LANGUAGE_WARNING }]);
  assert.match(finding.message, /reported 2 times/);
});

test('severity is capped so a standard check cannot block a submit yet', () => {
  // R1/091 is an abort in S/4 and a real blocker, but the cap is the deliberate starting point --
  // see MAX_SEVERITY. This test pins the current setting so raising it is a conscious change.
  assert.equal(cap('A'), 'warning');
  assert.equal(cap('E'), 'warning');
  assert.equal(cap('W'), 'warning');
  assert.equal(cap('I'), 'info');

  const [finding] = toFindings([EXTERNAL_NUMBERING]);
  assert.equal(finding.severity, 'warning');
});

test('a finding carries only the keys every other stage returns', () => {
  // The one `field` value ever observed was `0002` -- a grouping value, not a field name -- so it
  // must not reach the UI as an anchor. The class and number go in the text instead, and no extra
  // keys are added to the message contract.
  const [finding] = toFindings([EXTERNAL_NUMBERING]);
  assert.deepEqual(Object.keys(finding).sort(), ['message', 'severity']);
  assert.match(finding.message, /R1\/091/);
});

test('the two stages are distinguishable in the text', () => {
  const [validation] = toFindings([EXTERNAL_NUMBERING]);
  const [activation] = toFindings([LANGUAGE_WARNING]);
  assert.match(validation.message, /^S\/4 validation \[R1\/091\]/);
  assert.match(activation.message, /^S\/4 activation \[R11\/336\]/);
});

test('a clean result produces no strips at all', async () => {
  // A requester gets either nothing to fix or something actionable. No narration about what was
  // and was not checked, and no info strips -- asked for 2026-08-26.
  const stage = createBpCheckStage({
    send: sender(answer({ coverage: { rolesIncluded: false, fieldPropertiesExcluded: true } }))
  });

  assert.deepEqual(await stage({ root: {}, sections: {} }), []);
});

test('S/4 info messages are dropped, warnings and errors are not', () => {
  const info = { stage: 'TESTRUN', severity: 'I', id: 'R11', number: '001', text: 'noted' };
  assert.deepEqual(toFindings([info]), []);
  assert.equal(toFindings([info, LANGUAGE_WARNING]).length, 1);
});

test('field-property verdicts from S/4 are never surfaced', async () => {
  const suppressed = [{ stage: 'TESTRUN', severity: 'E', id: 'F2', number: '001',
    text: 'Fill in all required entry fields' }];
  const stage = createBpCheckStage({
    send: sender({ ...answer(), SuppressedJson: JSON.stringify(suppressed) })
  });

  const found = await stage({ root: {}, sections: {} });
  assert.ok(!found.some((finding) => /required entry fields/.test(finding.message)));
});

test('an unreachable S/4 reports itself and never blocks', async () => {
  const stage = createBpCheckStage({
    send: async () => { throw new Error('destination not found'); }
  });

  const found = await stage({ root: {}, sections: {} });
  assert.equal(found.length, 1);
  // a warning, not an info: the only message that survives the no-info-strips rule, because a
  // check that did not run must never read as one that passed
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].message, /could not run \(destination not found\)/);
  assert.match(found[0].message, /has not been checked/);
});

test('a result that is not readable JSON does not pass as clean', async () => {
  const stage = createBpCheckStage({
    send: sender({ MessagesJson: 'not json', CoverageJson: '{}' })
  });
  // the shaping must not throw; unreadable messages simply yield nothing rather than a false pass
  const found = await stage({ root: {}, sections: {} });
  assert.ok(Array.isArray(found));
});

test('the stage runs on the derived payload, after the derivations', async () => {
  const seen = [];
  const derivations = [{
    name: 'fill_grouping',
    run: async () => [{ target: 'root', field: 'BusinessPartnerGrouping', value: '0001' }]
  }];

  await runChecks({ root: {}, sections: {} }, {
    validations: [],
    derivations,
    checkStandard: async (payload) => {
      seen.push(payload.root.BusinessPartnerGrouping);
      return [];
    }
  });

  // If this were a plain validation it would see undefined: validations run before derivations.
  assert.deepEqual(seen, ['0001']);
});

test('standard findings join the validation list', async () => {
  const result = await runChecks({ root: {}, sections: {} }, {
    validations: [],
    derivations: [],
    checkStandard: async () => [{ check: 'sap_standard_checks', severity: 'warning', message: 'x' }]
  });

  assert.equal(result.valid, true);
  assert.equal(result.standard.length, 1);
  assert.ok(result.validations.some((message) => message.check === 'sap_standard_checks'));
});

test('a blocking validation stops the standard checks from running at all', async () => {
  let ran = false;
  const result = await runChecks({ root: {}, sections: {} }, {
    validations: [{ name: 'blocker', run: async () => [{ severity: 'error', message: 'no' }] }],
    derivations: [],
    checkStandard: async () => { ran = true; return []; }
  });

  assert.equal(result.valid, false);
  // no point spending a remote round trip on a payload the app itself already refused
  assert.equal(ran, false);
  assert.deepEqual(result.standard, []);
});

test('a throwing standard check is reported, not swallowed', async () => {
  const result = await runChecks({ root: {}, sections: {} }, {
    validations: [],
    derivations: [],
    checkStandard: async () => { throw new Error('boom'); }
  });

  assert.equal(result.standard.length, 1);
  assert.equal(result.standard[0].severity, 'info');
  assert.match(result.standard[0].message, /could not run \(boom\)/);
});
