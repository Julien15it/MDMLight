'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VALIDATIONS, DERIVATIONS, runValidations, runDerivations, runChecks
} = require('../srv/checks/pipeline');

const blocker = (message) => ({
  name: 'blocker',
  run: () => [{ field: 'BusinessPartnerGrouping', severity: 'error', message }]
});
const nagger = (message) => ({ name: 'nagger', run: () => [{ severity: 'warning', message }] });
const fillCountry = { name: 'fillCountry', run: () => ({ Country: 'BE' }) };

// They are empty on purpose: the order is being fixed now, while there is one caller and no rules.
test('the registries ship empty, so nothing is validated or derived yet', () => {
  assert.deepEqual(VALIDATIONS, []);
  assert.deepEqual(DERIVATIONS, []);
});

test('an empty ruleset is valid and still runs the duplicate check', async () => {
  const result = await runChecks({ Name: 'Alluvion' }, { checkDuplicates: async () => [] });
  assert.equal(result.valid, true);
  assert.equal(result.ranDuplicateCheck, true);
  assert.deepEqual(result.validations, []);
  assert.deepEqual(result.derivations, []);
});

// The ordering rationale, as a test: invalid data cannot be a duplicate of anything.
test('a blocking validation stops derivation and the duplicate check', async () => {
  let checked = false;
  const result = await runChecks({}, {
    validations: [blocker('Enter a grouping.')],
    derivations: [fillCountry],
    checkDuplicates: async () => { checked = true; return []; }
  });
  assert.equal(result.valid, false);
  assert.equal(checked, false, 'the duplicate check must not run on invalid data');
  assert.deepEqual(result.derivations, []);
  assert.equal(result.ranDuplicateCheck, false);
  assert.equal(result.duplicates.length, 0);
});

test('a warning does not block, so the rest still runs', async () => {
  const result = await runChecks({}, {
    validations: [nagger('Search term is short.')],
    derivations: [fillCountry],
    checkDuplicates: async () => []
  });
  assert.equal(result.valid, true);
  assert.equal(result.validations.length, 1);
  assert.equal(result.derived.Country, 'BE');
});

// Incomplete data can be missing the very field a duplicate rule needs, which is why derivation
// comes first rather than after.
test('the duplicate check sees the derived record, not the raw one', async () => {
  let seen = null;
  await runChecks({ Name: 'Alluvion' }, {
    derivations: [fillCountry],
    checkDuplicates: async (candidate) => { seen = candidate; return []; }
  });
  assert.equal(seen.Country, 'BE');
  assert.equal(seen.Name, 'Alluvion');
});

test('a derivation fills a gap and never overwrites what was typed', () => {
  const { derived, applied } = runDerivations({ Country: 'NL' }, [fillCountry]);
  assert.equal(derived.Country, 'NL', 'a derivation must not correct the user');
  assert.deepEqual(applied, []);

  const empty = runDerivations({ Country: '' }, [fillCountry]);
  assert.equal(empty.derived.Country, 'BE');
  assert.equal(empty.applied[0].field, 'Country');
  assert.match(empty.applied[0].message, /derived as BE/u);
});

test('the candidate itself is never mutated', async () => {
  const candidate = { Name: 'Alluvion' };
  await runChecks(candidate, { derivations: [fillCountry], checkDuplicates: async () => [] });
  assert.equal(candidate.Country, undefined);
});

// A rule that throws must not be indistinguishable from a rule that passed.
test('a validation that throws blocks instead of passing silently', () => {
  const messages = runValidations({}, [{
    name: 'explodes', run: () => { throw new Error('bad regex'); }
  }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 'error');
  assert.match(messages[0].message, /explodes could not run: bad regex/u);
});

// A derivation is an improvement, not a gate: the check on thinner data still beats no check.
test('a derivation that throws reports itself and the pipeline carries on', async () => {
  const result = await runChecks({ Name: 'Alluvion' }, {
    derivations: [{ name: 'explodes', run: () => { throw new Error('no service'); } }],
    checkDuplicates: async () => []
  });
  assert.equal(result.valid, true);
  assert.equal(result.ranDuplicateCheck, true);
  assert.match(result.derivations[0].message, /explodes could not run: no service/u);
});

// "No duplicates found" from a check that never ran is the one wrong answer this must not give.
test('a duplicate check that throws is reported, not folded into an empty result', async () => {
  const result = await runChecks({}, {
    checkDuplicates: async () => { throw new Error('index is away'); }
  });
  assert.equal(result.valid, true);
  assert.equal(result.duplicates.length, 1);
  assert.match(result.duplicates[0].message, /could not run \(index is away\)/u);
  assert.equal(result.duplicates[0].verdict, undefined, 'it is not a verdict, so it asks nothing of the user');
});

test('every validation runs, so one failure does not hide the next', () => {
  const messages = runValidations({}, [blocker('first'), nagger('second')]);
  assert.deepEqual(messages.map((message) => message.message), ['first', 'second']);
  assert.deepEqual(messages.map((message) => message.check), ['blocker', 'nagger']);
});
