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
  assert.match(body, /^\s*approvers$/mu, 'the context carries an `approvers` key');
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
  const cell = view.slice(view.indexOf('app:listPath="approvers"'));
  const body = cell.slice(0, cell.indexOf('/>'));
  assert.match(body, /showValueHelp="true"/u);
  assert.match(body, /valueHelpRequest="\.onRoleValueHelp"/u);
  // Typing is unaffected: Enter and leaving the cell both still commit a value.
  assert.match(body, /submit="\.onListSubmit"/u);
  assert.match(body, /change="\.onListChange"/u);
  // Against the whole view: the placeholder sits above the listPath the slice starts at.
  assert.match(view, /placeholder="e-mail or role"/u);
  // The condition cells are NOT given the role list - a country is not a role.
  const conditionCell = view.slice(view.indexOf('app:listPath="conditionValues"'));
  assert.equal(
    /valueHelpRequest/u.test(conditionCell.slice(0, conditionCell.indexOf('/>'))),
    false,
    'the condition values have their own field help, not the roles'
  );
});

// Its own fragment, and multiSelect: a step usually names more than one role, and picking three
// should be one trip through the dialog rather than three.
test('the role help is a multi-select dialog over the served roles', () => {
  const fragment = read(APP, 'ext', 'fragment', 'RoleValueHelp.fragment.xml');
  assert.match(fragment, /<SelectDialog/u);
  assert.match(fragment, /multiSelect="true"/u);
  assert.match(fragment, /items="\{ path: 'opt>\/roles'/u);
  assert.match(controller, /ext\.fragment\.RoleValueHelp/u);
  // Searchable over the code as well as the label, like the field help.
  assert.match(controller, /onRoleSearch/u);
  assert.match(controller, /FilterOperator\.Contains/u);
});

/**
 * The roles come from the same list the field property profiles condition on, so the two cannot
 * drift - minus `*`, which is a wildcard for matching and not somebody who can approve a request.
 */
test('the roles are served, and the wildcard is not one of them', () => {
  assert.match(serviceCds, /roles {8}: array of Option;/u);
  assert.match(serviceJs, /roles: ROLES\.filter\(\(code\) => code !== '\*'\)/u);
  const { ROLES } = require('../srv/checks/field-properties');
  assert.ok(ROLES.includes('DataSteward'), 'DataSteward is one of them');
  assert.ok(ROLES.includes('*'), 'and the wildcard is in the source list, which is why it is filtered');
});

// Added to what the cell holds, never replacing it: a dialog that wiped the two addresses already
// typed in would be a trap.
test('choosing roles adds to the cell rather than replacing it', () => {
  const listCellSource = read(APP, 'ext', 'ListCell.js');
  assert.match(listCellSource, /controller\.addListValues = function \(cell, values\)/u);
  assert.match(listCellSource, /cell\.getTokens\(\)\.concat\(\(values \|\| \[\]\)/u);
  assert.match(controller, /this\.addListValues\(this\._roleCell, codes\)/u);
  // The codes are read off their binding contexts, for the reason onFieldChosen documents.
  assert.match(controller, /getProperty\("code"\)/u);
});

/**
 * A rule that seemed to clear itself, reported 2026-08-21. `hasPendingChanges` answers for one
 * update group, so a create that never travelled leaves it false and the toast claims a save that
 * did not happen - which from the outside is a rule vanishing. So the rows are asked directly.
 */
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
