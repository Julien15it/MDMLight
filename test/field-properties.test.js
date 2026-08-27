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
test('both condition lists lead with the wildcard', () => {
  assert.equal(REQUEST_TYPES[0], '*');
  assert.equal(ROLES[0], '*');
  assert.ok(REQUEST_TYPES.includes('create') && REQUEST_TYPES.includes('change'));
  for (const role of ['Requester', 'Approver', 'DataSteward']) assert.ok(ROLES.includes(role));
  // block/delete are in the status enum but no request carries them: a profile for one would look
  // configured and never match.
  assert.equal(REQUEST_TYPES.includes('delete'), false);
});

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

// --- What may be stored ----------------------------------------------------------------

test('an entity-level setting carries no element, and that is what makes it entity-level', () => {
  const { setting, error } = validateSetting({ section: 'TaxNumbers', property: 'mandatory' }, csn);
  assert.equal(error, undefined);
  assert.deepEqual(setting, { section: 'TaxNumbers', element: null, property: 'mandatory', critical: false });
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

/**
 * `critical` (2026-08-26) is independent of the four states: an entity can be mandatory AND critical,
 * or carry no property at all and only be critical - so an empty property is no longer, on its own,
 * a reason to refuse the row.
 */
test('an entity-level row may carry critical with no property at all', () => {
  const { setting, error } = validateSetting({ section: 'Addresses', critical: true }, csn);
  assert.equal(error, undefined);
  assert.deepEqual(setting, { section: 'Addresses', element: null, property: null, critical: true });
});

/**
 * Entity-level only (2026-08-26): critical marks the whole entity, not one field inside it, so a
 * field-level row is refused on the write path even though `resolveProfiles` still reads an older
 * one - see field-property-apply.test.js for that read-side tolerance.
 */
test('a field-level critical row is refused, not stored', () => {
  const { setting, error } = validateSetting({ section: 'Addresses', element: 'Country', critical: true }, csn);
  assert.equal(setting, undefined);
  assert.match(error, /cannot be critical/u);
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

// --- The conditions --------------------------------------------------------------------

test('a wildcard condition matches everything, a filled one matches only itself', () => {
  const global = { requestType: '*', role: '*' };
  assert.equal(profileMatches(global, { requestType: 'create', role: 'Approver' }), true);
  const creates = { requestType: 'create', role: '*' };
  assert.equal(profileMatches(creates, { requestType: 'create', role: 'Requester' }), true);
  assert.equal(profileMatches(creates, { requestType: 'change', role: 'Requester' }), false);
  const approver = { requestType: '*', role: 'Approver' };
  assert.equal(profileMatches(approver, { requestType: 'change', role: 'Requester' }), false);
  // An empty condition is read as "any" rather than as a value nothing equals.
  assert.equal(profileMatches({}, { requestType: 'create', role: 'Requester' }), true);
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
 * Tried and abandoned the same day (2026-08-26): one qualified field per profile row, matched like a
 * condition. Deployed before the reversal, so `cds-deploy`'s no-drop rule applies - the same trap
 * `sequence` above sits in. `critical` on `FieldPropertySettings` is the version that shipped instead.
 */
test('the abandoned per-profile critical field is dead weight, not read or written', () => {
  assert.match(model, /criticalField : String\(60\);/u);
  assert.equal(/criticalField/u.test(serviceJs), false, 'nothing in the service reads or writes it');
  assert.equal(/criticalField/u.test(controller), false, 'nothing in the page reads or writes it');
});

/** Independent of the four states, so it is its own column rather than a fifth value in that set. */
test('critical is a boolean on the settings row, alongside property rather than inside it', () => {
  assert.match(model, /critical : Boolean default false;/u);
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
test('the conditions are checked on the way in', () => {
  const guard = serviceJs.slice(serviceJs.indexOf("'FieldPropertyProfiles'"));
  assert.match(guard, /!REQUEST_TYPES\.includes\(requestType\)/u);
  assert.match(guard, /!ROLES\.includes\(role\)/u);
});

/**
 * The approval role is additionally sourced from the BTP subaccount, the same way the Workflow
 * Agent Determination picker is (2026-08-27) - Requester/DataSteward/`*` stay exactly the hard-coded
 * four they always were.
 */
test('a profile can also be scoped to a BTP role, not only the fixed four', () => {
  assert.match(serviceJs, /require\('\.\/wf\/btp-agents'\)/u);
  const guard = serviceJs.slice(serviceJs.indexOf("'FieldPropertyProfiles'"));
  const guardBody = guard.slice(0, guard.indexOf('\n    });'));
  assert.match(guardBody, /!ROLES\.includes\(role\)/u);
  assert.match(guardBody, /workflowAgents\(\)/u);
  assert.match(guardBody, /agent\.type === 'Role' && agent\.value === role/u);

  const options = serviceJs.slice(serviceJs.indexOf("this.on('fieldPropertyOptions'"));
  const optionsBody = options.slice(0, options.indexOf('\n    }));') + 6);
  assert.match(optionsBody, /ROLES\.map/u);
  assert.match(optionsBody, /workflowAgents\(\)/u);
  assert.match(optionsBody, /agent\.type === 'Role'/u);
});

// --- The page --------------------------------------------------------------------------

test('the profile list is the conditions, and the properties are behind Modify', () => {
  assert.match(view, /items="\{ path: 'dc>\/FieldPropertyProfiles'/u);
  assert.match(view, /text="Add Profile"[\s\S]{0,120}press="\.onAddProfile"/u);
  assert.match(view, /text="Modify"[\s\S]{0,160}press="\.onModify"/u);
  // Both conditions are closed lists from the service, never typed.
  assert.match(view, /items="\{ path: 'opt>\/requestTypes'/u);
  assert.match(view, /items="\{ path: 'opt>\/roles'/u);
  assert.match(controller, /_callAction\("fieldPropertyOptions", \{\}\)/u);
  // Same batch-on-save contract as the other rule pages.
  assert.match(view, /\$\$updateGroupId: 'ruleChanges'/u);
  assert.match(controller, /submitBatch\(UPDATE_GROUP\)/u);
  assert.match(controller, /resetChanges\(UPDATE_GROUP\)/u);
  assert.match(controller, /hasPendingChanges\(UPDATE_GROUP\)/u);
});

/** The interaction that was asked for: entities listed, each opening up to its own fields. */
test('the dialog lists entities that open up to their fields, with the four boxes on both levels', () => {
  assert.match(dialog, /items="\{ path: 'fp>\/rows'/u);
  assert.match(dialog, /press="\.onToggleEntity"/u);
  assert.match(dialog, /visible="\{= \$\{fp>kind\} === 'entity' \}"/u);
  for (const property of ['mandatory', 'readOnly', 'hidden', 'optional']) {
    assert.match(dialog, new RegExp(`selected="\\{= \\$\\{fp>property\\} === '${property}' \\}"`, 'u'));
    assert.match(dialog, new RegExp(`<core:CustomData key="property" value="${property}" />`, 'u'));
  }
  assert.match(dialog, /press="\.onApplyProperties"/u);
});

/**
 * Critical (2026-08-26, asked for after the per-profile column that shipped first): drawn as a fifth
 * checkbox next to Mandatory/Read-only/Hidden/Optional, but independent of them - it neither clears
 * nor is cleared by `onPropertySelect`, because an entity can be mandatory AND critical.
 */
test('critical is a fifth, independent checkbox drawn on both levels', () => {
  assert.equal((dialog.match(/<CheckBox/gu) || []).length, 5, 'four states plus critical, one row template');
  assert.match(dialog, /selected="\{fp>critical\}"/u);
  assert.match(dialog, /select="\.onCriticalSelect"/u);
  // No customData/property matching for this one - it is a plain boolean, not a member of the set.
  const criticalBox = dialog.slice(dialog.indexOf('select=".onCriticalSelect"') - 40);
  assert.equal(/CustomData/u.test(criticalBox.slice(0, 120)), false);
  assert.match(controller, /onCriticalSelect: function \(event\) \{/u);
  const handler = controller.slice(controller.indexOf('onCriticalSelect: function'));
  const body = handler.slice(0, handler.indexOf('\n    },'));
  assert.match(body, /row\.critical = event\.getParameter\("selected"\)/u);
  // Independent: it never touches `property`, and onPropertySelect never touches `critical`.
  assert.equal(/\.property/u.test(body), false);
});

/**
 * Entity-level only (2026-08-26): critical marks the whole entity, so the box is disabled on a field
 * row rather than removed - a requester can still see an older field-level value, just not set one.
 */
test('the critical box is only enabled on an entity row', () => {
  assert.match(dialog, /enabled="\{= \$\{fp>kind\} === 'entity' \}"[\s\S]{0,40}select="\.onCriticalSelect"/u);
  // Guarded on the JS side too, rather than trusting the binding alone.
  const handler = controller.slice(controller.indexOf('onCriticalSelect: function'));
  const body = handler.slice(0, handler.indexOf('\n    },'));
  assert.match(body, /if \(row\.kind !== "entity"\) return;/u);
});

/**
 * The rows the table binds ARE the tree nodes, so ticking a box writes through and expanding an
 * entity keeps whatever was ticked. Rebuilding from a copy is what would silently drop edits.
 */
test('ticking a box writes to the tree, and clears the other three', () => {
  assert.match(controller, /row\.property = event\.getParameter\("selected"\) \? picked : null/u);
  const rebuild = controller.slice(controller.indexOf('_rebuildRows: function'));
  assert.match(rebuild.slice(0, rebuild.indexOf('onToggleEntity')), /rows\.push\(entity\)/u);
  // The expression bindings all read the same row, so the list is refreshed rather than one path.
  assert.match(controller, /getModel\("fp"\)\.refresh\(true\)/u);
});

/** A row exists to carry either state, so it must be sent when it carries only one of them. */
test('a row is sent when only critical is set, and when only a property is set', () => {
  const fn = controller.slice(
    controller.indexOf('_settingsFromTree: function'), controller.indexOf('onApplyProperties:')
  );
  assert.match(fn, /if \(entity\.property \|\| entity\.critical\)/u);
  assert.match(fn, /if \(!field\.property && !field\.critical\) return;/u);
  assert.match(fn, /critical: !!entity\.critical/u);
  assert.match(fn, /critical: !!field\.critical/u);
});

/** "Clear" resets the whole row, or a field could sit there still critical with nothing to show why. */
test('clearing a profile clears critical along with the four properties', () => {
  const fn = controller.slice(
    controller.indexOf('onClearProperties: function'), controller.indexOf('_settingsFromTree:')
  );
  assert.match(fn, /entity\.critical = false;/u);
  assert.match(fn, /field\.critical = false;/u);
});

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
test('the page makes no claim about whether the profiles are applied', () => {
  assert.equal(/Nothing reads these profiles yet/u.test(view), false);
  assert.equal(/<MessageStrip/u.test(view), false, 'no standing banner');
});
