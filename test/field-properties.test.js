'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'mdmrules', 'webapp');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const model = read(ROOT, 'db', 'field-properties.cds');
const serviceCds = read(ROOT, 'srv', 'duplicate-config-service.cds');
const serviceJs = read(ROOT, 'srv', 'duplicate-config-service.js');
const view = read(APP, 'ext', 'view', 'FieldPropertyProfileList.view.xml');
const dialog = read(APP, 'ext', 'fragment', 'FieldPropertyDialog.fragment.xml');
const controller = read(APP, 'ext', 'controller', 'FieldPropertyProfileList.controller.js');

const {
  PROPERTIES, REQUEST_TYPES, ROLES, fieldPropertyTree, validateSetting, normaliseSettings,
  profileMatches
} = require('../srv/checks/field-properties');

// A CSN stand-in: payloadFields reads `definitions[entity].elements`, so two nodes are enough to
// exercise the shaping without loading the whole model.
const csn = {
  definitions: {
    'mdmlight.staging.StagedAddresses': {
      elements: {
        ID: { type: 'cds.UUID' },
        request_ID: { type: 'cds.UUID' },
        Country: { type: 'cds.String' },
        POBox: { type: 'cds.String' },
        request: { type: 'cds.Association', target: 'x' }
      }
    },
    'mdmlight.staging.StagedTaxNumbers': {
      elements: { BPTaxNumber: { type: 'cds.String' } }
    }
  }
};

// --- The catalog -----------------------------------------------------------------------

test('the four properties are the ones that were asked for, in column order', () => {
  assert.deepEqual(PROPERTIES, ['mandatory', 'readOnly', 'hidden', 'optional']);
});

/** `*` is the "all" both conditions take, and it has to be offered, not typed. */

/** Generated from the staging model, so a new node appears in the dialog with no UI change. */
test('the entity tree is the payload model, keys and associations left out', () => {
  const tree = fieldPropertyTree(csn);
  const addresses = tree.find((entity) => entity.section === 'Addresses');
  assert.ok(addresses, 'Addresses is an entity');
  assert.equal(addresses.text, 'Address');
  assert.deepEqual(addresses.fields.map((field) => field.element), ['Country', 'POBox']);
  assert.equal(addresses.fields[0].field, 'Addresses.Country');
  // An entity with nothing addressable is nothing anyone can say anything about.
  assert.equal(tree.some((entity) => !entity.fields.length), false);
});

test('an unknown entity, field or property is refused rather than stored', () => {
  assert.match(validateSetting({ section: 'Nowhere', property: 'hidden' }, csn).error, /not an entity/u);
  assert.match(
    validateSetting({ section: 'Addresses', element: 'Country', property: 'urgent' }, csn).error,
    /not a field property/u
  );
  assert.match(
    validateSetting({ section: 'Addresses', element: 'Nonsense', property: 'hidden' }, csn).error,
    /not a field of/u
  );
});

/** One state per target: the dialog is a radio group drawn as checkboxes, and the store agrees. */
test('the same target twice keeps the last one, never both', () => {
  const { settings, errors } = normaliseSettings([
    { section: 'Addresses', element: 'Country', property: 'mandatory' },
    { section: 'Addresses', element: 'Country', property: 'hidden' },
    { section: 'Addresses', property: 'readOnly' }
  ], csn);
  assert.deepEqual(errors, []);
  assert.equal(settings.length, 2);
  assert.equal(settings.find((s) => s.element === 'Country').property, 'hidden');
  // The entity-level row is its own target, not a duplicate of the field row.
  assert.ok(settings.find((s) => s.element === null));
});

// --- The service -----------------------------------------------------------------------

