'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const internals = require('../srv/business-partner-service')._internals;
const { oneRowPerTaxType, taxTypeLanguageRank, VALUE_HELP_ENTITIES } = internals;

const ROOT = path.join(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

const row = (language, code, name) => ({ Language: language, BPTaxType: code, TaxTypeName: name });

test('a category appears once, whatever the language rows say', () => {
  const rows = oneRowPerTaxType([
    row('EN', 'BE0', 'VAT number'),
    row('DE', 'BE0', 'USt-IdNr.'),
    row('NL', 'BE0', 'BTW-nummer'),
    row('EN', 'BE1', 'Enterprise number')
  ], 'en');
  assert.deepEqual(rows.map((entry) => entry.BPTaxType), ['BE0', 'BE1']);
  assert.equal(rows[0].TaxTypeName, 'VAT number');
});

// The encoding of the language key is not knowable from the metadata — String(2) covers both the
// ISO code and the one-character SAP key — and guessing wrong would empty the list, which is the
// failure this replaces.
test('the preferred language matches whether the key is EN or E', () => {
  assert.equal(oneRowPerTaxType([row('D', 'BE0', 'de'), row('E', 'BE0', 'en')], 'en')[0].TaxTypeName, 'en');
  assert.equal(oneRowPerTaxType([row('DE', 'BE0', 'de'), row('EN', 'BE0', 'en')], 'en')[0].TaxTypeName, 'en');
  assert.equal(oneRowPerTaxType([row('EN', 'BE0', 'en'), row('NL', 'BE0', 'nl')], 'nl')[0].TaxTypeName, 'nl');
  assert.equal(oneRowPerTaxType([row('EN', 'BE0', 'en'), row('N', 'BE0', 'nl')], 'nl')[0].TaxTypeName, 'nl');
});

test('English is the fallback, and any row beats none', () => {
  // No Dutch row: English rather than whichever happened to arrive first.
  assert.equal(oneRowPerTaxType([row('DE', 'BE0', 'de'), row('EN', 'BE0', 'en')], 'nl')[0].TaxTypeName, 'en');
  // No English either: still one row, not zero. An unpickable list is the bug being fixed.
  assert.equal(oneRowPerTaxType([row('DE', 'BE0', 'de')], 'nl').length, 1);
  assert.equal(oneRowPerTaxType([row('', 'BE0', 'blank')], 'en').length, 1);
});

test('the ranking prefers an exact match, then English, then anything', () => {
  assert.ok(taxTypeLanguageRank('EN', 'EN') < taxTypeLanguageRank('DE', 'EN'));
  assert.ok(taxTypeLanguageRank('E', 'NL') < taxTypeLanguageRank('DE', 'NL'), 'English outranks German for a Dutch user');
  assert.ok(taxTypeLanguageRank('DE', 'NL') < taxTypeLanguageRank('', 'NL'), 'a language beats a blank');
});

test('rows without a category are dropped, and a count is passed through untouched', () => {
  assert.deepEqual(oneRowPerTaxType([row('EN', '', 'nameless'), row('EN', null, 'x')], 'en'), []);
  assert.equal(oneRowPerTaxType(42, 'en'), 42, '$count is a number, not a list');
  assert.equal(oneRowPerTaxType(undefined, 'en'), undefined);
});

test('the result is ordered by category so the picker does not reshuffle', () => {
  const rows = oneRowPerTaxType([
    row('EN', 'FR1', 'x'), row('EN', 'BE1', 'y'), row('EN', 'BE0', 'z')
  ], 'en');
  assert.deepEqual(rows.map((entry) => entry.BPTaxType), ['BE0', 'BE1', 'FR1']);
});

// The whole point: AddressDependentTaxTypes holds one row on this system, so BE0 could not be
// picked at all. Both consumers have to move together or the F4 dialog and the annotation disagree.
test('every consumer points BPTaxType at the full catalogue', () => {
  assert.ok(VALUE_HELP_ENTITIES.includes('TaxTypes'));
  const annotations = read('srv', 'annotations.cds');
  assert.match(annotations, /BPTaxType @Common\.ValueList: \{\s*CollectionPath: 'TaxTypes'/u);
  assert.match(annotations, /ValueListProperty: 'TaxTypeName'/u);

  const controller = read(
    'app', 'businesspartner', 'webapp', 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  assert.match(controller, /BPTaxType: \{\s*collectionPath: "TaxTypes", keyField: "BPTaxType",\s*descriptionField: "TaxTypeName"/u);
});

test('the language-keyed list gets its own handler instead of the passthrough loop', () => {
  const service = read('srv', 'business-partner-service.js');
  assert.match(service, /if \(entity === 'TaxTypes'\) continue;/u);
  assert.match(service, /this\.on\('READ', 'TaxTypes'[\s\S]{0,240}oneRowPerTaxType/u);
  // Paging has to go, or the page shrinks after deduplication.
  assert.match(service, /delete req\.query\.SELECT\.limit/u);
});

// S/4 assigns the address number; asking for it and then stripping it from the payload was the
// worst of both. Not '$' — that is the MDG staging convention and this path posts to the BP API.
test('the address number is not asked for on create', () => {
  const metadata = read('app', 'businesspartner', 'webapp', 'ext', 'BusinessPartnerMetadata.js');
  const addressId = /"name": "AddressID",[\s\S]*?\}/u.exec(metadata)[0];
  assert.match(addressId, /"key": true/u);
  assert.match(addressId, /"creatable": false/u);

  const generator = read('app', 'businesspartner', 'scripts', 'generate-maintenance-metadata.js');
  assert.match(generator, /SERVER_ASSIGNED_KEYS = new Set\(\['AddressID'\]\)/u);
  assert.match(generator, /!SERVER_ASSIGNED_KEYS\.has\(name\)/u, 'regenerating must not undo it');

  // The flag only hides anything because _createForm already keys off it.
  const controller = read(
    'app', 'businesspartner', 'webapp', 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  assert.match(controller, /isCreate && field\.key && field\.creatable === false/u);
});
