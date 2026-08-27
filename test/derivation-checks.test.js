'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createDerivationStages, invalidate, _internals } = require('../srv/checks/derivation-checks');
const { runDerivations } = require('../srv/checks/pipeline');

const { addressLanguageEntries, taxCategoryEntries } = _internals;

// T005 and TSTL as the service serves them. Column names are the view aliases, read from the live
// $metadata on 2026-08-27 rather than guessed -- see mdmlbpcheck/README.md.
const CONFIG = Object.freeze({
  countries: [
    { Country: 'BE', AddressLanguage: 'N', NameFormat: '01', IsEuCountry: true },
    { Country: 'DE', AddressLanguage: 'D', NameFormat: '01', IsEuCountry: true },
    // A country S/4 knows but has no language for: nothing to derive, and not an error.
    { Country: 'XX', AddressLanguage: '', NameFormat: '', IsEuCountry: false }
  ],
  taxCategories: [
    { Country: 'BE', SequenceNumber: '1', TaxCategory: 'MWST' },
    { Country: 'US', SequenceNumber: '1', TaxCategory: 'UTXJ' },
    { Country: 'US', SequenceNumber: '2', TaxCategory: 'UTX2' }
  ]
});

const payload = (root = {}, sections = {}) => ({ root, sections });
const read = async () => CONFIG;

const stages = () => createDerivationStages({ read }).derivations;

test.beforeEach(() => invalidate());

// --- Address language ------------------------------------------------------

// The derivation that already cost a production bug: FSBP_GENERIC/008 fires on a blank LANGU, and
// a requester has no way of knowing the right answer when S/4 has known all along.
test('the address language is derived from the country', () => {
  const entries = addressLanguageEntries(
    payload({}, { Addresses: [{ Country: 'BE' }] }),
    CONFIG
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, 'Addresses');
  assert.equal(entries[0].index, 0);
  assert.equal(entries[0].field, 'Language');
  assert.equal(entries[0].value, 'N');
  assert.equal(entries[0].label, 'Country default');
  assert.match(entries[0].message, /S\/4 requires an address language/u);
});

// Unlike the registry lookup, this is not a fact about ONE place. Every address in a country has
// that country's default language.
test('every address row is derived, not only the first', () => {
  const entries = addressLanguageEntries(
    payload({}, { Addresses: [{ Country: 'BE' }, { Country: 'DE' }] }),
    CONFIG
  );

  assert.deepEqual(entries.map((entry) => [entry.index, entry.value]), [[0, 'N'], [1, 'D']]);
});

test('a typed language is left alone, and so is a row with no country', () => {
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ Country: 'BE', Language: 'E' }] }), CONFIG),
    []
  );
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ CityName: 'Gent' }] }), CONFIG),
    []
  );
});

test('a country S/4 has no language for derives nothing, and is not an error', () => {
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ Country: 'XX' }] }), CONFIG),
    []
  );
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ Country: 'ZZ' }] }), CONFIG),
    []
  );
});

test('a row on its way out is not derived onto', () => {
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ Country: 'BE', action: 'D' }] }), CONFIG),
    []
  );
});

// --- Tax categories --------------------------------------------------------

test('a customer request proposes the tax category valid for its country', () => {
  const entries = taxCategoryEntries(
    payload({}, { Addresses: [{ Country: 'BE' }], Customers: [{ CustomerAccountGroup: 'KUNA' }] }),
    CONFIG
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, 'CustomerTaxIndicators');
  assert.equal(entries[0].field, 'CustomerTaxCategory');
  assert.equal(entries[0].value, 'MWST');
  assert.equal(entries[0].createsRow, true);
  // The classification is a decision about this customer, not something customizing knows.
  assert.match(entries[0].message, /left\s+for you to fill in/u);
});

// A silent partial answer would read as "these are all of them", which is the answer this codebase
// refuses everywhere else.
test('a country with several categories says how many, rather than covering one silently', () => {
  const entries = taxCategoryEntries(
    payload({}, { Addresses: [{ Country: 'US' }], Customers: [{}] }),
    CONFIG
  );

  assert.equal(entries.length, 2);
  assert.equal(entries[0].value, 'UTXJ', 'the lowest sequence number is the one proposed');
  // The second entry carries no field: a statement, not a value, so it renders as a strip.
  assert.equal(entries[1].field, undefined);
  assert.match(entries[1].message, /2 tax categories/u);
  assert.match(entries[1].message, /UTXJ, UTX2/u);
});

