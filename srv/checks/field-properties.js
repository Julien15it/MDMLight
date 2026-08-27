'use strict';

const {
  payloadFields, SECTION_TEXT, resolvePayloadField, PAYLOAD_NODES, sectionRows, isEmptyValue,
  humanise
} = require('./payload-fields');

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

// `Approver` and `DataSteward` stopped being fixed values here 2026-08-27: the picker now offers the
// subaccount's own BTP role collections for those two instead (see fieldPropertyOptions in
// duplicate-config-service.js), matched against the screen's category by a naming convention - see
// profileMatches. `Requester` stays hard-coded: it names who submitted, never a role collection.
const ROLES = Object.freeze(['*', 'Requester']);

const ROLE_TEXT = Object.freeze({
  '*': 'All roles',
  Requester: 'Requester'
});

// Grandfathered, not offered by the picker any more: a profile saved before 2026-08-27 may still
// carry the literal `Approver`/`DataSteward` value, and profileMatches still matches it exactly - so
// the write guard has to keep accepting it too, or an untouched legacy row would fail to re-save the
// moment anything else on it changes.
const LEGACY_ROLES = Object.freeze(['Approver', 'DataSteward']);

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
 *
 * `property` is optional (2026-08-26) - a row may exist only to carry `critical`, independent of
 * mandatory/readOnly/hidden/optional, so an empty property is no longer itself an error.
 */
