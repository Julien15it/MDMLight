'use strict';

const cds = require('@sap/cds');

/**
 * The catalog validation and derivation rules are written against - NOT the duplicate catalog, which
 * holds normalised value bags for comparing partners. These rules read and write the request payload,
 * so they need its own field names and real values. Generated from db/staging.cds, so it cannot drift.
 * Names are always dotted (`General.Language`), which is what lets a Value be a literal or a field.
 */

const STAGING = 'mdmlight.staging.';

// The single source of truth for this catalog and for `NODES` in change-request-service.js, using the
// generated metadata ids. `General` is the payload root rather than a node, hence `root` and no `many`.
const PAYLOAD_NODES = Object.freeze({
  General:               { entity: `${STAGING}StagedGeneral`,               root: true },
  Addresses:             { entity: `${STAGING}StagedAddresses`,             many: true },
  BusinessPartnerRoles:  { entity: `${STAGING}StagedRoles`,                 many: true },
  TaxNumbers:            { entity: `${STAGING}StagedTaxNumbers`,            many: true },
  BankDetails:           { entity: `${STAGING}StagedBankDetails`,           many: true },
  Identifications:       { entity: `${STAGING}StagedIdentifications`,       many: true },
  Industries:            { entity: `${STAGING}StagedIndustries`,            many: true },
  Customers:             { entity: `${STAGING}StagedCustomer`,              many: false },
  Suppliers:             { entity: `${STAGING}StagedSupplier`,              many: false },
  CustomerCompany:       { entity: `${STAGING}StagedCustomerCompany`,       many: true },
  SupplierCompany:       { entity: `${STAGING}StagedSupplierCompany`,       many: true },
  CustomerSalesArea:     { entity: `${STAGING}StagedCustomerSalesArea`,     many: true },
  CustomerTaxGrouping:   { entity: `${STAGING}StagedCustomerTaxGrouping`,   many: true },
  SupplierPurchasingOrg: { entity: `${STAGING}StagedSupplierPurchasingOrg`, many: true },
  CustomerText:                      { entity: `${STAGING}StagedCustomerText`, many: true },
  CustomerAddressExtIdentifier:      { entity: `${STAGING}StagedCustomerAddressExtIdentifier`, many: true },
  CustomerAddressInfo:               { entity: `${STAGING}StagedCustomerAddressInfo`, many: true },
  CustomerCompanyText:               { entity: `${STAGING}StagedCustomerCompanyText`, many: true },
  CustomerDunning:                   { entity: `${STAGING}StagedCustomerDunning`, many: true },
  CustomerWithholdingTax:            { entity: `${STAGING}StagedCustomerWithholdingTax`, many: true },
  CustomerSalesAreaText:             { entity: `${STAGING}StagedCustomerSalesAreaText`, many: true },
  CustomerTaxIndicators:             { entity: `${STAGING}StagedCustomerTaxIndicators`, many: true },
  CustomerSalesPartnerFunctions:     { entity: `${STAGING}StagedCustomerSalesPartnerFunc`, many: true },
  CustomerSalesAreaAddressInfo:      { entity: `${STAGING}StagedCustomerSalesAreaAddressInfo`, many: true },
  CustomerUnloadingPoint:            { entity: `${STAGING}StagedCustomerUnloadingPoint`, many: true },
  CustomerUnloadingPointAddressInfo: { entity: `${STAGING}StagedCustomerUnloadingPointAddressInfo`, many: true },
  SupplierText:                      { entity: `${STAGING}StagedSupplierText`, many: true },
  SupplierCompanyText:               { entity: `${STAGING}StagedSupplierCompanyText`, many: true },
  SupplierDunning:                   { entity: `${STAGING}StagedSupplierDunning`, many: true },
  SupplierWithholdingTax:            { entity: `${STAGING}StagedSupplierWithholdingTax`, many: true },
  SupplierPurchasingOrgText:         { entity: `${STAGING}StagedSupplierPurchasingOrgText`, many: true },
  SupplierPartnerFunctions:          { entity: `${STAGING}StagedSupplierPartnerFunc`, many: true }
});

/** The payload root's section id, and the value the pipeline expects in `target`. */
const ROOT_SECTION = 'General';
const ROOT_TARGET = 'root';

// Never offered as a rule field: keys, backlinks and `action` are plumbing, not master data.
const EXCLUDED = new Set([
  'ID', 'request', 'request_ID', 'action',
  'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'
]);

