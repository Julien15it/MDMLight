'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'mdmrules', 'webapp');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const view = read(APP, 'ext', 'view', 'WorkflowRuleList.view.xml');
const controller = read(APP, 'ext', 'controller', 'WorkflowRuleList.controller.js');
// The token cells are shared by all four rule pages, so what they do is asserted against the module
// rather than against this page - see quality-rules-page.test.js for the no-copies rule.
const listCell = read(APP, 'ext', 'ListCell.js');
const hub = read(APP, 'ext', 'view', 'MDMRuleHub.view.xml');
const hubController = read(APP, 'ext', 'controller', 'MDMRuleHub.controller.js');
const manifest = JSON.parse(read(APP, 'manifest.json'));

const serviceCds = read(ROOT, 'srv', 'duplicate-config-service.cds');
const serviceJs = read(ROOT, 'srv', 'duplicate-config-service.js');
const rulesCds = read(ROOT, 'db', 'workflow-rules.cds');
const changeRequestJs = read(ROOT, 'srv', 'change-request-service.js');

// The columns are the agreed shape of a rule, so they are pinned rather than left to a refactor.
test('the workflow table has the columns a rule needs, in order', () => {
  const columns = [...view.matchAll(/<Column[^>]*>\s*<Text text="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(columns, [
    'CR Type', 'Step', 'Condition 1 Field', 'Condition 1 Values',
    'Condition 2 Field', 'Condition 2 Values', 'Approvers', 'Active'
  ]);
});

test('the fifth tile leads to it, and the route exists', () => {
  assert.ok(hub.includes('header="Workflow Rules"'), 'the hub offers Workflow Rules');
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
 * searchable value help - several hundred fields is not a ComboBox.
 */
test('a condition field is chosen through the shared value help', () => {
  assert.match(view, /valueHelpRequest="\.onFieldValueHelp"/u);
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

// Half a condition is the dangerous half, so the values cell stays shut until there is a field -
// the same guard the validation and derivation pages carry.
test('a values cell is disabled until its field is chosen', () => {
  assert.match(view, /enabled="\{= !!\$\{dc>conditionField\} \}"/u);
  assert.match(view, /enabled="\{= !!\$\{dc>conditionField2\} \}"/u);
});

/**
 * Three cells hold a list. A MultiInput's tokens are an aggregation and the column is one string,
 * so the page keeps the two in step itself - `tokens` cannot be bound to a string and a formatter
 * cannot create controls.
 */
test('the two condition value cells and the approver cell take several values', () => {
  const multiInputs = [...view.matchAll(/<MultiInput[\s\S]*?\/>/gu)].map((match) => match[0]);
  assert.equal(multiInputs.length, 3);
  assert.deepEqual(
    multiInputs.map((cell) => (cell.match(/app:listPath="([^"]+)"/u) || [])[1]),
    ['conditionValues', 'conditionValues2', 'approvers']
  );
  for (const cell of multiInputs) {
    assert.match(cell, /tokenUpdate="\.onListTokenUpdate"/u);
    // Enter commits a value, and so does leaving the cell: a token silently dropped on the way out
    // is a rule quietly missing an approver.
    assert.match(cell, /submit="\.onListSubmit"/u);
    assert.match(cell, /change="\.onListChange"/u);
  }
  // Rendered rows get their tokens from the stored value, and every edit writes the whole list back.
  assert.match(view, /updateFinished="\.onRowsRendered"/u);
  assert.match(listCell, /removeAllTokens\(\)/u);
  assert.match(listCell, /new Token\(\{ key: value, text: value \}\)/u);
  assert.match(controller, /ListCell\.mixin\(this, \{/u);
});

// `tokenUpdate` fires before the aggregation changes, so reading the control back would miss the
// edit that triggered it.
test('the new list is computed from the added and removed tokens', () => {
  const handler = listCell.slice(listCell.indexOf('controller.onListTokenUpdate'));
  const body = handler.slice(0, handler.indexOf('\n    };'));
  assert.match(body, /removedTokens/u);
  assert.match(body, /addedTokens/u);
});

/**
 * The page and the service have to agree on how a list is stored, and a page splitting on a
 * different character would show one token where three are saved. The service reports its delimiter
 * so the mismatch is said out loud rather than debugged twice.
 */
test('the page and the service agree on the delimiter', () => {
  const { DELIMITER } = require('../srv/checks/value-lists');
  assert.match(listCell, new RegExp(`var DELIMITER = "\\${DELIMITER}"`, 'u'));
  assert.match(serviceCds, /listDelimiter : String\(1\)/u);
  assert.match(serviceJs, /listDelimiter: DELIMITER/u);
  assert.match(controller, /options\.listDelimiter !== ListCell\.DELIMITER/u);
});

// The service validates whatever a client sends; the page checks the same things at the keyboard so
// a steward is not told by a rejected batch.
test('the row is checked before it is sent, and again on the way in', () => {
  assert.match(controller, /choose the CR type this rule applies to/u);
  assert.match(controller, /add at least one approver/u);
  assert.match(controller, /needs at least one value, or clear its field/u);
  assert.match(serviceJs, /guard\('WorkflowRules', WORKFLOW_RULES, validateWorkflowRule/u);
  // Its own store, or a write would drop the quality cache and leave the approvers stale.
  assert.match(serviceJs, /workflowRuleStore\.markStale/u);
});

// Rows not columns, like every other table here: adding a step or an approver must be an INSERT,
// because cds-deploy refuses to drop an element.
test('the table is rows, and the lists are single columns', () => {
  assert.match(rulesCds, /entity WorkflowRules : managed/u);
  for (const column of [
    'requestType', 'step', 'conditionField', 'conditionValues', 'conditionField2',
    'conditionValues2', 'approvers', 'isActive'
  ]) {
    assert.match(rulesCds, new RegExp(`\\b${column}\\b`, 'u'), `${column} is modelled`);
  }
  // No order column: rows are additive, so every matching row contributes and nothing is ranked.
  assert.equal(/sequence/u.test(rulesCds), false, 'the table carries no order column');
  assert.equal(/sequence/u.test(read(ROOT, 'srv', 'checks', 'workflow-rules.js')), false);
  assert.match(serviceCds, /entity WorkflowRules   as projection on workflow\.WorkflowRules/u);
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
  // Flattened to the values at this boundary: the deployed process declares `approvers` as an
  // array of strings, and sending objects failed the whole submit with "/approvers/0 The value
  // must be of string type". resolveApprovers still returns { step, kind, value } - only what
  // crosses to SBPA is narrowed, so restoring it is a process-side schema change and this map.
  assert.match(
    body, /approvers: approvers\.map\(\(approver\) => approver\.value\)/u,
    'the context carries approvers as strings'
  );
  // Best-effort, like `businesspartnerinput`: an empty list is what SBPA read before this table
  // existed, so a routing hint must not cost a requester their submit.
  assert.match(body, /console\.warn/u);
});
