'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const serviceCds = read(ROOT, 'srv', 'change-request-service.cds');
const serviceJs = read(ROOT, 'srv', 'change-request-service.js');
const controller = read(
  ROOT, 'app', 'businesspartner', 'webapp', 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'
);

const {
  PROPERTY_STATE, PROPERTIES, broadestProperty, resolveProfiles, effectiveProperty, entityProperty,
  fieldState, createFieldPropertyStages
} = require('../srv/checks/field-properties');

const csn = {
  definitions: {
    'mdmlight.staging.StagedAddresses': {
      elements: { Country: { type: 'cds.String' }, POBox: { type: 'cds.String' } }
    },
    'mdmlight.staging.StagedTaxNumbers': { elements: { BPTaxNumber: { type: 'cds.String' } } },
    'mdmlight.staging.StagedGeneral': { elements: { SearchTerm1: { type: 'cds.String' } } }
  }
};

const profile = (ID, requestType, role) => ({ ID, requestType, role, isActive: true });
const setting = (profile_ID, section, element, property) => ({ profile_ID, section, element, property });

// --- Merging two profiles --------------------------------------------------------------

/**
 * Maarten's rule, 2026-08-20: where two profiles match, **the broadest result wins**. His own two
 * examples are the ones that make it more than a ranking - `mandatory` and `readOnly` are not
 * comparable, so their join is neither of them.
 */
test('the broadest of two properties is the join, not the higher rank', () => {
  assert.equal(broadestProperty(['hidden', 'readOnly']), 'readOnly');
  assert.equal(broadestProperty(['mandatory', 'readOnly']), 'optional');
  assert.equal(broadestProperty(['mandatory', 'optional']), 'optional');
  assert.equal(broadestProperty(['hidden', 'mandatory']), 'optional');
  assert.equal(broadestProperty(['hidden', 'optional']), 'optional');
  assert.equal(broadestProperty(['readOnly', 'optional']), 'optional');
  // Order cannot matter: it is a join over booleans, not a first-wins list.
  assert.equal(broadestProperty(['readOnly', 'hidden']), 'readOnly');
  assert.equal(broadestProperty(['readOnly', 'mandatory']), 'optional');
});

test('one profile, or the same answer twice, keeps that answer', () => {
  for (const property of PROPERTIES) {
    assert.equal(broadestProperty([property]), property, `${property} alone`);
    assert.equal(broadestProperty([property, property]), property, `${property} twice`);
  }
  // Nothing said is not `optional`: silence is no opinion, or one global profile would neuter
  // every narrower one.
  assert.equal(broadestProperty([]), null);
  assert.equal(broadestProperty(['nonsense']), null);
});

/** Every join has to land back on one of the four, or a merged answer would be unrenderable. */
test('the join is closed over the four properties', () => {
  for (const a of PROPERTIES) {
    for (const b of PROPERTIES) {
      for (const c of PROPERTIES) {
        assert.ok(PROPERTIES.includes(broadestProperty([a, b, c])), `${a}+${b}+${c}`);
      }
    }
  }
  assert.deepEqual(Object.keys(PROPERTY_STATE).sort(), [...PROPERTIES].sort());
});

// --- Which profiles are merged ---------------------------------------------------------

test('only active profiles whose conditions match are merged', () => {
  const profiles = [
    profile('global', '*', '*'),
    profile('creates', 'create', '*'),
    profile('changes', 'change', '*'),
    { ...profile('off', '*', '*'), isActive: false }
  ];
  const settings = [
    setting('global', 'Addresses', 'Country', 'hidden'),
    setting('creates', 'Addresses', 'Country', 'readOnly'),
    setting('changes', 'Addresses', 'Country', 'mandatory'),
    setting('off', 'Addresses', 'POBox', 'hidden')
  ];
  const resolved = resolveProfiles(profiles, settings, { requestType: 'create', role: 'Requester' });
  // global(hidden) + creates(readOnly), and the change profile is not in this request at all.
  assert.equal(resolved.fields['Addresses.Country'], 'readOnly');
  assert.equal(resolved.profiles, 2);
  // An inactive profile says nothing, so POBox is unmentioned rather than hidden.
  assert.equal(resolved.fields['Addresses.POBox'], undefined);
});

