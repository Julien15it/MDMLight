'use strict';

const { companyFingerprint, normalizedCompanyName } = require('./name-match');

// The catalog is code-defined because the matching index has to physically carry every field a
// rule can reference; an admin who could name an arbitrary field could write an unevaluable rule.

const alnumUpper = (value) => String(value || '').replace(/[^\p{L}\p{N}]+/gu, '').toLocaleUpperCase();

const textNorm = (value) => normalizedCompanyName(value).replace(/\s+/gu, ' ');

// A bare VAT number is prefixed with the record's own country rather than the prefix being
// stripped: stripping would make BE0123456789 and NL0123456789 the same definitive duplicate.
function taxNorm(value, record) {
  const digits = alnumUpper(value);
  if (!digits) return '';
  if (/^\p{L}{2}/u.test(digits)) return digits;
  const country = primaryCountry(record);
  return country ? `${country}${digits}` : digits;
}

function primaryCountry(record = {}) {
  const fromAddress = (record.addresses || []).map((address) => address?.Country).find(Boolean);
  return alnumUpper(record.Country || fromAddress).slice(0, 2);
}

// Every entry pulls a list: a partner has many addresses, many tax numbers, many bank accounts.
const CATALOG = Object.freeze({
  Name: {
    normalise: (value) => companyFingerprint(value),
    values: (record) => [
      record.BusinessPartnerFullName,
      record.BusinessPartnerName,
      record.OrganizationBPName1,
      record.Name
    ]
  },
  SearchTerm1: {
    normalise: alnumUpper,
    values: (record) => [record.SearchTerm1]
  },
  PostalCode: {
    normalise: alnumUpper,
    values: (record) => (record.addresses || []).map((address) => address?.PostalCode)
  },
  CityName: {
    normalise: textNorm,
    values: (record) => (record.addresses || []).map((address) => address?.CityName)
  },
  StreetName: {
    normalise: textNorm,
    values: (record) => (record.addresses || []).map((address) => address?.StreetName)
  },
  Country: {
    normalise: alnumUpper,
    values: (record) => [record.Country, ...(record.addresses || []).map((address) => address?.Country)]
  },
  IBAN: {
    normalise: alnumUpper,
    values: (record) => (record.bankDetails || []).map((bank) => bank?.IBAN)
  },
  TaxNumber: {
    normalise: taxNorm,
    values: (record) => (record.taxNumbers || []).map((tax) => tax?.BPTaxNumber)
  },
  // Conditions only, never a comparison target.
  Category: {
    normalise: alnumUpper,
    values: (record) => [record.BusinessPartnerCategory, record.Category]
  },
  Grouping: {
    normalise: alnumUpper,
    values: (record) => [record.BusinessPartnerGrouping, record.Grouping]
  },
  Role: {
    normalise: alnumUpper,
    values: (record) => (record.roles || []).map((role) => role?.BusinessPartnerRole)
  }
});

const CONDITION_FIELDS = Object.freeze(['Country', 'Category', 'Grouping', 'Role']);

// TaxNumber.BE0 targets one tax type; bare TaxNumber targets them all.
function resolveField(name) {
  const field = String(name || '').trim();
  if (CATALOG[field]) return { field, entry: CATALOG[field] };
  const [base, taxType] = field.split('.');
  if (base === 'TaxNumber' && taxType) {
    return {
      field,
      entry: {
        normalise: taxNorm,
        values: (record) => (record.taxNumbers || [])
          .filter((tax) => alnumUpper(tax?.BPTaxType) === alnumUpper(taxType))
          .map((tax) => tax?.BPTaxNumber)
      }
    };
  }
  return null;
}

function fieldValues(record, name) {
  const resolved = resolveField(name);
  if (!resolved) return [];
  const seen = new Set();
  for (const raw of resolved.entry.values(record || {})) {
    const normalised = resolved.entry.normalise(raw, record || {});
    if (normalised) seen.add(normalised);
  }
  return [...seen];
}

/**
 * Turns a record into a field bag keyed by catalog name, so the engine only ever compares
 * normalised strings and one code path serves the assistant, the submit and the admin test.
 */
function buildCandidate(record, fields = Object.keys(CATALOG)) {
  const bag = {};
  for (const name of fields) {
    const values = fieldValues(record, name);
    if (values.length) bag[name] = values;
  }
  return bag;
}

module.exports = {
  CATALOG,
  CONDITION_FIELDS,
  alnumUpper,
  textNorm,
  taxNorm,
  primaryCountry,
  resolveField,
  fieldValues,
  buildCandidate
};
