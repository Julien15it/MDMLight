'use strict';

const cds = require('@sap/cds');

/**
 * The field catalog validation and derivation rules are written against.
 *
 * This is **not** the duplicate catalog. `srv/ai/duplicate-fields.js` describes
 * bags of normalised values for comparing two partners; a rule that fills in a
 * language or asserts a region has to read and write the request payload the
 * maintenance screen posts - `{ root, sections }` - so it needs that shape's own
 * field names, with their real values.
 *
 * The catalog is generated from the staging model rather than listed here, so it
 * cannot drift from what a request can actually hold: if `db/staging.cds` gains
 * a column, the dropdown has it.
 *
 * Names are **qualified and always dotted** - `General.Language`,
 * `Addresses.Country`. That is what lets the Value column mean two things
 * without a second column to say which: a value that resolves to a catalog name
 * is a field reference, and a literal never can be one.
 */

const STAGING = 'mdmlight.staging.';

/**
 * Section id -> staging entity, the single source of truth for both this catalog
 * and `NODES` in srv/change-request-service.js. The ids are the ones
 * app/businesspartner/scripts/generate-maintenance-metadata.js emits, so nothing
 * is translated between the screen, the payload and a rule.
 *
 * `General` is the payload root rather than a node of its own - it is the one
 * entry with `root: true`, which is why it carries no `many`.
 */
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
  SupplierPurchasingOrg: { entity: `${STAGING}StagedSupplierPurchasingOrg`, many: true }
});

/** The payload root's section id, and the value the pipeline expects in `target`. */
const ROOT_SECTION = 'General';
const ROOT_TARGET = 'root';

/**
 * Never offered as a rule field. Keys, backlinks and the row's own change
 * indicator are plumbing: a rule over `action` would look like a rule and change
 * nothing anyone asked for, and `request_ID` is not master data at all.
 */
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
  SupplierPurchasingOrg: 'Supplier Purchasing Org'
});

// A space before each capital that starts a new word, so BusinessPartnerCategory reads as
// "Business Partner Category". Cheap, and better than a hand-kept label per column.
function humanise(name) {
  return String(name)
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2');
}

const definitionsOf = (model) => (model || cds.model || {}).definitions || {};

/**
 * Every rule-addressable field, as `{ field, section, element, type, text }`.
 * `model` is injectable so this is testable without a loaded CAP model.
 */
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

/**
 * `{ field, section, element, node }` for a qualified name, or null.
 *
 * An unqualified name is rejected rather than defaulted to General: guessing the
 * section would validate a different field from the one that was written down.
 */
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

/**
 * The rows a section contributes, always as `{ index, record }[]`. A to-one node
 * (Customers, Suppliers) is one row at index 0, so no caller branches on cardinality.
 */
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
