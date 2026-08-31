'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'mdmrules', 'webapp');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const view = read(APP, 'ext', 'view', 'WorkflowRuleList.view.xml');
const controller = read(APP, 'ext', 'controller', 'WorkflowRuleList.controller.js');
const hub = read(APP, 'ext', 'view', 'MDMRuleHub.view.xml');
const hubController = read(APP, 'ext', 'controller', 'MDMRuleHub.controller.js');
const manifest = JSON.parse(read(APP, 'manifest.json'));

const serviceCds = read(ROOT, 'srv', 'duplicate-config-service.cds');
const serviceJs = read(ROOT, 'srv', 'duplicate-config-service.js');
const rulesCds = read(ROOT, 'db', 'workflow-rules.cds');
const changeRequestJs = read(ROOT, 'srv', 'change-request-service.js');

// The columns are the agreed shape of a rule, so they are pinned rather than left to a refactor.
// Reverted (2026-08-31) to two fixed condition slots, side by side, as it originally was - the
// single "Conditions" column that briefly replaced them is gone.
test('the workflow table has the columns a rule needs, in order', () => {
  const columns = [...view.matchAll(/<Column[^>]*>\s*<Text text="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(columns, ['CR Type', 'Step', 'Condition 1', 'Logic', 'Condition 2', 'Approvers', 'Active']);
});

test('the fifth tile leads to it, and the route exists', () => {
  assert.ok(
    hub.includes('header="Workflow Agent Determination"'),
    'the hub offers Workflow Agent Determination'
  );
  assert.equal((hub.match(/<GenericTile/gu) || []).length, 5);
  assert.match(hubController, /navTo\("WorkflowRuleList"\)/u);
  const route = manifest['sap.ui5'].routing.routes.find((entry) => entry.name === 'WorkflowRuleList');
  assert.ok(route, 'WorkflowRuleList has a route');
  assert.equal(route.pattern, 'WorkflowRules');
  assert.equal(
    manifest['sap.ui5'].routing.targets.WorkflowRuleList.name,
    'mdm.md.mdmrules.manage.ext.view.WorkflowRuleList'
  );
});

// Same page shape as the other three tables, so a steward does not have to learn two: its own
// entity, one update group, batch on save, discardable.
test('the page stores its own rows and batches them like the others', () => {
  assert.match(view, /items="\{ path: 'dc>\/WorkflowRules'/u);
  assert.equal(/dc>\/DuplicateRules|dc>\/ValidationRules/u.test(view), false, 'it binds nobody else');
  assert.match(view, /\$\$updateGroupId: 'ruleChanges'/u);
  assert.match(controller, /submitBatch\(UPDATE_GROUP\)/u);
  assert.match(controller, /resetChanges\(UPDATE_GROUP\)/u);
  // A rejected row leaves its change pending rather than silently vanishing.
  assert.match(controller, /hasPendingChanges\(UPDATE_GROUP\)/u);
  assert.match(view, /navButtonPress="\.onBackToHub"/u);
  assert.match(controller, /navTo\("MDMRuleHub", \{\}, true\)/u);
  // No $expand any more - conditions are plain scalars on the rule itself, not a child composition.
  assert.equal(/\$expand/u.test(view), false, 'nothing needs to be expanded for a plain scalar field');
});

// The closed lists are served, never hard-coded in the UI - the same rule the other pages follow.
test('the CR types and steps come from the service, not from the page', () => {
  assert.match(view, /items="\{ path: 'opt>\/requestTypes'/u);
  assert.match(view, /items="\{ path: 'opt>\/steps'/u);
  assert.match(controller, /_callAction\("workflowRuleOptions", \{\}\)/u);
  assert.match(serviceCds, /function workflowRuleOptions\(\) returns WorkflowRuleOptions/u);
  assert.match(serviceJs, /this\.on\('workflowRuleOptions'/u);
  // No `*` in the type list: an approver list is not something to default.
  assert.equal(require('../srv/checks/workflow-rules').REQUEST_TYPES.includes('*'), false);
});

/**
 * A condition names a payload field, so this page shares the quality pages' catalog and their
 * searchable value help - several hundred fields is not a ComboBox. Both fixed slots (Condition 1
 * and Condition 2) wire to the same shared dialog, exactly as every other condition cell in this
 * app already works.
 */
test('both condition fields are chosen through the shared value help', () => {
  for (const fieldName of ['conditionField', 'conditionField2']) {
    const fieldCell = view.slice(view.indexOf(`value="{dc>${fieldName}}"`));
    assert.match(
      fieldCell.slice(0, fieldCell.indexOf('/>')),
      /valueHelpRequest="\.onFieldValueHelp"/u,
      `${fieldName} opens the field value help`
    );
  }
  assert.match(controller, /ext\.fragment\.FieldValueHelp/u);
  assert.match(controller, /FilterOperator\.Contains/u);
  // The stored value is the qualified code, and it is read off the binding context BEFORE anything
  // resets the list - the bug that used to write a General name field when "Country" was searched.
  const chosen = controller.slice(controller.indexOf('onFieldChosen:'));
  const body = chosen.slice(0, chosen.indexOf('\n    },'));
  assert.ok(body.indexOf('getProperty("code")') < body.indexOf('setProperty('));
  assert.equal(/filter\(\[\]\)/u.test(body), false);
  const open = controller.slice(controller.indexOf('onFieldValueHelp:'));
  assert.match(open.slice(0, open.indexOf('.open("")')), /getBinding\("items"\)[\s\S]{0,80}filter\(\[\]\)/u);
});

/**
 * The Value cell is disabled once its own slot's operator is "is empty"/"is not empty" - those two
 * need no value at all. Logic stays always enabled: the engine ignores it entirely for zero or one
 * condition (see joinConditions in srv/checks/value-lists.js).
 */
test('each Value cell is disabled for its own empty/notEmpty, independent of the other slot', () => {
  const slot1 = view.slice(view.indexOf('value="{dc>conditionValues}"'));
  assert.match(
    slot1.slice(0, slot1.indexOf('/>')),
    /enabled="\{= \$\{dc>conditionOperator\} !== 'empty' &amp;&amp; \$\{dc>conditionOperator\} !== 'notEmpty' \}"/u
  );
  const slot2 = view.slice(view.indexOf('value="{dc>conditionValues2}"'));
  assert.match(
    slot2.slice(0, slot2.indexOf('/>')),
    /enabled="\{= \$\{dc>conditionOperator2\} !== 'empty' &amp;&amp; \$\{dc>conditionOperator2\} !== 'notEmpty' \}"/u
  );
  const logic = view.slice(view.indexOf('selectedKey="{dc>conditionLogic}"'));
  assert.equal(/enabled=/u.test(logic.slice(0, logic.indexOf('</ComboBox>'))), false);
});

/**
 * One value per cell, like every other rule table. Multiple selection was built here first and
 * withdrawn on 2026-08-21 after three failed attempts to make a token cell save reliably - see
 * "Multiple values per condition" in CLAUDE.md for what it would take. Pinned so it does not creep
 * back in by accident: a plain bound Input is the whole mechanism, and it is the one that works.
 */
test('every cell is a single bound value, and nothing tokenises', () => {
  for (const fieldName of ['conditionField', 'conditionField2']) {
    assert.match(view, new RegExp(`value="\\{dc>${fieldName}\\}"`, 'u'), `${fieldName} is a bound Input`);
  }
  for (const operatorName of ['conditionOperator', 'conditionOperator2']) {
    assert.match(view, new RegExp(`selectedKey="\\{dc>${operatorName}\\}"`, 'u'), `${operatorName} is a bound Select`);
  }
  for (const valuesName of ['conditionValues', 'conditionValues2']) {
    assert.match(view, new RegExp(`value="\\{dc>${valuesName}\\}"`, 'u'), `${valuesName} is a bound Input`);
  }
  assert.match(view, /value="\{dc>approvers\}"/u, 'approvers is a bound Input');
  assert.equal(/MultiInput/u.test(view), false, 'no token cell is left');
  assert.equal(/app:listPath|app:listSink/u.test(view), false, 'and no custom data driving one');
  assert.equal(/updateFinished/u.test(view), false, 'nothing has to be redrawn after a render');
  assert.equal(/ListCell/u.test(controller), false, 'the shared token module is gone');
  assert.equal(
    fs.existsSync(path.join(APP, 'ext', 'ListCell.js')),
    false,
    'and deleted rather than left behind'
  );
});

// The service validates whatever a client sends; the page checks the same things at the keyboard so
// a steward is not told by a rejected batch.
test('the row is checked before it is sent, and again on the way in', () => {
  assert.match(controller, /choose the CR type this rule applies to/u);
  assert.match(controller, /name the approver/u);
  assert.match(controller, /needs a value\."/u);
  assert.match(serviceJs, /guard\('WorkflowRules', WORKFLOW_RULES, validateWorkflowRule/u);
  // Its own store, or a write would drop the quality cache and leave the approvers stale.
  assert.match(serviceJs, /workflowRuleStore\.markStale/u);
  // The WorkflowRuleConditions guard is gone (reverted 2026-08-31, two fixed slots again) - both
  // slots validate as part of the rule itself now, through validateWorkflowRule alone.
  assert.equal(/WORKFLOW_RULE_CONDITIONS/u.test(serviceJs), false);
  assert.equal(/guard\(\s*'WorkflowRuleConditions'/u.test(serviceJs), false);
});

// Rows not columns, like every other table here: adding a step or an approver must be an INSERT,
// because cds-deploy refuses to drop an element. One value per column, so an extra approver is an
// extra row - which is what the Add button is for and what resolveApprovers merges.
test('the table is rows, and every column holds one value', () => {
  assert.match(rulesCds, /entity WorkflowRules : managed/u);
  for (const column of [
    'requestType', 'step', 'conditions', 'conditionField', 'conditionOperator', 'conditionValues',
    'conditionField2', 'conditionOperator2', 'conditionValues2', 'approvers', 'isActive'
  ]) {
    // The plural names are stuck: `cds-deploy` cannot rename an element any more than it can drop
    // one, so these hold ONE value under a name that reads like several.
    assert.match(rulesCds, new RegExp(`\\b${column}\\b`, 'u'), `${column} is modelled`);
  }
  // No order column: rows are additive, so every matching row contributes and nothing is ranked.
  // Neither WorkflowRules nor its own (abandoned) WorkflowRuleConditions declares one - a bare
  // mention of the WORD "sequence" is fine (it shows up explaining the absence), an actual column
  // is not.
  assert.equal(/\bsequence\s*:/u.test(rulesCds), false, 'no table declares a sequence column');
  assert.equal(/\bsequence\b/u.test(read(ROOT, 'srv', 'checks', 'workflow-rules.js')), false);
  assert.match(serviceCds, /entity WorkflowRules   as projection on workflow\.WorkflowRules/u);
});

/**
 * The dynamic-conditions detour, abandoned in two stages the same week, both permanently dead in
 * the schema because `cds-deploy` cannot drop OR retype an element:
 *
 *  1. `conditions` (a `LargeString`) shipped to production as the first cut - a line-per-condition
 *     text blob. Renaming it to a composition under the SAME name failed every deploy retry:
 *     "Changed element conditions is a lossy type change from cds.LargeString to cds.Composition
 *     and is not supported". The composition was given the new name `conditionRows` instead.
 *  2. `conditionRows`/`WorkflowRuleConditions` themselves are now ALSO abandoned (2026-08-31),
 *     reverted back to the original two fixed condition slots on direct feedback. Both stay in the
 *     model, permanently unused, for the identical reason `conditions` does.
 *
 * Nothing in the engine or the service reads or writes either dead mechanism any more.
 */
test('conditions and conditionRows are both dead; the two fixed slots are the live mechanism', () => {
  assert.match(rulesCds, /conditions\s+: LargeString;/u);
  assert.match(rulesCds, /conditionRows\s+: Composition of many WorkflowRuleConditions/u);
  assert.match(rulesCds, /lossy type change/u);
  assert.match(rulesCds, /entity WorkflowRuleConditions : managed/u);

  const engineJs = read(ROOT, 'srv', 'checks', 'workflow-rules.js');
  assert.equal(/rule\.conditions\b/u.test(engineJs), false, 'the engine never reads the dead scalar column');
  assert.equal(/rule\.conditionRows\b/u.test(engineJs), false, 'the engine never reads the dead composition either');
  assert.match(engineJs, /rule\[pair\.field\]/u, 'the engine reads the two fixed slots by name');

  // The service no longer even projects the dead entity - nothing depends on it being reachable
  // over OData any more.
  assert.equal(/entity WorkflowRuleConditions as projection/u.test(serviceCds), false);
});

/**
 * The point of the table: the approvers reach SBPA in the workflow context. Determined in
 * `workflowContext`, which runs after the validations and the duplicate gate and is rebuilt after a
 * rework - so a resubmitted request is routed on the payload the requester fixed, not the one that
 * was rejected.
 */
test('the approvers are sent with the workflow context, and never absent', () => {
  assert.match(changeRequestJs, /require\('\.\/checks\/workflow-rule-store'\)/u);
  const builder = changeRequestJs.slice(changeRequestJs.indexOf('const workflowContext = async'));
  const body = builder.slice(0, builder.indexOf('\n    };'));
  assert.match(body, /approversFor\(\{/u);
  assert.match(body, /requestType: req\.data\.RequestType/u);
  // Flattened to plain e-mail addresses at this boundary: the deployed process declares `approvers`
  // as an array of strings, and sending objects failed the whole submit with "/approvers/0 The value
  // must be of string type". resolveApprovers still returns { step, kind, value } - only what
  // crosses to SBPA is narrowed.
  //
  // A role entry (2026-08-27) is resolved to its actual member e-mails HERE, not sent as its bare
  // name - SBPA does not resolve BTP role collection membership itself, so a role name reaching it
  // unresolved names nobody it can assign a task to.
  assert.match(body, /emailsForRoleCollections\(roleNames\)/u);
  assert.match(body, /approver\.kind === 'user'/u);
  assert.match(body, /approver\.kind === 'role'/u);
  assert.match(body, /approvers: approverEmails/u, 'the context carries resolved e-mails, not role names');
  // Best-effort, like `businesspartnerinput`: an empty list is what SBPA read before this table
  // existed, so a routing hint must not cost a requester their submit.
  assert.match(body, /console\.warn/u);
});


/**
 * An approver is an e-mail address or a role, and the two are entered differently on purpose: an
 * address is free text nobody could offer a list for, while a role has to be spelled exactly as
 * SBPA knows it. So the cell takes typing AND offers the roles.
 */
test('the approver cell offers the roles and still takes a typed address', () => {
  const cell = view.slice(view.indexOf('value="{dc>approvers}"'));
  const body = cell.slice(0, cell.indexOf('/>'));
  assert.match(body, /showValueHelp="true"/u);
  assert.match(body, /valueHelpRequest="\.onRoleValueHelp"/u);
  // Typing is the other half and needs no dialog: an address is free text.
  assert.match(body, /change="\.onCellChange"/u);
  assert.match(view, /placeholder="e-mail or role"/u);
  // The condition cells are NOT given the role list - a country is not a role.
  const conditionCell = view.slice(view.indexOf('value="{dc>conditionValues}"'));
  assert.equal(
    /valueHelpRequest/u.test(conditionCell.slice(0, conditionCell.indexOf('/>'))),
    false,
    'the condition values have their own field help, not the roles'
  );
});

// Its own fragment, and one entry: the cell holds one approver, so several approvers are several
// rows - which is what the Add button is for and what the engine merges.
test('the role help is a real two-column table over the served agents', () => {
  const fragment = read(APP, 'ext', 'fragment', 'RoleValueHelp.fragment.xml');
  // Not sap.m.SelectDialog: it wraps a plain List with no column headers, and Type vs. Name/E-mail
  // is exactly the distinction this picker has to show.
  assert.equal(/<SelectDialog/u.test(fragment), false, 'a real Table, not a SelectDialog');
  assert.match(fragment, /<Table[\s\S]*items="\{ path: 'opt>\/agents'/u);
  const columns = [...fragment.matchAll(/<Column[^>]*>\s*<Text text="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(columns, ['Type', 'Name / E-mail']);
  assert.match(controller, /ext\.fragment\.RoleValueHelp/u);
  // Searchable over the value as well as the type, like the field help.
  assert.match(controller, /onRoleSearch/u);
  assert.match(controller, /FilterOperator\.Contains/u);
});

/**
 * The picker is sourced from the BTP subaccount itself, not from this app's own hand-kept role list
 * (ROLES/ROLE_TEXT, still used by the Field Property Profiles page, unchanged - a different concept:
 * Requester/Approver/DataSteward, versus who can actually be assigned an approval in the subaccount).
 */
test('the approver picker is served from the BTP subaccount, not the hard-coded roles', () => {
  assert.match(serviceCds, /agents {7}: array of Agent;/u);
  assert.match(serviceJs, /require\('\.\/wf\/btp-agents'\)/u);
  assert.match(serviceJs, /agents: await workflowAgents\(\)/u);
  assert.equal(/roles: ROLES\.filter/u.test(serviceJs), false, 'the hard-coded role list is gone here');
  // ROLES/ROLE_TEXT stay imported for fieldPropertyOptions - a different picker, untouched.
  assert.match(serviceJs, /ROLES, ROLE_TEXT/u);

  const agentsModule = read(ROOT, 'srv', 'wf', 'btp-agents.js');
  assert.match(agentsModule, /ROLE_COLLECTION_PREFIX = 'MDMLIGHT'/u);
  // Case-insensitive on purpose (2026-08-27): an admin's "Mdmlight"/"mdmlight" must still match.
  assert.match(agentsModule, /description\.toUpperCase\(\)\.startsWith\(ROLE_COLLECTION_PREFIX\)/u);
  assert.match(agentsModule, /type: 'Role'/u);
  assert.match(agentsModule, /type: 'User'/u);
  // Best-effort like every other BTP-platform read here: an unreachable subaccount API leaves the
  // picker empty, never the page down.
  assert.match(agentsModule, /console\.warn/u);
});

// Written through the cell's own binding, like every other value help on these pages, and the value
// is read off its binding context before anything touches the list.
test('choosing an agent writes it into the cell', () => {
  const chosen = controller.slice(controller.indexOf('onRolesChosen:'));
  const body = chosen.slice(0, chosen.indexOf('\n    },'));
  assert.match(body, /getProperty\("value"\)/u);
  assert.match(body, /this\._roleTarget\.context\.setProperty\(this\._roleTarget\.path, value\)/u);
  assert.ok(body.indexOf('getProperty("value")') < body.indexOf('setProperty('));
});

// --- Two fixed condition slots (reverted 2026-08-31) --------------------------------------------

/**
 * Condition 1 and Condition 2 each render as their own plain `HBox` of Field/Operator/Value - no
 * wrapping FlexBox, no Add/Remove Condition button, no child composition. "ik wil dit naast elkaar
 * zoals het ervoor was" (bring it back to how it originally was, side by side).
 */
test('Condition 1 and Condition 2 render as two plain HBox groups, not a dynamic list', () => {
  for (const [fieldName, operatorName, valuesName] of [
    ['conditionField', 'conditionOperator', 'conditionValues'],
    ['conditionField2', 'conditionOperator2', 'conditionValues2']
  ]) {
    const cell = view.slice(view.indexOf(`value="{dc>${fieldName}}"`));
    const hboxBody = cell.slice(0, cell.indexOf('</HBox>'));
    assert.match(hboxBody, new RegExp(`selectedKey="\\{dc>${operatorName}\\}"`, 'u'));
    assert.match(hboxBody, new RegExp(`value="\\{dc>${valuesName}\\}"`, 'u'));
    assert.match(hboxBody, /items="\{ path: 'opt>\/comparisons', templateShareable: false \}"/u);
  }
  // The dynamic mechanism is gone entirely - no wrapping FlexBox, no per-row Add/Remove.
  assert.equal(/<FlexBox/u.test(view), false, 'no wrapping FlexBox is left');
  assert.equal(/onAddCondition|onRemoveCondition/u.test(view), false, 'no Add/Remove Condition button is left');
  assert.equal(/onAddCondition|onRemoveCondition|_conditionsBinding/u.test(controller), false,
    'and the handlers are gone from the controller too');
});

// --- Operators (kept through the revert: "= of !=, en dan andere" was in the ORIGINAL ask too) ---

/**
 * The exact vocabulary rule-engine.js already offers ValidationRules/DerivationRules for their own
 * comparison column - asked for directly ("volgens mij alle mogelijke operatoren"), and it survives
 * the revert to two fixed slots because the ORIGINAL layout already had an operator per slot.
 */
test('the operator picker offers the same comparisons ValidationRules/DerivationRules already use', () => {
  const handler = serviceJs.slice(serviceJs.indexOf("this.on('workflowRuleOptions'"));
  const body = handler.slice(0, handler.indexOf('\n    });'));
  assert.match(body, /comparisons: Object\.entries\(COMPARISONS\)\.map/u);
  assert.match(serviceCds, /comparisons {2}: array of ComparisonOption;/u);

  const workflowRulesJs = read(ROOT, 'srv', 'checks', 'workflow-rules.js');
  assert.match(workflowRulesJs, /require\('\.\/rule-engine'\)/u);
  assert.match(workflowRulesJs, /COMPARISONS\[condition\.operator\]/u);
  // The two fixed slots carry their own operator column each - new, additive columns (2026-08-31).
  assert.match(rulesCds, /conditionOperator\s*: String\(10\) default 'eq';/u);
  assert.match(rulesCds, /conditionOperator2\s*: String\(10\) default 'eq';/u);
});

// --- Duplicate (2026-08-28, asked for: "copy en paste" for a rule) ------------------------------

/**
 * "Copy and paste" for a rule: the same `binding.create` mechanism Add Rule already uses, just
 * pre-filled from the selected row instead of blank. Simpler again since the revert to two fixed
 * condition slots (2026-08-31): every field, condition slots included, is a plain scalar on the
 * rule itself, so one `binding.create(copy)` is the whole job - there is no child composition left
 * to copy row by row.
 */
test('Duplicate copies the selected row (conditions included, as plain scalars) and strips its identity', () => {
  const button = view.slice(view.indexOf('text="Duplicate"'));
  assert.match(button.slice(0, button.indexOf('/>')), /press="\.onDuplicateRule"/u);

  const stripDeclaration = controller.slice(0, controller.indexOf('return Controller.extend'));
  assert.match(stripDeclaration, /var STRIP_ON_COPY = \[/u);
  for (const stripped of ['ID', '@odata.etag', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy']) {
    assert.match(stripDeclaration, new RegExp(`["']${stripped.replace(/[.]/u, '\\.')}["']`, 'u'), `${stripped} is stripped`);
  }

  const fn = controller.slice(controller.indexOf('onDuplicateRule: function'));
  const body = fn.slice(0, fn.indexOf('\n    },'));
  assert.match(body, /getSelectedItem\(\)/u);
  assert.match(body, /Object\.assign\(\{\}, context\.getObject\(\)\)/u);
  assert.match(body, /binding\.create\(copy\)/u);
  assert.match(body, /MessageToast\.show\("Select the rule to duplicate\."\)/u);
  // No child composition left to copy - the mechanism this replaced needed a second `.create()`
  // per condition; this one needs none.
  assert.equal(/_conditionsBinding/u.test(body), false);
});

// --- Excel import / export - a real .xlsx (2026-08-31, "op basis van al die fixed velden") -------

test('Export/Import buttons exist and drive a real .xlsx, not a new library', () => {
  assert.match(view, /text="Export to Excel"[\s\S]{0,80}press="\.onExportExcel"/u);
  assert.match(view, /text="Import from Excel"[\s\S]{0,80}press="\.onImportExcel"/u);
  // No third-party spreadsheet library - the ZIP/OOXML/DEFLATE handling is all hand-rolled, the
  // same choice the CSV codec this replaces already made, just for a real .xlsx this time.
  assert.equal(/require\(["'](xlsx|exceljs|jszip|pako)["']/iu.test(controller), false);
  assert.equal(/sap\/ui\/export\/Spreadsheet/u.test(controller), false);
  assert.match(controller, /function zipStore\(/u);
  assert.match(controller, /function readCentralDirectory\(/u);
  // DEFLATE decompression on import is a browser built-in, not a bundled inflate implementation.
  assert.match(controller, /new DecompressionStream\("deflate-raw"\)/u);
  assert.match(controller, /type: "application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet"/u);
  assert.match(controller, /download = "workflow-agent-determination\.xlsx"/u);
  assert.match(controller, /accept = "\.xlsx"/u);
});

/**
 * The columns mirror the page itself exactly - "de structuur die ook zichtbaar is in de app"
 * (asked for) - one Field/Operator/Value column per fixed condition slot, matching BRF+'s own
 * decision-table Excel up/download shape. No capped/variable column count is needed any more, now
 * that conditions are two fixed slots rather than an unbounded composition.
 */
test('xlsxColumns matches exactly what a WorkflowRules row holds', () => {
  const fn = controller.slice(controller.indexOf('function xlsxColumns'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  const keys = [...body.matchAll(/key: "([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(keys, [
    'ID', 'requestType', 'step',
    'conditionField', 'conditionOperator', 'conditionValues', 'conditionLogic',
    'conditionField2', 'conditionOperator2', 'conditionValues2',
    'approvers', 'isActive'
  ]);
  const labels = [...body.matchAll(/label: "([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(labels, [
    'ID', 'CR Type', 'Step',
    'Condition 1 Field', 'Condition 1 Operator', 'Condition 1 Value', 'Logic',
    'Condition 2 Field', 'Condition 2 Operator', 'Condition 2 Value',
    'Approvers', 'Active'
  ]);
});

/**
 * Extracted and evaluated directly (the one exception to this file's own source-pinning style),
 * because a hand-rolled ZIP writer/reader and a hand-rolled XML scanner are exactly the kind of code
 * that looks right and is not - three real bugs were found writing these tests, not by inspection:
 * an un-unescaped `&amp;`/`&lt;`/`&gt;`/`&quot;` in cell text, and a self-closing `<c ... />` cell
 * (exactly what real Excel writes for an empty cell) being misread as an OPEN tag, which silently
 * shifted every column after it one to the left for the rest of the row.
 */
function extractFunctions(source, names) {
  const body = names.map((name) => {
    const patterns = [
      new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`, 'u'),
      new RegExp(`(?:var|const) ${name}\\s*=`, 'u')
    ];
    let start = -1;
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (match) { start = match.index; break; }
    }
    if (start === -1) throw new Error(`not found in controller source: ${name}`);
    if (/^(?:async\s+)?function/u.test(source.slice(start))) {
      const braceStart = source.indexOf('{', start);
      let depth = 0;
      let end = braceStart;
      for (let i = braceStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      return source.slice(start, end);
    }
    // var/const declaration - scan to the matching top-level semicolon, tracking quotes so a `;`
    // inside a string literal (there are several, in the XML template constants) is not mistaken
    // for the end of the statement.
    let i = start;
    let inString = false;
    let quote = '';
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
      if (ch === ';') { i += 1; break; }
    }
    return source.slice(start, i);
  }).join('\n');
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

const XLSX_FUNCTION_NAMES = [
  'crc32', 'utf8Bytes', 'xmlEscape', 'COLUMN_LETTERS', 'columnLetters', 'columnIndexOf',
  'writeUint32LE', 'writeUint16LE', 'zipStore',
  'readUint32LE', 'readUint16LE', 'findEndOfCentralDirectory', 'readCentralDirectory', 'extractZipEntry',
  'xmlUnescape', 'parseAttrs', 'matchTags', 'parseSharedStrings', 'cellText', 'parseWorksheetTable',
  'resolveFirstSheetPath', 'xlsxColumns', 'STYLES_XML', 'CONTENT_TYPES_XML', 'RELS_XML',
  'WORKBOOK_XML', 'WORKBOOK_RELS_XML', 'sheetXml', 'buildWorkflowRulesXlsx', 'readWorkflowRulesXlsx',
  'isTruthyCell'
];

const xlsx = extractFunctions(controller, XLSX_FUNCTION_NAMES);

// The ZIP format's own checksum - a standard check value, so a subtly wrong polynomial or a
// reversed bit order is caught immediately rather than only once a file fails to open.
test('crc32 matches the standard CRC-32 check values', () => {
  assert.equal(xlsx.crc32(new TextEncoder().encode('')), 0);
  assert.equal(xlsx.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('columnLetters/columnIndexOf round-trip through the double-letter boundary', () => {
  assert.equal(xlsx.columnLetters(0), 'A');
  assert.equal(xlsx.columnLetters(25), 'Z');
  assert.equal(xlsx.columnLetters(26), 'AA');
  assert.equal(xlsx.columnIndexOf('AA7'), 26);
  assert.equal(xlsx.columnIndexOf('B12'), 1);
});

test('a rule with every field filled in round-trips through build and read', async () => {
  const rows = [{
    ID: '1', requestType: 'create', step: 'Approve',
    conditionField: 'Addresses.Country', conditionOperator: 'eq', conditionValues: 'BE|NL',
    conditionLogic: 'AND',
    conditionField2: 'General.BusinessPartnerCategory', conditionOperator2: 'ge', conditionValues2: '2',
    approvers: 'maarten@alluvion.eu|DataSteward', isActive: true
  }];
  const bytes = xlsx.buildWorkflowRulesXlsx(rows);
  const table = await xlsx.readWorkflowRulesXlsx(bytes);
  assert.deepEqual(table[0], xlsx.xlsxColumns().map((column) => column.label));
  assert.deepEqual(table[1], [
    '1', 'create', 'Approve',
    'Addresses.Country', 'eq', 'BE|NL', 'AND',
    'General.BusinessPartnerCategory', 'ge', '2',
    'maarten@alluvion.eu|DataSteward', true
  ]);
});

// Entity-escaped characters in a value - a comma, a quote, an ampersand, angle brackets, exactly
// the kind of text an approver's e-mail alias or a company name carries - must come back exactly
// as typed, not still XML-escaped.
test('special characters in a value survive the round trip unescaped', async () => {
  const rows = [{
    ID: '2', requestType: 'change', step: 'Approve',
    conditionField: '', conditionOperator: 'eq', conditionValues: '',
    conditionLogic: 'AND',
    conditionField2: '', conditionOperator2: 'eq', conditionValues2: '',
    approvers: 'Acme, "big" corp <x@y.com> & Co', isActive: false
  }];
  const bytes = xlsx.buildWorkflowRulesXlsx(rows);
  const table = await xlsx.readWorkflowRulesXlsx(bytes);
  assert.equal(table[1][10], 'Acme, "big" corp <x@y.com> & Co');
  assert.equal(table[1][11], false);
});

/**
 * The regression this whole reading path was rewritten around: real Excel (and any conforming
 * writer - openpyxl reproduced it in a live round trip while writing this) represents an EMPTY
 * inlineStr cell as a self-closing tag WITH A SPACE before the slash: `<c r="D3" t="inlineStr" />`.
 * A naive "greedy attributes, then look for `/>`" regex reads that trailing `/` as part of the
 * attribute string, so `/>` never matches, the tag reads as OPEN, and everything up to the next
 * `</c>` it can find - typically the FOLLOWING cell's own closing tag - is swallowed as this cell's
 * content. Every column after the empty one then lands one position too far left for the rest of
 * the row. Fixed by making the attribute group lazy so it stops expanding the moment `/>` matches.
 */
test('a self-closing empty cell does not shift the columns after it', () => {
  const sheetXmlText = '<?xml version="1.0"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>ID</t></is></c>'
    + '<c r="B1" t="inlineStr"><is><t>CR Type</t></is></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>1</t></is></c>'
    + '<c r="B2" t="inlineStr" />'
    + '<c r="C2" t="inlineStr"><is><t>Approve</t></is></c></row>'
    + '</sheetData></worksheet>';
  const table = xlsx.parseWorksheetTable(sheetXmlText, []);
  assert.deepEqual(table[0], ['ID', 'CR Type']);
  assert.deepEqual(table[1], ['1', '', 'Approve']);
});

test('isTruthyCell is tolerant of how a business user writes "yes" in Excel', () => {
  assert.equal(xlsx.isTruthyCell(true), true);
  assert.equal(xlsx.isTruthyCell(false), false);
  for (const truthy of ['true', 'TRUE', '1', 'yes', 'Yes', 'x', 'X', ' x ']) {
    assert.equal(xlsx.isTruthyCell(truthy), true, `"${truthy}" reads as active`);
  }
  for (const falsy of ['', 'no', 'false', '0', undefined]) {
    assert.equal(xlsx.isTruthyCell(falsy), false, `"${falsy}" reads as inactive`);
  }
});

/**
 * The container-level round trip, independent of the worksheet's own XML: build a ZIP with
 * `zipStore` (what export writes - STORE only), then read it back through
 * `readCentralDirectory`/`extractZipEntry` (what import reads). Confirms the ZIP structure itself -
 * local headers, central directory, end-of-central-directory - is self-consistent, not only that
 * the higher-level xlsx functions happen to agree with each other.
 */
test('zipStore/readCentralDirectory/extractZipEntry round-trip a STORE-only archive', async () => {
  const files = [
    { name: 'a.txt', data: new TextEncoder().encode('hello world') },
    { name: 'dir/b.txt', data: new TextEncoder().encode('') }
  ];
  const bytes = xlsx.zipStore(files);
  const entries = xlsx.readCentralDirectory(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'dir/b.txt']);
  assert.deepEqual([...entries.map((entry) => entry.method)], [0, 0]);
  const first = await xlsx.extractZipEntry(bytes, entries[0]);
  assert.equal(new TextDecoder().decode(first), 'hello world');
  const second = await xlsx.extractZipEntry(bytes, entries[1]);
  assert.equal(second.length, 0);
});

/**
 * Real Excel always DEFLATEs on save, which export never does but import has to read - proven with
 * Node's own `zlib.deflateRawSync` standing in for "whatever Excel's own compressor produced",
 * decompressed here through the identical `DecompressionStream('deflate-raw')` the controller uses.
 */
test('extractZipEntry decompresses a DEFLATE (method 8) entry via DecompressionStream', async () => {
  const uncompressed = Buffer.from('a value only real Excel would have compressed this way');
  const compressed = zlib.deflateRawSync(uncompressed);
  const entry = { name: 'xl/worksheets/sheet1.xml', method: 8, compressedSize: compressed.length, localHeaderOffset: 0 };
  const local = Buffer.alloc(30 + 'xl/worksheets/sheet1.xml'.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE('xl/worksheets/sheet1.xml'.length, 26);
  Buffer.from('xl/worksheets/sheet1.xml').copy(local, 30);
  const bytes = new Uint8Array(Buffer.concat([local, compressed]));
  const result = await xlsx.extractZipEntry(bytes, entry);
  assert.equal(new TextDecoder().decode(result), uncompressed.toString());
});

test('save cannot report success while a row is still local to the page', () => {
  assert.match(controller, /_transientRows: function/u);
  assert.match(controller, /context\.isTransient && context\.isTransient\(\)/u);
  const save = controller.slice(controller.indexOf('onSave: async function'));
  const body = save.slice(0, save.indexOf('onDiscard:'));
  // Checked after the submit and before anything says "saved".
  assert.ok(body.indexOf('submitBatch(UPDATE_GROUP)') < body.indexOf('_transientRows()'));
  assert.ok(body.indexOf('_transientRows()') < body.indexOf('MessageToast.show'));
  assert.match(body, /were not saved/u);
});
