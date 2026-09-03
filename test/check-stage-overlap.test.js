'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runChecks } = require('../srv/checks/pipeline');

const PAYLOAD = { root: {}, sections: {} };

/** A promise plus its resolve, so a stage can be held open while the others are checked. */
function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

// The whole point of the change: on the data steward step `propose` is an AI Core round trip and
// `checkStandard` an S/4 dry run, and run one after another their latencies added. None of the
// three reads another's output, so a stage still waiting must not hold the next one back.
test('the three post-derivation stages run at the same time, not one after another', async () => {
  const started = [];
  const held = deferred();

  let othersStartedBeforeProposeFinished = [];

  const result = await runChecks(PAYLOAD, {
    validations: [],
    derivations: [],
    propose: async () => {
      started.push('propose');
      // Released once every stage has been entered. The timer is the regression path, not a
      // fallback: run sequentially nothing else can start while this is pending, so the race ends
      // on the timeout with `started` still holding one name and the assertion below fails - a
      // clean failure rather than a test run that hangs for ever.
      await Promise.race([held.promise, new Promise((settle) => { setTimeout(settle, 250); })]);
      othersStartedBeforeProposeFinished = [...started];
      return [{ target: 'root', index: 0, field: 'OrganizationBPName1', value: 'X' }];
    },
    checkStandard: async () => {
      started.push('standard');
      if (started.length === 3) held.resolve();
      return [];
    },
    checkDuplicates: async () => {
      started.push('duplicates');
      if (started.length === 3) held.resolve();
      return [];
    }
  });

  assert.deepEqual(
    othersStartedBeforeProposeFinished.sort(), ['duplicates', 'propose', 'standard'],
    'the standard and duplicate stages must start while the normalisation is still pending'
  );
  assert.equal(result.normalisations.length, 1, 'the held stage still contributed its result');
});

// Three failure behaviours that are deliberately different, which is why this is three catches and
// not one allSettled: a normalisation is a convenience, the other two must say they did not run.
test('a failing normalisation degrades to nothing and leaves the other two alone', async () => {
  const result = await runChecks(PAYLOAD, {
    validations: [],
    derivations: [],
    propose: async () => { throw new Error('AI Core unavailable'); },
    checkStandard: async () => [{ check: 'sap_standard_checks', severity: 'warning', message: 'x' }],
    checkDuplicates: async () => []
  });

  assert.deepEqual(result.normalisations, []);
  assert.equal(result.standard.length, 1, 'the standard checks still ran and still reported');
  assert.equal(result.ranDuplicateCheck, true);
});

test('a failing duplicate check reports itself rather than reading as "none found"', async () => {
  const result = await runChecks(PAYLOAD, {
    validations: [],
    derivations: [],
    propose: async () => [],
    checkDuplicates: async () => { throw new Error('index not built'); }
  });

  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].checkName, 'duplicate_check');
  assert.match(result.duplicates[0].message, /could not run \(index not built\)/u);
  // Still true: the check was asked for, and the caller has to know the answer is not "clean".
  assert.equal(result.ranDuplicateCheck, true);
});

test('a failing standard check says so instead of passing silently', async () => {
  const result = await runChecks(PAYLOAD, {
    validations: [],
    derivations: [],
    checkStandard: async () => { throw new Error('destination down'); }
  });

  assert.equal(result.standard.length, 1);
  assert.equal(result.standard[0].check, 'sap_standard_checks');
  assert.match(result.standard[0].message, /could not run \(destination down\)/u);
  // They join the validation list, because to a requester they are validations.
  assert.ok(result.validations.some((entry) => entry.check === 'sap_standard_checks'));
});

// A stage that throws before its first await used to land in the surrounding try; wrapped in a
// promise it has to land in its own catch instead, or a synchronous failure escapes runChecks.
test('a stage that throws synchronously still lands in its own fallback', async () => {
  const result = await runChecks(PAYLOAD, {
    validations: [],
    derivations: [],
    propose: () => { throw new Error('bad config'); },
    checkDuplicates: () => { throw new Error('no connection'); }
  });

  assert.deepEqual(result.normalisations, []);
  assert.equal(result.duplicates.length, 1);
  assert.match(result.duplicates[0].message, /no connection/u);
});

// Nothing asked for means nothing run - the stage list is what decides, not the payload.
test('stages that were not supplied contribute nothing and are not reported as failed', async () => {
  const result = await runChecks(PAYLOAD, { validations: [], derivations: [] });
  assert.deepEqual(result.normalisations, []);
  assert.deepEqual(result.standard, []);
  assert.deepEqual(result.duplicates, []);
  assert.equal(result.ranDuplicateCheck, false);
});
