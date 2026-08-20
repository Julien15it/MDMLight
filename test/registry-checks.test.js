'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRegistryStages, addressDerivations, severityOf, describeEntity, fieldFor,
  NAME_MISMATCH_SEVERITY
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

// It blocked until 2026-08-14. Blocking stopped the whole pipeline, so a trading name cost the
// requester the derivations and the proposals too - and VIES returns the legal name.
test('a name that disagrees with VIES warns without blocking', async () => {
  const registry = stages({
    ...empty,
    findings: [{
      check: 'vat_name_matches',
      severity: 'warning',
      message: 'VIES registers BE0123 as “Alluvion NV”, not “Aluvion”.'
    }]
  });
  const messages = await registry.validations[0].run(payload());
  assert.equal(messages[0].severity, 'warning');
  assert.match(messages[0].message, /not “Aluvion”/u);

  // The point of the change: everything after validation still runs.
  const result = await runChecks(payload(), {
    validations: registry.validations,
    derivations: registry.derivations,
    propose: async () => [{ target: 'root', index: 0, field: 'OrganizationBPName1', current: 'x', proposed: 'X', reason: 'casing' }],
    checkDuplicates: async () => []
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalisations.length, 1);
  assert.equal(result.ranDuplicateCheck, true);
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
  assert.deepEqual(addressDerivations([], [], 'VIES'), []);
});

// The case that started the row-adding change (2026-08-20): a tax number is typed, VIES answers with
// an address, and there is nowhere to put it because the requester has not pressed Add. It refused
// to invent the row until then, which is precisely when the lookup is most useful.
test('the registry proposes the first address when there is no row to hold it', () => {
  const entries = addressDerivations([{ StreetName: 'Kerkstraat', CityName: 'Gent' }], [], 'VIES');

  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.createsRow === true), 'the row has to be created too');
  assert.ok(entries.every((entry) => entry.index === 0));
  // The requester has to be able to tell a row they did not build from a field they left blank.
  assert.match(entries[0].message, /a new address/u);

  // A row that already exists is filled, and is never flagged as a new one.
  const filled = addressDerivations([{ StreetName: 'Kerkstraat' }], [{ StreetName: '' }], 'VIES');
  assert.equal(filled[0].createsRow, undefined);
  assert.doesNotMatch(filled[0].message, /a new address/u);
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

  // The description is a statement, not a value - it carries no field and nothing can apply it.
  const described = entries.filter((entry) => !entry.field);
  assert.equal(described.length, 1);
  // The name leads and nothing is written: a company number alone told nobody whether GLEIF had
  // found the right company.
  assert.match(described[0].message, /GLEIF found “ALLUVION BV”/u);
  assert.match(described[0].message, /Koedreef 12, 2000 Antwerpen, BE/u);
  assert.match(described[0].message, /company number 0448207405/u);

  // The address it found is proposed as a new row, because the payload holds none (2026-08-20).
  const address = entries.filter((entry) => entry.field);
  assert.equal(address.length, 5, 'one per address field GLEIF answered with');
  assert.ok(address.every((entry) => entry.target === 'Addresses' && entry.createsRow === true));

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

// Nothing is re-graded upwards now, but the knob stays: re-grading by check NAME rather than by
// severity is what would block on an outage, since vat_registered carries both meanings.
test('the severity table never turns a warning or an outage into a block', () => {
  assert.equal(severityOf({ check: 'vat_registered', severity: 'error' }), 'error');
  assert.equal(severityOf({ check: 'vat_registered', severity: 'info' }), 'info');
  assert.equal(severityOf({ check: 'vat_name_matches', severity: 'warning' }), 'warning');
  assert.equal(severityOf({ check: 'something_new' }), 'info');
  assert.equal(NAME_MISMATCH_SEVERITY, 'warning');
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

// VIES validates and derives; it never proposes. A disagreement is said out loud instead.
test('a register address that disagrees is a warning about the address, not the tax number', () => {
  assert.equal(fieldFor({ check: 'vat_address_matches' }), 'StreetName');
  assert.equal(fieldFor({ check: 'vat_registered' }), 'BPTaxNumber');
  assert.equal(fieldFor({ check: 'vat_name_matches' }), 'BPTaxNumber');
  assert.equal(fieldFor({ check: 'something_else' }), null);
  // Only the name mismatch is re-graded; an address disagreement must never block.
  assert.equal(severityOf({ check: 'vat_address_matches', severity: 'warning' }), 'warning');
});

test('the registry stages no longer propose anything', () => {
  const registry = createRegistryStages({ enrich: async () => empty });
  assert.equal(registry.propose, undefined);
  assert.equal(registry.validations.length, 1);
  assert.equal(registry.derivations.length, 1);
});
