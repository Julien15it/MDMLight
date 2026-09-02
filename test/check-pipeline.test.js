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
// Same answer, but asking for the row it needs - what the registry stages send since 2026-08-20.
const createsStreet = {
  name: 'registry',
  run: async () => [{
    target: 'Addresses', index: 0, createsRow: true, field: 'StreetName', value: 'Kerkstraat',
    message: 'StreetName was filled in as “Kerkstraat” from VIES (a new address).'
  }]
};
const fillStreet = {
  name: 'registry',
  run: async () => [{
    target: 'Addresses', index: 0, field: 'StreetName', value: 'Kerkstraat',
    message: 'StreetName was filled in as “Kerkstraat” from GLEIF.'
  }]
};

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

/**
 * Changed 2026-08-20. A registry answer used to be reported as homeless when the requester had not
 * pressed Add yet, so a VIES address could never be proposed on a partner without an address row -
 * exactly the case where it is most useful. The derivation now asks for the row and the pipeline
 * creates it; the requester still ticks the proposal, so nothing is written unasked.
 */
test('a derivation may create the first row of an empty section, when it asks to', async () => {
  const { derived, applied } = await runDerivations(payload({}, { Addresses: [] }), [createsStreet]);
  assert.equal(derived.sections.Addresses.length, 1);
  assert.equal(derived.sections.Addresses[0].StreetName, 'Kerkstraat');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].field, 'StreetName');
  assert.equal(applied[0].createsRow, true, 'the screen has to add the row too');
});

/** A section with no rows is the only case. Everything else is still never invented. */
test('a derivation still never invents a row beside one that exists', async () => {
  const { derived, applied } = await runDerivations(
    payload({}, { Addresses: [{ StreetName: 'Dorpsstraat' }] }),
    [{ name: 'registry', run: async () => [{
      target: 'Addresses', index: 1, createsRow: true, field: 'StreetName', value: 'Kerkstraat',
      message: 'StreetName is available but there is no second Addresses row.'
    }] }]
  );
  assert.equal(derived.sections.Addresses.length, 1, 'no second row appears');
  assert.equal(applied[0].field, undefined, 'reported as a statement, exactly as before');
});

/** Without the flag nothing changes: a derivation that never asked cannot create anything. */

test('a derivation fills a gap and never overwrites what was typed', async () => {
  const typed = await runDerivations(payload({ Country: 'NL' }), [fillCountry]);
  assert.equal(typed.derived.root.Country, 'NL', 'a derivation must not correct the user');
  assert.deepEqual(typed.applied, []);

  const blank = await runDerivations(payload({ Country: '   ' }), [fillCountry]);
  assert.equal(blank.derived.root.Country, 'BE', 'whitespace is empty');
  assert.equal(blank.applied[0].field, 'Country');
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

// --- Normalisation proposals ------------------------------------------------------------

// Proposals only. A derivation fills a gap and never overwrites; a normalisation only ever
// touches a field that already has a value, so it can never be applied without a human.
test('proposals ride along with the result and change nothing', async () => {
  const original = payload({ OrganizationBPName1: 'alluvion bvba' });
  const result = await runChecks(original, {
    propose: async () => [{
      target: 'root', index: 0, field: 'OrganizationBPName1',
      current: 'alluvion bvba', proposed: 'Alluvion BVBA', reason: 'legal form'
    }],
    checkDuplicates: async () => []
  });
  assert.equal(result.normalisations.length, 1);
  assert.equal(result.derived.root.OrganizationBPName1, 'alluvion bvba', 'nothing was applied');
  assert.equal(original.root.OrganizationBPName1, 'alluvion bvba');
});

// A registry fact with no field to live in - a legal name the requester already typed - is a
// statement. It used to rely on targetRecord happening to miss, which wrote root[undefined].
test('a derivation entry with no field is reported and writes nothing', async () => {
  const derivations = [{
    name: 'registry',
    run: async () => [{ message: 'GLEIF found “ALLUVION BV”.' }]
  }];
  const { derived, applied } = await runDerivations(
    { root: { OrganizationBPName1: 'Alluvion' }, sections: {} }, derivations
  );
  assert.equal(applied.length, 1);
  assert.equal(applied[0].severity, 'info');
  assert.match(applied[0].message, /ALLUVION BV/u);
  assert.deepEqual(derived.root, { OrganizationBPName1: 'Alluvion' }, 'nothing was written');
  assert.equal('undefined' in derived.root, false);
});

test('a field the predicate refuses gets no entry at all, and nothing is written', async () => {
  const { derived, applied } = await runDerivations(
    payload(), [fillCountry], { fieldEditable: () => false }
  );
  assert.equal(derived.root.Country, undefined, 'nothing was written for a field the role cannot touch');
  assert.deepEqual(applied, [], 'not even reported - see "what a derivation may say" in CLAUDE.md');
});

test('a field-less statement is checked against the entity, with field left undefined', async () => {
  const statement = { name: 'registry', run: async () => [{ target: 'Addresses', message: 'No row yet.' }] };
  const asked = [];
  const { applied } = await runDerivations(payload(), [statement], {
    fieldEditable: (target, field) => { asked.push([target, field]); return true; }
  });
  assert.deepEqual(asked, [['Addresses', undefined]]);
  assert.equal(applied.length, 1, 'still reported when the predicate allows it');
});

// Approval has nothing editable at all - a role whose profile marks every field readOnly/hidden
// must see nothing proposed, which is exactly the "in Approval stap niks tonen" ask.
test('a role editable on some fields and not others only loses the ones it cannot touch', async () => {
  const fillLanguage = { name: 'lang', run: async () => [{ target: 'root', field: 'Language', value: 'NL' }] };
  const onlyLanguage = (target, field) => field === 'Language';
  const { derived, applied } = await runDerivations(
    payload(), [fillCountry, fillLanguage], { fieldEditable: onlyLanguage }
  );
  assert.equal(derived.root.Country, undefined);
  assert.equal(derived.root.Language, 'NL');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].field, 'Language');
});
