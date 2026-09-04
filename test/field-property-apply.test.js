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
  ROOT, 'app', 'businesspartner', '..', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'controller', 'BusinessPartnerMaintenance.controller.js'
);

const {
  PROPERTY_STATE, PROPERTIES, broadestProperty, resolveProfiles, effectiveProperty, entityProperty,
  fieldState, createFieldPropertyStages, profileMatches, LEGACY_ROLES
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

/**
 * A precedence column was modelled, dropped on 2026-08-20 and then put back the same day: removing
 * it failed `deploy_to_postgresql` four times over, because it had already reached the deployed
 * model and `cds-deploy` cannot drop an element. So the column stands and **nothing reads it** -
 * the merge is a join, so no matching profile is ever "first" and there is no order to read.
 */

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

/**
 * Approver/DataSteward stopped being fixed values 2026-08-27 - a profile's role is now free text
 * naming a BTP role collection, matched against the screen's own category by a case-insensitive
 * prefix, checked BOTH ways (widened the same day - see CLAUDE.md "Field property profiles"): a
 * profile scoped to "ApproverSales" applies when the screen only resolved the bare category
 * "Approver", and a profile still scoped to the bare "Approver" itself applies once the screen
 * resolves a SPECIFIC role like "Approver Customer" for the person actually looking at it. Two
 * DIFFERENT specific roles are neither a prefix of the other, so they still stay apart.
 */
test('a role is matched by category, case-insensitively, checked both ways', () => {
  assert.equal(profileMatches({ role: 'ApproverSales' }, { role: 'Approver' }), true);
  assert.equal(profileMatches({ role: 'approversales' }, { role: 'Approver' }), true);
  assert.equal(profileMatches({ role: 'DataStewardEU' }, { role: 'DataSteward' }), true);
  // The reverse direction: a profile scoped to the bare category still applies once a more specific
  // role is what is actually being checked - a global policy must not stop covering anyone the
  // moment role resolution gets more precise.
  assert.equal(profileMatches({ role: 'Approver' }, { role: 'ApproverSales' }), true);
  // Two specific roles for the same category are still kept apart - neither contains the other.
  assert.equal(profileMatches({ role: 'Approver Customer' }, { role: 'Approver Vendor' }), false);
  // A role for one category never matches a screen asking for a different one.
  assert.equal(profileMatches({ role: 'ApproverSales' }, { role: 'DataSteward' }), false);
});

/**
 * Fixed 2026-09-04, same bug and same fix as `specificRoleFor` in `btp-agents.js` (`includes`, not
 * `startsWith`): this app's own role collections put the function BEFORE the category
 * (`MDMLIGHT_Sales_Approver`), so the category is a SUFFIX, never a prefix, and a bare "Approver"
 * profile has no `startsWith` relationship to it at all. Went unnoticed for as long as
 * `resolveEffectiveRole` itself so often fell back to the bare category that the exact-match branch
 * quietly covered for it - the `specificrole` task input (`task-app.md`) closed that gap and is what
 * exposed this one: field property profiles stopped applying to any approver at all once the
 * resolved role reliably became the real, specific role collection name.
 */
test('a role in the real MDMLIGHT_<function>_<category> shape still matches its bare category', () => {
  assert.equal(profileMatches({ role: 'Approver' }, { role: 'MDMLIGHT_Sales_Approver' }), true);
  assert.equal(profileMatches({ role: 'DataSteward' }, { role: 'MDMLIGHT_EU_DataSteward' }), true);
  // Two different specific roles in this real shape are still kept apart.
  assert.equal(
    profileMatches({ role: 'MDMLIGHT_Sales_Approver' }, { role: 'MDMLIGHT_Finance_Approver' }), false
  );
  // A profile scoped to the exact specific role still applies to itself.
  assert.equal(
    profileMatches({ role: 'MDMLIGHT_Sales_Approver' }, { role: 'MDMLIGHT_Sales_Approver' }), true
  );
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

// --- Critical fields ---------------------------------------------------------------------

/**
 * `critical` (2026-08-26) is a boolean on `FieldPropertySettings`, independent of `property` -
 * gathered in the same pass as the property merge, off the same matching profiles, but with nothing
 * to merge across profiles: any matching row saying critical is enough, deduped into a plain list.
 */
test('every matching profile\'s critical rows contribute, deduped, field and entity kept apart', () => {
  const profiles = [profile('global', '*', '*'), profile('creates', 'create', '*')];
  const settings = [
    { ...setting('global', 'Addresses', 'Country', null), critical: true },
    { ...setting('creates', 'Addresses', 'Country', 'mandatory'), critical: true },
    { ...setting('global', 'TaxNumbers', null, null), critical: true }
  ];
  const resolved = resolveProfiles(profiles, settings, { requestType: 'create', role: 'Requester' });
  assert.deepEqual(resolved.criticalFields, ['Addresses.Country']);
  assert.deepEqual(resolved.criticalEntities, ['TaxNumbers']);
  // Still mandatory - critical never feeds the property merge.
  assert.equal(resolved.fields['Addresses.Country'], 'mandatory');
});

test('a row can be critical with no property, or have a property and not be critical', () => {
  const resolved = resolveProfiles(
    [profile('p', '*', '*')],
    [
      { ...setting('p', 'Addresses', 'Country', null), critical: true },
      { ...setting('p', 'Addresses', 'POBox', 'hidden'), critical: false }
    ],
    { requestType: 'create', role: 'Requester' }
  );
  assert.deepEqual(resolved.criticalFields, ['Addresses.Country']);
  assert.equal(resolved.fields['Addresses.Country'], undefined, 'no property, so no state to merge');
  assert.equal(resolved.fields['Addresses.POBox'], 'hidden');
});

test('an inactive profile, or one that does not match, contributes no critical rows either', () => {
  const profiles = [
    { ...profile('off', '*', '*'), isActive: false },
    profile('other-type', 'change', '*')
  ];
  const settings = [
    { ...setting('off', 'Addresses', 'Country', null), critical: true },
    { ...setting('other-type', 'Addresses', 'POBox', null), critical: true }
  ];
  const resolved = resolveProfiles(profiles, settings, { requestType: 'create', role: 'Requester' });
  assert.deepEqual(resolved.criticalFields, []);
  assert.deepEqual(resolved.criticalEntities, []);
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
 * `critical` is a marker for a data steward (drawn as "!" next to the section title), never a gate
 * (2026-08-26, revised): an empty critical entity does not block, and contributes no stage on its own
 * - only `mandatory` does that. Whether it was filled in is reported to SBPA via the `criticalField`
 * flag in the workflow context, not enforced here.
 */
test('critical alone contributes no validation stage, and blocks nothing', async () => {
  const resolved = resolveProfiles([profile('p', '*', '*')], [
    { ...setting('p', 'TaxNumbers', null, null), critical: true }
  ], {});
  assert.deepEqual(createFieldPropertyStages(resolved, csn).validations, []);
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

// --- Where it is wired in --------------------------------------------------------------

/**
 * The role a screen renders for is the client's business; the role a submit is judged under is not.
 * Taking it from the request data would let a requester claim `Approver` and submit past every
 * mandatory field the profile sets for them.
 */
test('the enforcing context is the requester, never a role the client named', () => {
  assert.match(serviceJs, /const requesterContext = \(req\) => \(\{ requestType: req\.data\.RequestType, role: 'Requester' \}\)/u);
  // Two textual call sites now (2026-08-31): the two check buttons share `runRequestChecks`, and
  // submit/resubmit/a data steward's `complete` decision/decideRequest's approve gate all share
  // `runSubmitValidations` - so the same requester context reaches six logical run paths through
  // two definitions rather than being copied into each one.
  assert.equal((serviceJs.match(/fieldPropertyStages\(requesterContext\(req\)\)/gu) || []).length, 2);
  assert.equal((serviceJs.match(/runSubmitValidations\(/gu) || []).length, 4, 'submit, resubmit, data steward complete, and decideRequest');
  // The rendering answer is a separate, read-only function.
  assert.match(serviceCds, /function effectiveFieldProperties\(/u);
  assert.match(serviceJs, /this\.on\('effectiveFieldProperties'/u);
});

/**
 * Rendering, unlike enforcement, is narrowed to the CURRENT user's own specific BTP role first
 * (2026-08-27) - "Approver Customer" rather than the bare "Approver" - so two profiles scoped to
 * different approver functions actually apply to different people. Never touches `Requester`:
 * requesterContext already hardcodes that one, and it is not a role collection concept.
 */
test('effectiveFieldProperties narrows Approver/DataSteward to the caller\'s own specific role', () => {
  assert.match(serviceJs, /require\('\.\/wf\/btp-agents'\)/u);
  assert.match(serviceJs, /RESOLVABLE_ROLE_CATEGORIES = \['Approver', 'DataSteward'\]/u);

  const resolver = serviceJs.slice(serviceJs.indexOf('async function resolveEffectiveRole'));
  const resolverBody = resolver.slice(0, resolver.indexOf('\n}'));
  assert.match(resolverBody, /if \(!RESOLVABLE_ROLE_CATEGORIES\.includes\(role\)\) return role;/u);
  assert.match(resolverBody, /specificRoleFor\(email, role\)/u);
  // Best-effort: an unresolvable role falls back to the literal category, never a rejected render.
  assert.match(resolverBody, /catch \(error\) \{/u);
  assert.match(resolverBody, /return role;/u);

  const handler = serviceJs.slice(serviceJs.indexOf("this.on('effectiveFieldProperties'"));
  const handlerBody = handler.slice(0, handler.indexOf('\n    });'));
  assert.match(handlerBody, /resolveEffectiveRole\(req, req\.data\.Role \|\| null, stepHeader\)/u);
});

test('the property validations run alongside the configured ones, on every gate', () => {
  // One definition in runRequestChecks (check/duplicate-check), one in the shared
  // runSubmitValidations (submit, resubmit, data steward complete, decideRequest's approve gate) -
  // see "the enforcing context is the requester" above for the full call-site count.
  assert.equal(
    (serviceJs.match(
      /\[\.\.\.properties\.validations, \.\.\.configured\.validations, \.\.\.nodeRequiredStages\.validations,\s*\.\.\.createCviStages\(\)\.validations, \.\.\.registry\.validations,\s*\.\.\.relationStages\([^)]*\)\.validations\]/gu
    ) || []).length,
    2,
    'runRequestChecks and runSubmitValidations'
  );
});

// --- The screen ------------------------------------------------------------------------

test('the screen loads the profiles before it renders, for the role it is showing', () => {
  assert.match(controller, /_loadFieldProperties\("create", "Requester"\)/u);
  assert.match(controller, /_loadFieldProperties\(state\.requestType \|\| "change", "Requester"\)/u);
  assert.match(
    controller,
    /_loadFieldProperties\(\s*state\.requestType,\s*specificRole \|\| \(mode === "approve" \? "Approver" : \(reviewing \? "DataSteward" : "Requester"\)\),\s*state\.changeRequest\s*\)/u
  );
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

/**
 * The Add/Edit record dialog (_createFieldGrid/_createFieldTable) already dropped a hidden field via
 * _isHiddenField; the section's own summary table did not, because _summaryFields just mapped
 * section.summaryFields straight to field objects with no filter. Reported directly (2026-08-27,
 * screenshot): a field hidden by a profile disappeared from the Add Addresses popup but stayed as a
 * table column, the opposite of "hidden drops the field from both layouts entirely".
 */

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

/**
 * `critical` (2026-08-26, revised) draws an exclamation mark next to a section's title - a marker
 * for a data steward, never a message strip and never a gate. Wired through the same
 * `effectiveFieldProperties` read the other four properties use, so a screen loaded for one role
 * cannot see a stale answer from another.
 */
test('a critical entity gets an exclamation mark next to its title, drawn on both root cards too', () => {
  assert.match(controller, /_isCriticalEntity: function \(section\) \{/u);
  assert.match(controller, /_markSectionCritical: function \(container, baseTitle, critical\)/u);
  const marker = controller.slice(controller.indexOf('_markSectionCritical: function'));
  const body = marker.slice(0, marker.indexOf('\n      },'));
  assert.match(body, /section\.setTitle\(critical \? baseTitle \+ " ⚠" : baseTitle\)/u);
  // Wired into the section renderer, and into both root cards (General Information and Names) -
  // critical is entity-level, and both cards render the same `General` payload section.
  const render = controller.slice(controller.indexOf('_renderSection: function'));
  assert.match(render.slice(0, render.indexOf('_openNewRecord:')), /_markSectionCritical\(container, section\.title, this\._isCriticalEntity\(section\)\)/u);
  assert.match(controller, /_isCriticalEntity\(this\._rootSection\)/u);
});

/** The metadata's root section id is not the payload catalog's, and only one place may know that. */

// --- What workflowContext sends for critical fields -------------------------------------

/**
 * `criticalField` is a scalar 'X'/' ' flag on the workflow context, not a list - `resolved
 * .criticalEntities` (from `resolveProfiles`, already exercised above) is what `workflowContext`
 * checks against the submitted payload's own sections via `sectionRows`, straight off
 * `resolvedProperties` - there is no separate store function for this any more.
 */
test('workflowContext resolves criticalField from resolvedProperties, not a dedicated store call', () => {
  assert.match(serviceJs, /const resolved = await resolvedProperties\(requesterContext\(req\)\);/u);
  assert.match(serviceJs, /const critical = resolved\.criticalEntities \|\| \[\];/u);
  assert.match(serviceJs, /if \(critical\.some\(\(section\) => sectionRows\(payload, section\)\.length > 0\)\) criticalField = 'X';/u);
  assert.match(serviceJs, /let criticalField = ' ';/u);
});

/**
 * `datastewards` is read straight from BTP role collections, the same way `approvers` is fetched -
 * and, since 2026-08-31, sent as the role collection NAMES rather than resolved member e-mails
 * (same reversion, same conversation with Arthur, as `approvers`' own role entries).
 * `dataStewardEmails` stays imported too - `processorsFor`'s own "who has it now" strip still wants
 * resolved e-mails, a display answer rather than a wire payload.
 */

// --- Gating what a derivation may propose by role/field-property (2026-08-31) ---------------------

/**
 * "Derivations/Proposals ook geblocked worden op basis van role/field properties (in Approval stap
 * niks tonen want niks is editeerbaar bv)" - the Check/Duplicate Check buttons now tell the server
 * which role the SCREEN is rendered for, and runRequestChecks narrows it the same way
 * effectiveFieldProperties does before turning it into a fieldEditable predicate for runChecks.
 */
test('runRequestChecks resolves the screen\'s own role into a fieldEditable predicate', () => {
  const runner = serviceJs.slice(
    serviceJs.indexOf('const runRequestChecks ='),
    serviceJs.indexOf("this.on('effectiveFieldProperties'")
  );
  assert.match(runner, /fieldState/u);
  assert.match(runner, /resolveEffectiveRole\(req, req\.data\.Role \|\| null, stepHeader\)/u);
  assert.match(
    runner,
    /resolvedProperties\(\{\s*requestType: req\.data\.RequestType \|\| null,\s*role: renderRole\s*\}\)/u
  );
  assert.match(runner, /const fieldEditable = \(target, field\) => fieldState\(renderResolved, target, field\)\.editable;/u);
  assert.match(runner, /fieldEditable,/u);
  assert.match(serviceJs, /const \{ fieldState \} = require\('\.\/checks\/field-properties'\);/u);
});

test('checkRequest and duplicateCheckRequest both declare RequestType/Role', () => {
  const check = serviceCds.slice(
    serviceCds.indexOf('action checkRequest('),
    serviceCds.indexOf('action duplicateCheckRequest(')
  );
  assert.match(check, /RequestType\s*:\s*String\(10\)/u);
  assert.match(check, /Role\s*:\s*String\(40\)/u);

  const duplicate = serviceCds.slice(
    serviceCds.indexOf('action duplicateCheckRequest('),
    serviceCds.indexOf('action decideRequest(')
  );
  assert.match(duplicate, /RequestType\s*:\s*String\(10\)/u);
  assert.match(duplicate, /Role\s*:\s*String\(40\)/u);
});

/** The client tells the server which role the screen renders for - same mapping _loadStagedRequest
 *  already uses for _loadFieldProperties, so a Check on the approve screen cannot propose a value
 *  into a field the object page itself never lets an approver touch. */
test('onCheck and onDuplicateCheck send the screen\'s own RequestType/Role', () => {
  assert.match(
    controller,
    /_checkRole: function \(state\) \{\s*return state\.mode === "approve" \? "Approver" : \(state\.mode === "datasteward" \? "DataSteward" : "Requester"\);/u
  );
  const onCheck = controller.slice(
    controller.indexOf('onCheck: async function'), controller.indexOf('onDuplicateCheck: async function')
  );
  assert.match(onCheck, /RequestType: state\.requestType \|\| null,\s*Role: this\._checkRole\(state\)/u);

  const onDuplicateCheck = controller.slice(
    controller.indexOf('onDuplicateCheck: async function'),
    controller.indexOf('onDuplicateCheck: async function') + 1200
  );
  assert.match(onDuplicateCheck, /RequestType: state\.requestType \|\| null,\s*Role: this\._checkRole\(state\)/u);
});