test('entity settings and field settings are kept apart', () => {
  const resolved = resolveProfiles(
    [profile('p', '*', '*')],
    [setting('p', 'TaxNumbers', null, 'mandatory'), setting('p', 'Addresses', 'Country', 'mandatory')],
    { requestType: 'create', role: 'Requester' }
  );
  assert.equal(entityProperty(resolved, 'TaxNumbers'), 'mandatory');
  assert.equal(resolved.fields['Addresses.Country'], 'mandatory');
  assert.equal(entityProperty(resolved, 'Addresses'), null);
});

// --- The cascade -----------------------------------------------------------------------

/**
 * Only `hidden` and `readOnly` cascade from an entity: they describe the container. An entity's
 * `mandatory` is about whether it needs a row at all, and cascading it would silently make every
 * field of the section required - which is not what ticking Mandatory on Tax Numbers means.
 */
test('a hidden or read-only entity carries its fields with it, a mandatory one does not', () => {
  const hidden = resolveProfiles([profile('p', '*', '*')], [
    setting('p', 'Addresses', null, 'hidden'),
    setting('p', 'Addresses', 'Country', 'mandatory')
  ], {});
  assert.equal(effectiveProperty(hidden, 'Addresses', 'Country'), 'hidden');

  const frozen = resolveProfiles([profile('p', '*', '*')], [
    setting('p', 'Addresses', null, 'readOnly'),
    setting('p', 'Addresses', 'Country', 'mandatory')
  ], {});
  assert.equal(effectiveProperty(frozen, 'Addresses', 'Country'), 'readOnly');
  // A field hidden inside a read-only entity stays hidden: the entity only freezes what is shown.
  const mixed = resolveProfiles([profile('p', '*', '*')], [
    setting('p', 'Addresses', null, 'readOnly'),
    setting('p', 'Addresses', 'POBox', 'hidden')
  ], {});
  assert.equal(effectiveProperty(mixed, 'Addresses', 'POBox'), 'hidden');

  const required = resolveProfiles([profile('p', '*', '*')], [
    setting('p', 'TaxNumbers', null, 'mandatory')
  ], {});
  assert.equal(effectiveProperty(required, 'TaxNumbers', 'BPTaxNumber'), null);
});

test('a field nothing mentions is left exactly as the screen would have had it', () => {
  const state = fieldState({ entities: {}, fields: {} }, 'Addresses', 'Country');
  assert.deepEqual(state, { property: null, visible: true, editable: true, required: false });
});

// --- Enforcement -----------------------------------------------------------------------

/**
 * The half that makes the profile more than decoration. Without it, a mandatory field is a star on
 * a label that a direct service call - or a field the screen never rendered - walks straight past.
 */
test('a mandatory field left empty blocks the submit, on the row that is empty', async () => {
  const resolved = resolveProfiles([profile('p', 'create', 'Requester')], [
    setting('p', 'Addresses', 'Country', 'mandatory')
  ], { requestType: 'create', role: 'Requester' });
  const stages = createFieldPropertyStages(resolved, csn);
  const findings = await stages.validations[0].run({
    root: {},
    sections: { Addresses: [{ Country: 'BE' }, { Country: '' }] }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].field, 'Addresses.Country');
  assert.match(findings[0].message, /row 2/u);
});

test('a mandatory entity with no rows blocks the submit', async () => {
  const resolved = resolveProfiles([profile('p', '*', '*')], [
    setting('p', 'TaxNumbers', null, 'mandatory')
  ], {});
  const stages = createFieldPropertyStages(resolved, csn);
  const empty = await stages.validations[0].run({ root: {}, sections: {} });
  assert.equal(empty.length, 1);
  assert.match(empty[0].message, /At least one Tax Number/u);
  const filled = await stages.validations[0].run({ root: {}, sections: { TaxNumbers: [{ BPTaxNumber: 'BE1' }] } });
  assert.deepEqual(filled, []);
});

/**
 * Nobody can fill in a field they cannot see, so the cascade is read before anything blocks - and
 * with nothing left to enforce there is no stage at all, not a stage that runs and finds nothing.
 */
test('a mandatory field inside a hidden entity does not block anything', async () => {
  const resolved = resolveProfiles([profile('a', '*', '*'), profile('b', '*', '*')], [
    setting('a', 'Addresses', null, 'hidden'),
    setting('b', 'Addresses', 'Country', 'mandatory')
  ], {});
  // The merge itself is the cascade's input: hidden + (nothing) on the entity stays hidden.
  assert.equal(effectiveProperty(resolved, 'Addresses', 'Country'), 'hidden');
  assert.deepEqual(createFieldPropertyStages(resolved, csn).validations, []);
});

