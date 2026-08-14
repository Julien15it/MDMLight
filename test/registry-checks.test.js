'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRegistryStages, addressDerivations, severityOf, describeEntity
} = require('../srv/checks/registry-checks');
const { runChecks } = require('../srv/checks/pipeline');

const payload = (root = {}, sections = {}) => ({ root, sections });

const stages = (enrichResult, spy) => createRegistryStages({
  enrich: async (...args) => {
    if (spy) spy.calls += 1;
    return enrichResult;
  }
});

const empty = { findings: [], facts: { vies: [], gleif: [] }, provenance: [] };

test('a VAT number VIES does not know blocks the rest of the pipeline', async () => {
  const registry = stages({
    ...empty,
    findings: [{ check: 'vat_registered', severity: 'error', message: 'VAT number BE0999 is not registered in VIES.' }]
  });
  const result = await runChecks(payload({ OrganizationBPName1: 'Alluvion' }), {
    validations: registry.validations,
    derivations: registry.derivations,
    checkDuplicates: async () => [{ verdict: 'duplicate' }]
  });
  assert.equal(result.valid, false);
  assert.equal(result.ranDuplicateCheck, false, 'invalid data is not compared against anything');
  assert.equal(result.validations[0].severity, 'error');
  assert.equal(result.validations[0].field, 'BPTaxNumber');
});

// registry.js grades a name mismatch as a warning for the submit path, where nothing blocks.
// The Check button re-grades it, so the two callers can disagree without either being changed.
test('a name that disagrees with VIES is re-graded to a blocking error', async () => {
  const registry = stages({
    ...empty,
    findings: [{
      check: 'vat_name_matches',
      severity: 'warning',
      message: 'VIES registers BE0123 as “Alluvion NV”, not “Aluvion”.'
    }]
  });
  const messages = await registry.validations[0].run(payload());
  assert.equal(messages[0].severity, 'error');
  assert.match(messages[0].message, /not “Aluvion”/u);
});

// VIES answers isValid:false when a member state is merely throttled. Blocking on that would
// train people to ignore the finding entirely.
// registry.js uses check `vat_registered` for BOTH "not registered" and "could not confirm",
// separated only by severity — so re-grading by check name alone would block on an outage.
test('a member state that could not be reached never blocks', async () => {
  const registry = stages({
    ...empty,
    findings: [{ check: 'vat_registered', severity: 'info', message: 'VIES could not confirm BE0123 (MS_UNAVAILABLE).' }]
  });
  const result = await runChecks(payload(), {
    validations: registry.validations,
    derivations: registry.derivations,
    checkDuplicates: async () => []
  });
  assert.equal(result.valid, true);
  assert.equal(result.validations[0].severity, 'info');
});

test('an empty address row is filled from VIES and reported', async () => {
  const registry = stages({
    ...empty,
    facts: {
      vies: [{ address: { StreetName: 'Kerkstraat', HouseNumber: '12', CityName: 'Gent', Country: 'BE' } }],
      gleif: []
    }
  });
  const result = await runChecks(
    payload({}, { Addresses: [{ StreetName: '', HouseNumber: '', CityName: 'Gent' }] }),
    { validations: registry.validations, derivations: registry.derivations, checkDuplicates: async () => [] }
  );
  const row = result.derived.sections.Addresses[0];
  assert.equal(row.StreetName, 'Kerkstraat');
  assert.equal(row.HouseNumber, '12');
  assert.equal(row.CityName, 'Gent', 'what the user typed is left alone');
  assert.ok(result.derivations.some((entry) => /from VIES/u.test(entry.message)));
});

// A member state's own register outranks a self-reported GLEIF address; whichever lands first
// wins, because the pipeline refuses to overwrite a filled field.
test('VIES is applied before GLEIF', async () => {
  const registry = stages({
    ...empty,
    facts: {
      vies: [{ address: { StreetName: 'Kerkstraat' } }],
      gleif: [{ address: { StreetName: 'Marktplein' } }]
    }
  });
  const { derived } = await runChecks(payload({}, { Addresses: [{ StreetName: '' }] }), {
    validations: registry.validations, derivations: registry.derivations
  });
  assert.equal(derived.sections.Addresses[0].StreetName, 'Kerkstraat');
});

