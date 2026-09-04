'use strict';

/**
 * Every string field against the length the staging model gives it, at CHECK time.
 *
 * Why this exists (2026-09-04). A create request passed `checkRequest` twice and then answered
 * `submitRequest` with a bare 500: `value too long for type character varying(3)` on
 * `StagedCustomerTaxGrouping.CustomerTaxGroupingCode`, from a 4-character value in a 3-character
 * field. Nothing in the pipeline looked at lengths, so the requester got no message, no field name
 * and no way to act - and the staged model's lengths mirror `API_BUSINESS_PARTNER`'s own, so S/4
 * would have refused the same value later anyway.
 *
 * The model is the only source: no list of fields is kept here, so a column added to
 * `db/staging.cds` is covered the day it lands.
 */

const cds = require('@sap/cds');

const {
  PAYLOAD_NODES, EXCLUDED, SECTION_TEXT, humanise, sectionRows, targetFor, isEmptyValue
} = require('./payload-fields');

const definitionsOf = (model) => (model || cds.model || {}).definitions || {};

/**
 * The length-carrying string elements of one section, as `{ element, length }[]`.
 *
 * A `length` is only meaningful on a string: `cds.Decimal`'s is a precision and `cds.Date` has
 * none, so measuring either would refuse a value nothing rejects.
 */
function measuredElements(section, model) {
  const node = PAYLOAD_NODES[section];
  const elements = definitionsOf(model)[node?.entity]?.elements || {};
  return Object.entries(elements)
    .filter(([element]) => !EXCLUDED.has(element))
    .filter(([, definition]) => !definition.target && !definition.isAssociation)
    .filter(([, definition]) => String(definition.type || '').replace(/^cds\./u, '') === 'String')
    .filter(([, definition]) => Number.isFinite(Number(definition.length)))
    .map(([element, definition]) => ({ element, length: Number(definition.length) }));
}

/** What the requester sees on screen, not the column name. */
const labelFor = (section, element) =>
  `${SECTION_TEXT[section] || section}: ${humanise(element)}`;

function overlongIn(payload, section, model) {
  const findings = [];
  for (const { element, length } of measuredElements(section, model)) {
    for (const { index, record } of sectionRows(payload, section)) {
      const value = record?.[element];
      if (isEmptyValue(value)) continue;
      const actual = String(value).length;
      if (actual <= length) continue;
      findings.push({
        severity: 'error',
        target: targetFor(section),
        index,
        field: element,
        message: `${labelFor(section, element)} is ${actual} characters; the maximum is ${length}.`
      });
    }
  }
  return findings;
}

/**
 * `model` is injectable so this runs without a CAP model loaded - the same reason
 * `payloadFields(model)` takes one.
 */
function createFieldLengthStages({ model = null } = {}) {
  return {
    validations: [{
      name: 'field_lengths',
      async run(payload) {
        const findings = [];
        for (const section of Object.keys(PAYLOAD_NODES)) {
          findings.push(...overlongIn(payload || {}, section, model));
        }
        return findings;
      }
    }]
  };
}

module.exports = {
  createFieldLengthStages,
  _internals: { measuredElements, labelFor, overlongIn }
};
