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

test('rows without a category are dropped, and a count is passed through untouched', () => {
  assert.deepEqual(oneRowPerTaxType([row('EN', '', 'nameless'), row('EN', null, 'x')], 'en'), []);
  assert.equal(oneRowPerTaxType(42, 'en'), 42, '$count is a number, not a list');
  assert.equal(oneRowPerTaxType(undefined, 'en'), undefined);
});

// The whole point: AddressDependentTaxTypes holds one row on this system, so BE0 could not be
// picked at all. Both consumers have to move together or the F4 dialog and the annotation disagree.
test('every consumer points BPTaxType at the full catalogue', () => {
  assert.ok(VALUE_HELP_ENTITIES.includes('TaxTypes'));
  const annotations = read('srv', 'annotations.cds');
  assert.match(annotations, /BPTaxType @Common\.ValueList: \{\s*CollectionPath: 'TaxTypes'/u);
  assert.match(annotations, /ValueListProperty: 'TaxTypeName'/u);

  const controller = read(
    'app', 'businesspartner', '..', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  assert.match(controller, /BPTaxType: \{\s*collectionPath: "TaxTypes", keyField: "BPTaxType",\s*descriptionField: "TaxTypeName"/u);
});

/**
 * CustomerPricingProcedures (C_CustPriceProcedureTextVHTemp) joined TaxTypes as a second
 * language-keyed list (abap/valuehelp/README.md, 2026-08-28) - same collapse, same reason.
 */

/**
 * CustomerPricingProcedures (C_CustPriceProcedureTextVHTemp) needed the identical language-key
 * collapse TaxTypes already had, just keyed on a different field name - generalised with a third,
 * optional codeField parameter (default 'BPTaxType') rather than a second copy of the function.
 */
test('oneRowPerTaxType collapses by an arbitrary code field, not only BPTaxType', () => {
  const procRow = (language, code, name) => ({ Language: language, CustomerPricingProcedure: code, CustomerPricingProcedureText: name });
  const rows = oneRowPerTaxType([
    procRow('D', '01', 'Standard'),
    procRow('E', '01', 'Standard'),
    procRow('E', '02', 'Alternative')
  ], 'en', 'CustomerPricingProcedure');
  assert.deepEqual(rows.map((entry) => entry.CustomerPricingProcedure), ['01', '02']);
  assert.equal(rows[0].CustomerPricingProcedureText, 'Standard');

  // Existing callers pass no third argument - BPTaxType stays the default.
  assert.equal(oneRowPerTaxType([row('EN', 'BE0', 'VAT number')], 'en')[0].BPTaxType, 'BE0');
});

/**
 * Ten released SAP views (I_CompanyCode, I_PurchasingOrganization, ...) activated on the service
 * and never exposed until now (abap/valuehelp/README.md, 2026-08-28) - none needed a Z projection.
 * Reported directly, after the field was made mandatory on Customer Sales Area with no way to look
 * up a valid value.
 */
test('the org-unit and pricing fields on Customer/Supplier all get real search help', () => {
  const serviceCds = read('srv', 'business-partner-service.cds');
  const annotations = read('srv', 'annotations.cds');
  const controller = read(
    'app', 'businesspartner', '..', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'controller', 'BusinessPartnerMaintenance.controller.js'
  );

  const wired = [
    ['CompanyCodes', 'VH.CompanyCodes'],
    ['PurchasingOrganizations', 'VH.PurchasingOrganizations'],
    ['SalesOrganizations', 'VH.SalesOrganizations'],
    ['DistributionChannels', 'VH.DistributionChannels'],
    ['Divisions', 'VH.Divisions'],
    ['SalesDistricts', 'VH.SalesDistricts'],
    ['CustomerPriceGroups', 'VH.CustomerPriceGroups'],
    ['Currencies', 'VH.Currencies'],
    ['CustomerPricingProcedures', 'VH.CustomerPricingProcedures']
  ];
  for (const [local, remote] of wired) {
    assert.match(serviceCds, new RegExp(`entity ${local}\\s+as projection on ${remote.replace('.', '\\.')}`), `${local} is not projected`);
    assert.ok(VALUE_HELP_ENTITIES.includes(local), `${local} is missing from VALUE_HELP_ENTITIES`);
  }

  for (const field of [
    'TaxNumberType', 'CompanyCode', 'SalesOrganization', 'DistributionChannel', 'Division',
    'SalesDistrict', 'CustomerPriceGroup', 'CustomerPricingProcedure', 'Currency',
    'PurchasingOrganization', 'PurchaseOrderCurrency'
  ]) {
    assert.match(annotations, new RegExp(`${field} @Common\\.ValueList`), `${field} has no @Common.ValueList annotation`);
    assert.match(controller, new RegExp(`${field}: \\{\\s*\\n\\s*collectionPath:`), `${field} is missing from VALUE_HELP_FIELDS`);
  }

  // PurchaseOrderCurrency (Supplier Purchasing Org) shares the same Currencies collection as
  // CustomerSalesArea's own Currency field - one currency catalogue, two field names, so it needs
  // no READ handler of its own beyond the generic Currencies passthrough.
  assert.match(controller, /PurchaseOrderCurrency: \{\s*\n\s*collectionPath: "Currencies"/u);
});

/**
 * Reported directly (2026-08-28): Additional Data's five industry-code slots had no search help.
 * A_CustomerType.IndustryCode1-5 are Edm.String(10), the same length and domain as
 * A_BusinessPartnerType.Industry (already wired to IndustryCodes) - one shared catalogue, not five.
 */

/**
 * Language/CompanyCode/SalesOrganization/DistributionChannel/Division/PurchasingOrganization also
 * appear on several Text/Dunning/WithholdingTax/PartnerFunc child sections of Customer and Supplier.
 * VALUE_HELP_FIELDS matches by field name alone, not by section, so these already got F4 help the
 * moment the field itself was wired anywhere - this only extends the CDS @Common.ValueList side for
 * consistency with other OData consumers, and pins that no section was missed.
 */
test('the same field, the same value help, on every child section that repeats it', () => {
  const annotations = read('srv', 'annotations.cds');
  const withLanguage = ['A_CustomerText', 'A_SupplierText', 'A_CustomerCompanyText', 'A_SupplierCompanyText', 'A_CustomerSalesAreaText', 'A_SupplierPurchasingOrgText'];
  for (const entity of withLanguage) {
    assert.match(annotations, new RegExp(`annotate service\\.${entity} with \\{\\s*\\n\\s*Language @Common\\.ValueList`), `${entity} is missing the Language value help`);
  }
  const withCompanyCode = ['A_CustomerCompanyText', 'A_SupplierCompanyText', 'A_CustomerDunning', 'A_SupplierDunning', 'A_CustomerWithHoldingTax', 'A_SupplierWithHoldingTax'];
  for (const entity of withCompanyCode) {
    assert.match(annotations, new RegExp(`annotate service\\.${entity} with \\{[\\s\\S]{0,600}CompanyCode @Common\\.ValueList`), `${entity} is missing the CompanyCode value help`);
  }
  const withSalesArea = ['A_CustomerSalesAreaText', 'A_CustSalesPartnerFunc', 'A_CustSlsAreaAddrDepdntInfo'];
  for (const entity of withSalesArea) {
    assert.match(annotations, new RegExp(`annotate service\\.${entity} with \\{[\\s\\S]{0,600}SalesOrganization @Common\\.ValueList[\\s\\S]{0,300}DistributionChannel @Common\\.ValueList[\\s\\S]{0,300}Division @Common\\.ValueList`), `${entity} is missing a sales-area value help`);
  }
  const withPurchasingOrg = ['A_SupplierPartnerFunc', 'A_SupplierPurchasingOrgText'];
  for (const entity of withPurchasingOrg) {
    assert.match(annotations, new RegExp(`annotate service\\.${entity} with \\{[\\s\\S]{0,600}PurchasingOrganization @Common\\.ValueList`), `${entity} is missing the PurchasingOrganization value help`);
  }
});