test('only the first address is enriched, never a second deliberate one', () => {
  const entries = addressDerivations(
    [{ StreetName: 'Kerkstraat' }],
    [{ StreetName: '' }, { StreetName: '' }],
    'GLEIF'
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].index, 0);
});

test('nothing is derived when the registry returned no address', () => {
  assert.deepEqual(addressDerivations([], [{ StreetName: '' }], 'VIES'), []);
  assert.deepEqual(addressDerivations([{ StreetName: 'x' }], [], 'VIES'), []);
});

// One press of Check is one lookup: VIES throttles per member state and GLEIF is a public API.
test('the validation and the derivation share a single lookup', async () => {
  const spy = { calls: 0 };
  const registry = stages(empty, spy);
  await runChecks(payload({ OrganizationBPName1: 'Alluvion' }), {
    validations: registry.validations,
    derivations: registry.derivations,
    checkDuplicates: async () => []
  });
  assert.equal(spy.calls, 1);
});

test('a fresh pair per check does not reuse the previous answer', async () => {
  const spy = { calls: 0 };
  await runChecks(payload(), { validations: stages(empty, spy).validations });
  await runChecks(payload(), { validations: stages(empty, spy).validations });
  assert.equal(spy.calls, 2);
});

// Ambiguity is not a reason to guess — registry.js only exposes an identifier when exactly one
// entity matched closely, and this inherits that rather than restating it.
test('a single confident GLEIF hit is described, two hits say nothing', async () => {
  const one = stages({
    ...empty,
    facts: {
      vies: [],
      gleif: [{
        legalName: 'ALLUVION BV',
        lei: '549300ABCDEFGHIJKL01',
        registeredAs: '0448207405',
        address: { StreetName: 'Koedreef', HouseNumber: '12', PostalCode: '2000', CityName: 'Antwerpen', Country: 'BE' }
      }]
    }
  });
  const entries = await one.derivations[0].run(payload({}, { TaxNumbers: [] }));
  assert.equal(entries.length, 1);
  // The name leads and nothing is written: a company number alone told nobody whether GLEIF had
  // found the right company.
  assert.equal(entries[0].field, undefined);
  assert.match(entries[0].message, /GLEIF found “ALLUVION BV”/u);
  assert.match(entries[0].message, /Koedreef 12, 2000 Antwerpen, BE/u);
  assert.match(entries[0].message, /company number 0448207405/u);

  const two = stages({
    ...empty,
    facts: { vies: [], gleif: [{ registeredAs: '1' }, { registeredAs: '2' }] }
  });
  assert.deepEqual(await two.derivations[0].run(payload({}, { TaxNumbers: [] })), []);
});

test('a GLEIF hit with no address is still described', () => {
  const message = describeEntity({ legalName: 'ALLUVION BV', registeredAs: '0448207405' });
  assert.match(message, /GLEIF found “ALLUVION BV” \(company number 0448207405\)/u);
  assert.equal(/ at /u.test(message), false);
});

// A registry that is down must not read as "the data is fine" — the validation blocks instead.
test('an enrichment that throws blocks rather than passing silently', async () => {
  const registry = createRegistryStages({
    enrich: async () => { throw new Error('GLEIF timed out'); }
  });
  const result = await runChecks(payload(), {
    validations: registry.validations,
    derivations: registry.derivations,
    checkDuplicates: async () => []
  });
  assert.equal(result.valid, false);
  assert.match(result.validations[0].message, /registry could not run: GLEIF timed out/u);
});

test('the severity table re-grades only the name mismatch', () => {
  assert.equal(severityOf({ check: 'vat_registered', severity: 'error' }), 'error');
  assert.equal(severityOf({ check: 'vat_registered', severity: 'info' }), 'info');
  assert.equal(severityOf({ check: 'vat_name_matches', severity: 'warning' }), 'error');
  assert.equal(severityOf({ check: 'something_new' }), 'info');
});

test('the GLEIF company number is reported as a plain fact', async () => {
  const registry = stages({
    ...empty,
    facts: { vies: [], gleif: [{ registeredAs: '0448207405', address: null }] }
  });
  const [entry] = await registry.derivations[0].run(payload({}, { TaxNumbers: [] }));
  assert.match(entry.message, /company number 0448207405/u);
  assert.equal(/tax number row|Nothing was filled in/u.test(entry.message), false);
});