test('no profile means no stage at all, not an empty one that runs per request', () => {
  const stages = createFieldPropertyStages({ entities: {}, fields: {} }, csn);
  assert.deepEqual(stages.validations, []);
  assert.deepEqual(stages.derivations, []);
});

// --- Where it is wired in --------------------------------------------------------------

/**
 * The role a screen renders for is the client's business; the role a submit is judged under is not.
 * Taking it from the request data would let a requester claim `Approver` and submit past every
 * mandatory field the profile sets for them.
 */
test('the enforcing context is the requester, never a role the client named', () => {
  assert.match(serviceJs, /const requesterContext = \(req\) => \(\{ requestType: req\.data\.RequestType, role: 'Requester' \}\)/u);
  // Three call sites: the two check buttons share one runner, then submit and resubmit.
  assert.equal((serviceJs.match(/fieldPropertyStages\(requesterContext\(req\)\)/gu) || []).length, 3);
  // The rendering answer is a separate, read-only function.
  assert.match(serviceCds, /function effectiveFieldProperties\(/u);
  assert.match(serviceJs, /this\.on\('effectiveFieldProperties'/u);
});

test('the property validations run alongside the configured ones, on every gate', () => {
  assert.equal(
    (serviceJs.match(/\[\.\.\.properties\.validations, \.\.\.configured\.validations, \.\.\.registry\.validations\]/gu) || []).length,
    3,
    'check/duplicate-check, submit and resubmit'
  );
});

// --- The screen ------------------------------------------------------------------------

test('the screen loads the profiles before it renders, for the role it is showing', () => {
  assert.match(controller, /_loadFieldProperties\("create", "Requester"\)/u);
  assert.match(controller, /_loadFieldProperties\(state\.requestType \|\| "change", "Requester"\)/u);
  assert.match(controller, /_loadFieldProperties\(state\.requestType, mode === "approve" \? "Approver" : "Requester"\)/u);
  // Rendering is synchronous, so a field the profiles hide must never be painted and taken away.
  const create = controller.slice(controller.indexOf('_onCreateRoute:'));
  const body = create.slice(0, create.indexOf('_onDisplayRoute:'));
  assert.ok(body.indexOf('_loadFieldProperties') < body.indexOf('_renderAll()'));
});

test('hidden is not rendered, read-only is not editable, mandatory is starred', () => {
  // Both layouts drop the field entirely - a disabled input still shows the value.
  assert.equal((controller.match(/_isHiddenField\(section, field\)\) return false/gu) || []).length, 2, 'both layouts');
  const editable = controller.slice(controller.indexOf('_isEditable: function'));
  const editableBody = editable.slice(0, editable.indexOf('_isRequired: function'));
  assert.match(editableBody, /property === "hidden" \|\| property === "readOnly"/u);
  const required = controller.slice(controller.indexOf('_isRequired: function'));
  const requiredBody = required.slice(0, required.indexOf('_createFieldControl: function'));
  assert.match(requiredBody, /if \(property === "mandatory"\) return true/u);
  assert.match(requiredBody, /if \(property === "optional"\) return false/u);
});

/** An emptied container under a live heading reads as a load failure, not as a hidden section. */
test('a hidden entity hides its whole Object Page section', () => {
  assert.match(controller, /_setSectionVisible: function/u);
  assert.match(controller, /isA\("sap\.uxap\.ObjectPageSection"\)/u);
  const render = controller.slice(controller.indexOf('_renderSection: function'));
  const body = render.slice(0, render.indexOf('_openNewRecord:'));
  assert.match(body, /if \(entityProperty === "hidden"\) return;/u);
  // Read-only freezes the rows without hiding them.
  assert.match(body, /var editing = state\.editing && entityProperty !== "readOnly"/u);
  assert.match(body, /visible: editing && section\.creatable !== false/u);
  assert.match(body, /var showDelete = editing && section\.deletable !== false/u);
  // And the detail dialog opens read-only for the same entity.
  assert.match(controller, /Boolean\(state\.editing\) && this\._entityProperty\(section\) !== "readOnly"/u);
});

/** The metadata's root section id is not the payload catalog's, and only one place may know that. */
test('the root section is mapped to the catalog name in exactly one place', () => {
  assert.match(controller, /_sectionKey: function \(section\) \{\s*\n\s*return section\.kind === "root" \? "General" : section\.id;/u);
  assert.equal((controller.match(/"General" : section\.id/gu) || []).length, 1);
});