test('the profile and its settings are exposed, and the settings are written by the action', () => {
  assert.match(model, /entity FieldPropertyProfiles : managed/u);
  assert.match(model, /settings\s+: Composition of many FieldPropertySettings/u);
  assert.match(model, /property : String\(12\);/u);
  assert.match(serviceCds, /entity FieldPropertyProfiles as projection on/u);
  assert.match(serviceCds, /action saveFieldProperties\(/u);
  assert.match(serviceCds, /function fieldPropertyOptions\(\)/u);
  assert.match(serviceCds, /function fieldPropertiesOf\(/u);
});

/**
 * Wholesale replace, the same reasoning as the staged nodes in change-request-service: the dialog
 * always sends the complete state of one profile, so rewriting beats diffing and no unticked row
 * can survive as a setting nobody can see any more.
 */
test('saving a profile replaces its settings rather than merging them', () => {
  const save = serviceJs.slice(serviceJs.indexOf("this.on('saveFieldProperties'"));
  const body = save.slice(0, save.indexOf('// Delegated to BusinessPartnerService'));
  assert.match(body, /DELETE\.from\(SETTINGS\)\.where\(\{ profile_ID: profile \}\)/u);
  const deleteAt = body.indexOf('DELETE.from(SETTINGS)');
  assert.ok(deleteAt < body.indexOf('INSERT.into(SETTINGS)'), 'the old rows go before the new ones');
  // Refused, not filtered: storing the valid remainder leaves a profile quietly missing what
  // someone thought they set.
  assert.match(body, /if \(errors\.length\) return req\.reject\(400/u);
  assert.ok(body.indexOf('errors.length') < deleteAt, 'nothing is deleted before the rows validate');
  // A profile that does not exist has nothing to hang settings on.
  assert.match(body, /if \(!stored\) return req\.reject\(404/u);
});

/** A condition outside the closed list makes a profile that can never fire. */

/**
 * Approver/DataSteward are sourced from the BTP subaccount now (2026-08-27), the same way the
 * Workflow Agent Determination picker is - `*` and Requester are the only two still hard-coded
 * (ROLES), and a row saved before this change with the literal Approver/DataSteward value is still
 * accepted (LEGACY_ROLES). The bare "MDMLIGHT" role itself is excluded everywhere here - it is the
 * catalog-level role for the whole app, not a Requester/Approver/DataSteward-shaped one.
 */
test('a profile can also be scoped to a BTP role, and legacy rows still save', () => {
  assert.match(serviceJs, /require\('\.\/wf\/btp-agents'\)/u);
  const guard = serviceJs.slice(serviceJs.indexOf("'FieldPropertyProfiles'"));
  const guardBody = guard.slice(0, guard.indexOf('\n    });'));
  assert.match(guardBody, /!ROLES\.includes\(role\) && !LEGACY_ROLES\.includes\(role\)/u);
  assert.match(guardBody, /workflowAgents\(\)/u);
  assert.match(guardBody, /agent\.value === role && agent\.value\.toUpperCase\(\) !== 'MDMLIGHT'/u);

  const options = serviceJs.slice(serviceJs.indexOf("this.on('fieldPropertyOptions'"));
  const optionsBody = options.slice(0, options.indexOf('\n    }));') + 6);
  assert.match(optionsBody, /ROLES\.map/u);
  assert.match(optionsBody, /workflowAgents\(\)/u);
  assert.match(optionsBody, /agent\.type === 'Role' && agent\.value\.toUpperCase\(\) !== 'MDMLIGHT'/u);
});

/** The interaction that was asked for: entities listed, each opening up to its own fields. */

/**
 * The rows the table binds ARE the tree nodes, so ticking a box writes through and expanding an
 * entity keeps whatever was ticked. Rebuilding from a copy is what would silently drop edits.
 */

/** Several hundred fields: a search that only matched entity names would never find PO Box. */
test('the search finds fields as well as entities, and opens the entity holding them', () => {
  assert.match(dialog, /liveChange="\.onFieldSearch"/u);
  const rebuild = controller.slice(controller.indexOf('_rebuildRows: function'));
  const body = rebuild.slice(0, rebuild.indexOf('onToggleEntity'));
  assert.match(body, /field\.text\.toLowerCase\(\)\.indexOf\(query\)/u);
  assert.match(body, /entity\.expanded \|\| \(query && !entityMatches\)/u);
});

/** The settings hang off a saved profile, so Modify on an unsaved row has nothing to write to. */
test('modify saves the profile first rather than failing on a missing id', () => {
  const modify = controller.slice(controller.indexOf('onModify: async function'));
  assert.match(modify.slice(0, modify.indexOf('_confirmSaveFirst:')), /_confirmSaveFirst\(\)/u);
  assert.match(controller, /has to be saved before its field properties can be set/u);
  assert.match(controller, /resolve\(!this\._model\(\)\.hasPendingChanges\(UPDATE_GROUP\)\)/u);
});

/**
 * The profiles drive the maintenance screen as of 2026-08-20, so the strip that said otherwise had
 * to go with the same discipline it was added under - and the rule pages carry no standing banners.
 */