test('nothing is proposed without a customer, a country, or into rows somebody added', () => {
  const country = { Addresses: [{ Country: 'BE' }] };
  // Not a customer request at all.
  assert.deepEqual(taxCategoryEntries(payload({}, country), CONFIG), []);
  // No address, so no departure country.
  assert.deepEqual(taxCategoryEntries(payload({}, { Customers: [{}] }), CONFIG), []);
  // The requester already filled the section in; those rows are theirs.
  assert.deepEqual(
    taxCategoryEntries(payload({}, {
      ...country,
      Customers: [{}],
      CustomerTaxIndicators: [{ CustomerTaxCategory: 'MWST' }]
    }), CONFIG),
    []
  );
  // A country with no tax categories at all.
  assert.deepEqual(
    taxCategoryEntries(payload({}, { Addresses: [{ Country: 'DE' }], Customers: [{}] }), CONFIG),
    []
  );
});

// --- Through the pipeline --------------------------------------------------

test('the stage reaches the payload through the pipeline, as a proposal', async () => {
  const request = payload({}, { Addresses: [{ Country: 'BE', CityName: 'Gent' }] });
  const { derived, applied } = await runDerivations(request, stages());

  assert.equal(derived.sections.Addresses[0].Language, 'N');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].check, 'sap_derivations');
  assert.equal(applied[0].label, 'Country default');
});

// The flag says "S/4 will use this whatever anyone ticks" -- true of the CVI account group and of
// nothing here. A country default is a proposal like any other.
test('nothing here is a system derivation, so the standard checks never see it unaccepted', async () => {
  const request = payload({}, { Addresses: [{ Country: 'BE' }] });
  const { applied, systemDerived } = await runDerivations(request, stages());

  assert.equal(applied.every((entry) => entry.system === false), true);
  assert.equal(systemDerived.sections.Addresses[0].Language, undefined);
});

test('the payload the requester typed is never mutated', async () => {
  const request = payload({}, { Addresses: [{ Country: 'BE' }] });
  await runDerivations(request, stages());
  assert.equal(request.sections.Addresses[0].Language, undefined);
});

// An improvement, not a gate -- the same discipline cvi-checks.js applies to an unreadable config.
test('settings that cannot be read report themselves and never block', async () => {
  const failing = createDerivationStages({
    read: async () => { throw new Error('destination is away'); }
  }).derivations;

  const { applied, derived } = await runDerivations(
    payload({}, { Addresses: [{ Country: 'BE' }] }),
    failing
  );

  assert.equal(applied.length, 1);
  assert.equal(applied[0].severity, 'info');
  assert.match(applied[0].message, /could not be read \(destination is away\)/u);
  assert.equal(derived.sections.Addresses[0].Language, undefined);
});

test('the settings are read once and cached across runs', async () => {
  let reads = 0;
  const counting = createDerivationStages({
    read: async () => { reads += 1; return CONFIG; }
  }).derivations;

  await runDerivations(payload({}, { Addresses: [{ Country: 'BE' }] }), counting);
  await runDerivations(payload({}, { Addresses: [{ Country: 'DE' }] }), counting);
  assert.equal(reads, 1);
});

// --- Wiring ----------------------------------------------------------------

test('the stage runs on Check and Duplicate Check, and still not on submit', () => {
  const serviceJs = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );

  assert.match(serviceJs, /createDerivationStages\(\)\.derivations/u);
  // LAST in the list: the pipeline never overwrites, so a steward's rule and a register lookup
  // both outrank a country default.
  assert.match(
    serviceJs,
    /createCviStages\(\)\.derivations, \.\.\.createDerivationStages\(\)\.derivations\]/u
  );
  // Submit still validates without deriving, unchanged since 2026-08-13.
  const submit = serviceJs.slice(serviceJs.indexOf("this.on('submitRequest'"));
  assert.equal(/createDerivationStages/u.test(submit), false);
});