const SECTION_TEXT = Object.freeze({
  General: 'General',
  Addresses: 'Address',
  BusinessPartnerRoles: 'Role',
  TaxNumbers: 'Tax Number',
  BankDetails: 'Bank Details',
  Identifications: 'Identification',
  Industries: 'Industry',
  Customers: 'Customer Data',
  Suppliers: 'Supplier Data',
  CustomerCompany: 'Customer Company Code',
  SupplierCompany: 'Supplier Company Code',
  CustomerSalesArea: 'Customer Sales Area',
  CustomerTaxGrouping: 'Customer Tax Category',
  SupplierPurchasingOrg: 'Supplier Purchasing Org',
  CustomerText:                      'Customer Text',
  CustomerAddressExtIdentifier:      'Customer Address Ext. Identifier',
  CustomerAddressInfo:               'Customer Address Info',
  CustomerCompanyText:               'Customer Company Code Text',
  CustomerDunning:                   'Customer Dunning',
  CustomerWithholdingTax:            'Customer Withholding Tax',
  CustomerSalesAreaText:             'Customer Sales Area Text',
  CustomerTaxIndicators:             'Customer Tax Indicator',
  CustomerSalesPartnerFunctions:     'Customer Partner Function',
  CustomerSalesAreaAddressInfo:      'Customer Sales Area Address Info',
  CustomerUnloadingPoint:            'Customer Unloading Point',
  CustomerUnloadingPointAddressInfo: 'Customer Unloading Point Address Info',
  SupplierText:                      'Supplier Text',
  SupplierCompanyText:               'Supplier Company Code Text',
  SupplierDunning:                   'Supplier Dunning',
  SupplierWithholdingTax:            'Supplier Withholding Tax',
  SupplierPurchasingOrgText:         'Supplier Purchasing Org Text',
  SupplierPartnerFunctions:          'Supplier Partner Function'
});

// A space before each capital that starts a new word, so BusinessPartnerCategory reads as
// "Business Partner Category". Cheap, and better than a hand-kept label per column.
function humanise(name) {
  return String(name)
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2');
}

const definitionsOf = (model) => (model || cds.model || {}).definitions || {};

/** Every rule-addressable field. `model` is injectable, so this is testable without a CAP model. */
function payloadFields(model) {
  const definitions = definitionsOf(model);
  const fields = [];
  for (const [section, node] of Object.entries(PAYLOAD_NODES)) {
    const elements = definitions[node.entity]?.elements || {};
    for (const [element, definition] of Object.entries(elements)) {
      if (EXCLUDED.has(element)) continue;
      // An association addresses another row, which a decision table cannot.
      if (definition.target || definition.isAssociation || definition.isComposition) continue;
      fields.push({
        field: `${section}.${element}`,
        section,
        element,
        type: String(definition.type || '').replace(/^cds\./u, ''),
        // Element first, section in brackets: people search for "Country", not for "Address", and
        // a picker that filters on the start of the text has to put the searched word there.
        text: `${humanise(element)} (${SECTION_TEXT[section] || section})`
      });
    }
  }
  return fields;
}

// Resolves a qualified name, or null. An unqualified one is rejected rather than defaulted to
// General: guessing the section would validate a different field from the one written down.
function resolvePayloadField(name, model) {
  const qualified = String(name || '').trim();
  const at = qualified.indexOf('.');
  if (at <= 0) return null;
  const section = qualified.slice(0, at);
  const element = qualified.slice(at + 1);
  const node = PAYLOAD_NODES[section];
  if (!node || !element || EXCLUDED.has(element)) return null;
  const elements = definitionsOf(model)[node.entity]?.elements || {};
  // An unloaded model accepts the name rather than rejecting every rule: a tool or a unit test
  // with no CSN to hand must not make a stored rule look invalid.
  if (Object.keys(elements).length && !elements[element]) return null;
  return { field: qualified, section, element, node };
}

const isRootSection = (section) => Boolean(PAYLOAD_NODES[section]?.root);

/** The pipeline's `target` for a section: 'root' for General, the section id otherwise. */
const targetFor = (section) => (isRootSection(section) ? ROOT_TARGET : section);

// A section's rows, always as `{ index, record }[]` - a to-one node is one row, so nothing branches
// on cardinality.
function sectionRows(payload = {}, section) {
  if (isRootSection(section)) return [{ index: 0, record: payload.root || {} }];
  const value = (payload.sections || {})[section];
  if (Array.isArray(value)) return value.map((record, index) => ({ index, record: record || {} }));
  return value ? [{ index: 0, record: value }] : [];
}

const isEmptyValue = (value) =>
  value === undefined || value === null || String(value).trim() === '';

/** Every non-empty value a qualified field holds across its rows, in row order. */
function fieldValues(payload, name, model) {
  const resolved = resolvePayloadField(name, model);
  if (!resolved) return [];
  return sectionRows(payload, resolved.section)
    .map(({ record }) => record[resolved.element])
    .filter((value) => !isEmptyValue(value));
}

module.exports = {
  PAYLOAD_NODES,
  ROOT_SECTION,
  ROOT_TARGET,
  EXCLUDED,
  SECTION_TEXT,
  humanise,
  payloadFields,
  resolvePayloadField,
  isRootSection,
  targetFor,
  sectionRows,
  isEmptyValue,
  fieldValues
};
