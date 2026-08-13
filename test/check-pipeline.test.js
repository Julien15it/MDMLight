'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VALIDATIONS, DERIVATIONS, runValidations, runDerivations, runChecks
} = require('../srv/checks/pipeline');

const payload = (root = {}, sections = {}) => ({ root, sections });

const blocker = (message) => ({
  name: 'blocker',
  run: async () => [{ field: 'BusinessPartnerGrouping', severity: 'error', message }]
});
const nagger = (message) => ({ name: 'nagger', run: async () => [{ severity: 'warning', message }] });
const fillCountry = {
  name: 'fillCountry',
  run: async () => [{ target: 'root', field: 'Country', value: 'BE' }]
};
const fillStreet = {
  name: 'registry',
  run: async () => [{
    target: 'Addresses', index: 0, field: 'StreetName', value: 'Kerkstraat',
    message: 'StreetName was filled in as “Kerkstraat” from GLEIF.'
  }]
};

// They are empty on purpose: the order is being fixed now, while there is one caller and no rules.
test('the registries ship empty, so nothing is validated or derived yet', () => {
  assert.deepEqual(VALIDATIONS, []);
  assert.deepEqual(DERIVATIONS, []);
});

test('an empty ruleset is valid and still runs the duplicate check', async () => {
  const result = await runChecks(payload({ Name: 'Alluvion' }), { checkDuplicates: async () => [] });
  assert.equal(result.valid, true);
  assert.equal(result.ranDuplicateCheck, true);
  assert.deepEqual(result.validations, []);
  assert.deepEqual(result.derivations, []);
});

// The ordering rationale, as a test: invalid data cannot be a duplicate of anything.
test('a blocking validation stops derivation and the duplicate check', async () => {
  let checked = false;
  const result = await runChecks(payload(), {
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
  const result = await runChecks(payload(), {
    validations: [nagger('Search term is short.')],
    derivations: [fillCountry],
    checkDuplicates: async () => []
  });
  assert.equal(result.valid, true);
  assert.equal(result.validations.length, 1);
  assert.equal(result.derived.root.Country, 'BE');
});

// Incomplete data can be missing the very field a duplicate rule needs, which is why derivation
// comes first rather than after.
test('the duplicate check sees the derived payload, not the typed one', async () => {
  let seen = null;
  await runChecks(payload({ Name: 'Alluvion' }), {
    derivations: [fillCountry],
    checkDuplicates: async (given) => { seen = given; return []; }
  });
  assert.equal(seen.root.Country, 'BE');
  assert.equal(seen.root.Name, 'Alluvion');
});

// The reason the pipeline works on { root, sections }: a street belongs to an address row.
test('a derivation can fill a field on a section row', async () => {
  const { derived, applied } = await runDerivations(
    payload({}, { Addresses: [{ CityName: 'Gent', StreetName: '' }] }),
    [fillStreet]
  );
  assert.equal(derived.sections.Addresses[0].StreetName, 'Kerkstraat');
  assert.equal(derived.sections.Addresses[0].CityName, 'Gent', 'a filled field is untouched');
  assert.equal(applied[0].target, 'Addresses');
  assert.equal(applied[0].index, 0);
  assert.match(applied[0].message, /from GLEIF/u);
});

// Filling a street into an address the user never added would create data nobody asked for — but
// staying silent about it would waste the lookup, so it is reported with no field to write.
test('a derivation never invents the row it targets, and says so', async () => {
  const { derived, applied } = await runDerivations(payload({}, { Addresses: [] }), [fillStreet]);
  assert.deepEqual(derived.sections.Addresses, []);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].field, undefined, 'no field means the screen reports it and writes nothing');
  assert.match(applied[0].message, /Kerkstraat/u);
});

test('a derivation fills a gap and never overwrites what was typed', async () => {
  const typed = await runDerivations(payload({ Country: 'NL' }), [fillCountry]);
  assert.equal(typed.derived.root.Country, 'NL', 'a derivation must not correct the user');
  assert.deepEqual(typed.applied, []);

  const blank = await runDerivations(payload({ Country: '   ' }), [fillCountry]);
  assert.equal(blank.derived.root.Country, 'BE', 'whitespace is empty');
  assert.equal(blank.applied[0].field, 'Country');
});

test('the payload itself is never mutated', async () => {
  const original = payload({ Name: 'Alluvion' }, { Addresses: [{ StreetName: '' }] });
  await runChecks(original, {
    derivations: [fillCountry, fillStreet],
    checkDuplicates: async () => []
  });
  assert.equal(original.root.Country, undefined);
  assert.equal(original.sections.Addresses[0].StreetName, '');
});

// A rule that throws must not be indistinguishable from a rule that passed.
test('a validation that throws blocks instead of passing silently', async () => {
  const messages = await runValidations(payload(), [{
    name: 'explodes', run: async () => { throw new Error('bad regex'); }
  }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 'error');
  assert.match(messages[0].message, /explodes could not run: bad regex/u);
});

// A derivation is an improvement, not a gate: the check on thinner data still beats no check.
test('a derivation that throws reports itself and the pipeline carries on', async () => {
  const result = await runChecks(payload({ Name: 'Alluvion' }), {
    derivations: [{ name: 'explodes', run: async () => { throw new Error('no service'); } }],
    checkDuplicates: async () => []
  });
  assert.equal(result.valid, true);
  assert.equal(result.ranDuplicateCheck, true);
  assert.match(result.derivations[0].message, /explodes could not run: no service/u);
});

// "No duplicates found" from a check that never ran is the one wrong answer this must not give.
test('a duplicate check that throws is reported, not folded into an empty result', async () => {
  const result = await runChecks(payload(), {
    checkDuplicates: async () => { throw new Error('index is away'); }
  });
  assert.equal(result.valid, true);
  assert.equal(result.duplicates.length, 1);
  assert.match(result.duplicates[0].message, /could not run \(index is away\)/u);
  assert.equal(result.duplicates[0].verdict, undefined, 'it is not a verdict, so it asks nothing of the user');
});

test('every validation runs, so one failure does not hide the next', async () => {
  const messages = await runValidations(payload(), [blocker('first'), nagger('second')]);
  assert.deepEqual(Array.from(messages, (message) => message.message), ['first', 'second']);
  assert.deepEqual(Array.from(messages, (message) => message.check), ['blocker', 'nagger']);
});
