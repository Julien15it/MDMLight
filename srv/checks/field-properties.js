'use strict';

const { payloadFields, SECTION_TEXT, resolvePayloadField, PAYLOAD_NODES } = require('./payload-fields');

/**
 * The catalogs behind the field property profiles, and the shaping the maintenance dialog reads.
 * Generated from the staging model like every other field catalog here, so a new node appears in
 * the dialog without anyone editing the UI.
 */

// One state per field, not a set: hidden+mandatory is a request nobody can submit, and read-only
// +mandatory is one only a derivation could satisfy. The dialog shows them as checkboxes because
// that is what was asked for, and clears the other three when one is ticked.
const PROPERTIES = Object.freeze(['mandatory', 'readOnly', 'hidden', 'optional']);

const PROPERTY_TEXT = Object.freeze({
  mandatory: 'Mandatory',
  readOnly: 'Read-only',
  hidden: 'Hidden',
  optional: 'Optional'
});

// `*` first, so the global profile is the obvious default. The types are the ones the app actually
// processes - staging.cds also declares `block` and `delete`, and a profile for a type no request
// can carry would sit in the table looking configured and never match.
const REQUEST_TYPES = Object.freeze(['*', 'create', 'change']);

const REQUEST_TYPE_TEXT = Object.freeze({
  '*': 'All request types',
  create: 'Create',
  change: 'Change'
});

// Not derived from xs-security.json on purpose: `Approver` is a workflow role that no scope
// carries, so the scopes are the wrong list. Keep the two in step by hand.
const ROLES = Object.freeze(['*', 'Requester', 'Approver', 'DataSteward']);

const ROLE_TEXT = Object.freeze({
  '*': 'All roles',
  Requester: 'Requester',
  Approver: 'Approver',
  DataSteward: 'Data Steward'
});

const ANY = '*';

/** Entities with their fields, in catalog order - the shape the modify dialog renders directly. */
function fieldPropertyTree(model) {
  const bySection = new Map();
  for (const section of Object.keys(PAYLOAD_NODES)) {
    bySection.set(section, { section, text: SECTION_TEXT[section] || section, fields: [] });
  }
  for (const { field, section, element, text } of payloadFields(model)) {
    // A section the catalog knows but PAYLOAD_NODES does not cannot happen; guard anyway rather
    // than drop the field silently.
    if (!bySection.has(section)) {
      bySection.set(section, { section, text: SECTION_TEXT[section] || section, fields: [] });
    }
    bySection.get(section).fields.push({ field, element, text });
  }
  // An entity with no rule-addressable field is nothing anyone can say anything about.
  return [...bySection.values()].filter((entity) => entity.fields.length);
}

/**
 * A settings row as it may be stored, or a reason it may not. Entity-level rows carry no element,
 * which is the one case `resolvePayloadField` cannot check - it only resolves qualified names.
 */
function validateSetting(setting, model) {
  const section = String(setting?.section || '').trim();
  const element = setting?.element ? String(setting.element).trim() : null;
  const property = String(setting?.property || '').trim();

  if (!section) return { error: 'A field property needs the entity it applies to.' };
  if (!PAYLOAD_NODES[section]) return { error: `“${section}” is not an entity of the request payload.` };
  if (!PROPERTIES.includes(property)) {
    return { error: `“${property}” is not a field property. Use one of: ${PROPERTIES.join(', ')}.` };
  }
  if (element && !resolvePayloadField(`${section}.${element}`, model)) {
    return { error: `“${element}” is not a field of ${SECTION_TEXT[section] || section}.` };
  }
  return { setting: { section, element, property } };
}

/** Last row wins per target, so a dialog that sent the same field twice cannot store both. */
function normaliseSettings(rows, model) {
  const byTarget = new Map();
  const errors = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const { setting, error } = validateSetting(row, model);
    if (error) {
      errors.push(error);
      continue;
    }
    byTarget.set(`${setting.section}.${setting.element || ''}`, setting);
  }
  return { settings: [...byTarget.values()], errors };
}

/** True when a profile's conditions cover this request. `*` matches anything, otherwise exact. */
function profileMatches(profile, { requestType, role }) {
  const condition = (stored, actual) =>
    !stored || stored === ANY || String(stored) === String(actual);
  return condition(profile?.requestType, requestType) && condition(profile?.role, role);
}

module.exports = {
  PROPERTIES,
  PROPERTY_TEXT,
  REQUEST_TYPES,
  REQUEST_TYPE_TEXT,
  ROLES,
  ROLE_TEXT,
  ANY,
  fieldPropertyTree,
  validateSetting,
  normaliseSettings,
  profileMatches
};