function validateSetting(setting, model) {
  const section = String(setting?.section || '').trim();
  const element = setting?.element ? String(setting.element).trim() : null;
  const property = String(setting?.property || '').trim();
  const critical = Boolean(setting?.critical);

  if (!section) return { error: 'A field property needs the entity it applies to.' };
  if (!PAYLOAD_NODES[section]) return { error: `“${section}” is not an entity of the request payload.` };
  if (property && !PROPERTIES.includes(property)) {
    return { error: `“${property}” is not a field property. Use one of: ${PROPERTIES.join(', ')}.` };
  }
  if (element && !resolvePayloadField(`${section}.${element}`, model)) {
    return { error: `“${element}” is not a field of ${SECTION_TEXT[section] || section}.` };
  }
  // Critical is entity-level only (2026-08-26): the dialog greys the box out on a field row, and this
  // is the write-path guard behind it - refused, not filtered, the same discipline every other unknown
  // setting on this row already gets. `resolveProfiles` still reads an older field-level critical row
  // rather than dropping it, the same tolerance the delimited-list reader keeps for withdrawn features.
  if (element && critical) {
    return { error: `“${SECTION_TEXT[section] || section}.${element}” cannot be critical - critical applies to the whole entity, not one field.` };
  }
  return { setting: { section, element, property: property || null, critical } };
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

/**
 * What each property actually says, on three independent axes. Merging two profiles is a join over
 * these rather than a ranking, because `mandatory` and `readOnly` are not comparable: one restricts
 * what you must fill, the other what you may touch. The rule is **the broadest result wins**, and
 * the axes are what make Maarten's two examples fall out instead of being special-cased —
 * hidden + readOnly is readOnly, mandatory + readOnly is optional.
 */
const PROPERTY_STATE = Object.freeze({
  hidden:    Object.freeze({ visible: false, editable: false, required: false }),
  readOnly:  Object.freeze({ visible: true,  editable: false, required: false }),
  mandatory: Object.freeze({ visible: true,  editable: true,  required: true }),
  optional:  Object.freeze({ visible: true,  editable: true,  required: false })
});

/** The name for a state. Every join of the four lands back on one of them - `test/` pins it. */
function propertyOfState(state) {
  if (!state.visible) return 'hidden';
  if (!state.editable) return 'readOnly';
  return state.required ? 'mandatory' : 'optional';
}

/**
 * The broadest of several properties: visible or editable if ANY profile allows it, required only
 * if EVERY profile that speaks demands it. A profile that says nothing about a target is not
 * counted as `optional` - silence is no opinion, or one global profile would neuter every narrower
 * one that follows it.
 */
function broadestProperty(properties) {
  const states = (properties || [])
    .filter((property) => PROPERTY_STATE[property])
    .map((property) => PROPERTY_STATE[property]);
  if (!states.length) return null;
  return propertyOfState({
    visible: states.some((state) => state.visible),
    editable: states.some((state) => state.editable),
    required: states.every((state) => state.required)
  });
}

const settingKey = (section, element) => (element ? `${section}.${element}` : section);

/**
 * Every profile matching this request, merged into one answer per target:
 * `{ entities: { Addresses: 'readOnly' }, fields: { 'Addresses.Country': 'mandatory' } }`.
 * A target nothing says anything about is absent, which is deliberately not the same as `optional`.
 *
 * `criticalEntities`/`criticalFields` are gathered from a DIFFERENT set of matching profiles than
 * `entities`/`fields` (2026-08-27) - profiles matched against `role: 'Requester'` specifically,
 * whatever role the caller actually asked about. Marking a section critical is a decision about what
 * the DATA needs, made from the Requester's own profile (that is the only place the checkbox is
 * editable at all - see the Modify dialog), and the "!" it produces has to show up on every screen
 * that renders the section - the approver's, the data steward's, the requester's own - not only on
 * whichever role happens to match the profile it was set on. Before this, a critical flag set on a
 * Requester-scoped profile was invisible to every OTHER role's screen, because `profileMatches`
 * correctly says a Requester profile does not apply to an Approver request - true for `mandatory`/
 * `readOnly`/etc., wrong for `critical`, which was never meant to be role-scoped at all.
 *
 * Gathered independently of `property` either way: a row can carry `critical` with no property at
 * all, and a critical row contributes even when its property is not one of the four states (or is
 * absent) - the two are unrelated axes, not merged or cascaded the way `broadestProperty` merges
 * visible/editable/required. Any matching profile's row saying critical is enough; there is nothing
 * to reconcile between profiles that disagree, because "critical" has no broader/narrower answer the
 * way a property does.
 */
function resolveProfiles(profiles, settings, context) {
  const active = (profiles || []).filter((profile) => profile.isActive !== false);
  const matching = active.filter((profile) => profileMatches(profile, context || {}));
  const ids = new Set(matching.map((profile) => profile.ID));

  const criticalMatching = active.filter((profile) => (
    profileMatches(profile, { requestType: context?.requestType, role: 'Requester' })
  ));
  const criticalIds = new Set(criticalMatching.map((profile) => profile.ID));

  const entities = {};
  const fields = {};
  const collect = (bucket, key, property) => {
    bucket[key] = bucket[key] || [];
    bucket[key].push(property);
  };
  const criticalEntities = new Set();
  const criticalFields = new Set();

  for (const setting of settings || []) {
    const owner = setting.profile_ID || (setting.profile && setting.profile.ID);
    if (setting.critical && criticalIds.has(owner)) {
      if (setting.element) criticalFields.add(settingKey(setting.section, setting.element));
      else criticalEntities.add(setting.section);
    }
    if (!ids.has(owner)) continue;
    if (!PROPERTY_STATE[setting.property]) continue;
    if (setting.element) collect(fields, settingKey(setting.section, setting.element), setting.property);
    else collect(entities, setting.section, setting.property);
  }

  const merge = (bucket) => Object.fromEntries(
    Object.entries(bucket)
      .map(([key, properties]) => [key, broadestProperty(properties)])
      .filter(([, property]) => property)
  );
  return {
    entities: merge(entities),
    fields: merge(fields),
    profiles: matching.length,
    criticalEntities: [...criticalEntities],
    criticalFields: [...criticalFields]
  };
}

/** What a profile says about a whole entity: its rows, not its fields. */
const entityProperty = (resolved, section) => (resolved && resolved.entities || {})[section] || null;

/**
 * What applies to one field, after the entity it sits in has had its say. Only `hidden` and
 * `readOnly` cascade: they describe the container, and a field cannot be shown inside a hidden
 * section or edited inside a read-only one. `mandatory`/`optional` on an entity are about whether
 * the entity needs a row at all, so they say nothing about the fields underneath it.
 */
function effectiveProperty(resolved, section, element) {
  const own = (resolved && resolved.fields || {})[settingKey(section, element)] || null;
  const entity = entityProperty(resolved, section);
  if (entity === 'hidden') return 'hidden';
  if (entity === 'readOnly') return own === 'hidden' ? 'hidden' : 'readOnly';
  return own;
}

/** The three answers a screen asks per field, so no caller has to know the four names. */
function fieldState(resolved, section, element) {
  const property = effectiveProperty(resolved, section, element);
  const state = PROPERTY_STATE[property] || null;
  return {
    property,
    visible: state ? state.visible : true,
    editable: state ? state.editable : true,
    required: state ? state.required : false
  };
}

/**
 * The submit-time half. A mandatory field left empty blocks, and a mandatory entity with no rows
 * blocks - otherwise the profile is screen decoration that a direct service call, or a field the
 * screen never rendered, walks straight past.
 *
 * `critical` is deliberately NOT enforced here (2026-08-26 revision) - it is a marker for a data
 * steward, shown as "!" next to a section's title on the screen, not a requirement CAP gates on. An
 * empty critical entity is not an error; it is simply reported to SBPA as not (yet) filled in via the
 * `criticalField` flag in the workflow context - see `workflowContext` in change-request-service.js.
 */
function createFieldPropertyStages(resolved, model) {
  const entities = Object.entries((resolved && resolved.entities) || {})
    .filter(([, property]) => property === 'mandatory');
  const fields = Object.entries((resolved && resolved.fields) || {})
    .map(([key, property]) => {
      const at = key.indexOf('.');
      return { section: key.slice(0, at), element: key.slice(at + 1), property };
    })
    // Read back through the cascade: a field marked mandatory inside an entity a broader profile
    // hid or froze is not something anyone can fill in.
    .filter(({ section, element }) => effectiveProperty(resolved, section, element) === 'mandatory');

  if (!entities.length && !fields.length) return { validations: [], derivations: [] };

  return {
    validations: [{
      name: 'field_properties',
      run: async (payload) => {
        const findings = [];
        for (const [section] of entities) {
          if (sectionRows(payload, section).length) continue;
          findings.push({
            severity: 'error',
            message: `At least one ${SECTION_TEXT[section] || section} record is required.`
          });
        }
        for (const { section, element } of fields) {
          if (!resolvePayloadField(settingKey(section, element), model)) continue;
          for (const { index, record } of sectionRows(payload, section)) {
            if (!isEmptyValue(record[element])) continue;
            findings.push({
              severity: 'error',
              field: settingKey(section, element),
              message: `${humanise(element)} (${SECTION_TEXT[section] || section}) is required`
                + (PAYLOAD_NODES[section] && PAYLOAD_NODES[section].many ? ` on row ${index + 1}` : '')
                + '.'
            });
          }
        }
        return findings;
      }
    }],
    derivations: []
  };
}

/**
 * True when a profile's conditions cover this request. `requestType` is exact (a closed enum, no
 * business in a prefix match). `role` is exact first - for `*`, `Requester`, and any row still
 * carrying the literal `Approver`/`DataSteward` values from before 2026-08-27 - and otherwise a
 * case-insensitive prefix match, checked **both ways** (2026-08-27, once `role` can itself be a
 * SPECIFIC BTP role - see `effectiveFieldProperties` in change-request-service.js):
 *
 * - A profile's role is a prefix of what is being checked - "ApproverSales" or "ApproverFinance"
 *   both count as Approver-category when the screen could only resolve the bare category, so a
 *   steward can scope a profile to a specific function ahead of CAP ever knowing its exact name.
 * - What is being checked is a prefix of the profile's role - a profile still carrying the bare
 *   legacy `Approver` (or one a steward deliberately left at the category level) still applies once
 *   the screen resolves a SPECIFIC role like "Approver Customer" for the person actually looking at
 *   it, or a global policy would stop covering anyone the moment resolution got more precise.
 *
 * Two different, specific roles ("Approver Customer" vs. "Approver Vendor") are neither a prefix of
 * the other, so this still keeps them apart - which is the entire point of resolving a specific role
 * in the first place.
 */
function profileMatches(profile, { requestType, role }) {
  const exact = (stored, actual) => !stored || stored === ANY || String(stored) === String(actual);
  const roleMatches = (stored, actual) => {
    if (exact(stored, actual)) return true;
    if (typeof stored !== 'string' || typeof actual !== 'string') return false;
    const a = stored.toLowerCase();
    const b = actual.toLowerCase();
    return a.startsWith(b) || b.startsWith(a);
  };
  return exact(profile?.requestType, requestType) && roleMatches(profile?.role, role);
}

module.exports = {
  PROPERTIES,
  PROPERTY_STATE,
  propertyOfState,
  broadestProperty,
  settingKey,
  resolveProfiles,
  entityProperty,
  effectiveProperty,
  fieldState,
  createFieldPropertyStages,
  PROPERTY_TEXT,
  REQUEST_TYPES,
  REQUEST_TYPE_TEXT,
  ROLES,
  ROLE_TEXT,
  LEGACY_ROLES,
  ANY,
  fieldPropertyTree,
  validateSetting,
  normaliseSettings,
  profileMatches
};
