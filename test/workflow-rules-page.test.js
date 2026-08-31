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
const validationController = read(APP, 'ext', 'controller', 'ValidationRuleList.controller.js');
const derivationController = read(APP, 'ext', 'controller', 'DerivationRuleList.controller.js');
const duplicateController = read(APP, 'ext', 'controller', 'DuplicateRuleList.controller.js');
const hub = read(APP, 'ext', 'view', 'MDMRuleHub.view.xml');
const hubController = read(APP, 'ext', 'controller', 'MDMRuleHub.controller.js');
const manifest = JSON.parse(read(APP, 'manifest.json'));

const serviceCds = read(ROOT, 'srv', 'duplicate-config-service.cds');
const serviceJs = read(ROOT, 'srv', 'duplicate-config-service.js');
const rulesCds = read(ROOT, 'db', 'workflow-rules.cds');
const changeRequestJs = read(ROOT, 'srv', 'change-request-service.js');

// The columns are the agreed shape of a rule, so they are pinned rather than left to a refactor.
// Down from nine to six (2026-08-28): the two fixed condition pairs and the titleless AND/OR/NOR
// column collapsed into one "Conditions" column (as many lines as the rule needs) plus "Logic".
test('the workflow table has the columns a rule needs, in order', () => {
  const columns = [...view.matchAll(/<Column[^>]*>\s*<Text text="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(columns, ['CR Type', 'Step', 'Conditions', 'Logic', 'Approvers', 'Active']);
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
 * searchable value help - several hundred fields is not a ComboBox. Each condition is its own
 * bound Field `Input` again (2026-08-28, reverted from a free-text TextArea): "naast elkaar zoals
 * het ervoor was" - the value help writes straight into that cell, replacing it, exactly as every
 * other condition cell in this app already works.
 */
test('a condition field is chosen through the shared value help', () => {
  const fieldCell = view.slice(view.indexOf('value="{dc>field}"'));
  assert.match(fieldCell.slice(0, fieldCell.indexOf('/>')), /valueHelpRequest="\.onFieldValueHelp"/u);
  assert.match(controller, /ext\.fragment\.FieldValueHelp/u);
  assert.match(controller, /FilterOperator\.Contains/u);
  // The stored value is the qualified code, and it is read off the binding context BEFORE anything
  // resets the list - the bug that used to write a General name field when "Country" was searched.
  const chosen = controller.slice(controller.indexOf('onFieldChosen:'));
  const body = chosen.slice(0, chosen.indexOf('\n    },'));
  assert.ok(body.indexOf('getProperty("code")') < body.indexOf('setProperty('));
  assert.equal(/filter\(\[\]\)/u.test(body), false);
  // A plain replace again - no "append a new line" mode left over from the TextArea design.
  assert.equal(/mode === "append"/u.test(body), false);
  const open = controller.slice(controller.indexOf('onFieldValueHelp:'));
  assert.match(open.slice(0, open.indexOf('.open("")')), /getBinding\("items"\)[\s\S]{0,80}filter\(\[\]\)/u);
});

/**
 * The Values cell is disabled once the operator is "is empty"/"is not empty" - those two need no
 * value at all, so offering one would invite a value that is simply never read. Logic stays always
 * enabled: the engine itself ignores it for zero or one condition (see joinConditions in
 * srv/checks/value-lists.js), so there is nothing unsafe about it being set ahead of a second
 * condition being added.
 */
test('the values cell is disabled for empty/notEmpty; the logic combo is always enabled', () => {
  const valuesCell = view.slice(view.indexOf('value="{dc>values}"'));
  assert.match(
    valuesCell.slice(0, valuesCell.indexOf('/>')),
    /enabled="\{= \$\{dc>operator\} !== 'empty' &amp;&amp; \$\{dc>operator\} !== 'notEmpty' \}"/u
  );
  const logic = view.slice(view.indexOf("selectedKey=\"{dc>conditionLogic}\""));
  assert.equal(/enabled=/u.test(logic.slice(0, logic.indexOf('</ComboBox>'))), false);
});

/**
 * One value per cell, like every other rule table. Multiple selection was built here first and
 * withdrawn on 2026-08-21 after three failed attempts to make a token cell save reliably - see
 * "Multiple values per condition" in CLAUDE.md for what it would take. Pinned so it does not creep
 * back in by accident: a plain bound Input is the whole mechanism, and it is the one that works.
 */
test('every cell is a single bound value, and nothing tokenises', () => {
  // Each condition is field/operator/values as three plain bound cells - side by side, as many
  // condition-groups as the rule has, but never several VALUES packed into one cell via a token
  // control. The `values` cell itself still takes the `|`-delimited encoding every other condition
  // column in this app already uses (see conditionHolds), same as before.
  assert.match(view, /value="\{dc>field\}"/u, 'field is a bound Input');
  assert.match(view, /selectedKey="\{dc>operator\}"/u, 'operator is a bound Select');
  assert.match(view, /value="\{dc>values\}"/u, 'values is a bound Input');
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
  // Each condition ALSO validates on its own write, since it is its own entity now - the same
  // guard() helper, its own validator, its own store invalidation.
  assert.match(serviceJs, /guard\(\s*'WorkflowRuleConditions', WORKFLOW_RULE_CONDITIONS/u);
  assert.match(serviceJs, /validateCondition\(data, undefined, 'This condition'\)/u);
  // Its own store, or a write would drop the quality cache and leave the approvers stale.
  assert.match(serviceJs, /workflowRuleStore\.markStale/u);
});

// Rows not columns, like every other table here: adding a step or an approver must be an INSERT,
// because cds-deploy refuses to drop an element. One value per column, so an extra approver is an
// extra row - which is what the Add button is for and what resolveApprovers merges.
test('the table is rows, and every column holds one value', () => {
  assert.match(rulesCds, /entity WorkflowRules : managed/u);
  for (const column of [
    'requestType', 'step', 'conditions', 'conditionField', 'conditionValues', 'conditionField2',
    'conditionValues2', 'approvers', 'isActive'
  ]) {
    // The plural names are stuck: `cds-deploy` cannot rename an element any more than it can drop
    // one, so these hold ONE value under a name that reads like several.
    assert.match(rulesCds, new RegExp(`\\b${column}\\b`, 'u'), `${column} is modelled`);
  }
  // No order column: rows are additive, so every matching row contributes and nothing is ranked.
  // Neither WorkflowRules nor its own WorkflowRuleConditions declares one - a bare mention of the
  // WORD "sequence" is fine (it shows up explaining the absence), an actual column is not.
  assert.equal(/\bsequence\s*:/u.test(rulesCds), false, 'no table declares a sequence column');
  assert.equal(/\bsequence\b/u.test(read(ROOT, 'srv', 'checks', 'workflow-rules.js')), false);
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

// --- Dynamic conditions, side by side (2026-08-28, asked for) -----------------------------------

/**
 * The view side of the composition: a wrapping FlexBox templated over `dc>conditions`, so a rule
 * with three conditions renders three Field/Operator/Value groups side by side (wrapping onto a
 * second line rather than growing the row forever sideways), and a rule with one renders one -
 * genuinely per-row, not a fixed number of always-visible slots.
 */
test('conditions render as a wrapping FlexBox of Field/Operator/Value groups, one per condition row', () => {
  assert.match(
    view,
    /<FlexBox wrap="Wrap" items="\{ path: 'dc>conditions', templateShareable: false \}"/u
  );
  const conditionsCell = view.slice(view.indexOf('<FlexBox wrap="Wrap"'));
  const body = conditionsCell.slice(0, conditionsCell.indexOf('</FlexBox>'));
  assert.match(body, /value="\{dc>field\}"/u);
  assert.match(body, /items="\{ path: 'opt>\/comparisons', templateShareable: false \}"/u);
  assert.match(body, /value="\{dc>values\}"/u);
  assert.match(body, /press="\.onRemoveCondition"/u);
  assert.match(view, /text="Add Condition"[\s\S]{0,150}press="\.onAddCondition"/u);
});

/**
 * "Add Condition" grows THIS rule's own composition - a fresh list binding on its `conditions`
 * navigation, the same mechanism Duplicate and the Excel import share (`_conditionsBinding`) -
 * never a shared, page-wide column. "Remove" reads its OWN binding context (the CONDITION, not the
 * rule, since the button lives inside the per-condition template) and deletes just that one row.
 */
test('Add Condition and Remove act on one row\'s own conditions, not a shared column', () => {
  const add = controller.slice(controller.indexOf('onAddCondition: function'));
  const addBody = add.slice(0, add.indexOf('\n    },'));
  assert.match(addBody, /event\.getSource\(\)\.getBindingContext\("dc"\)/u);
  assert.match(addBody, /this\._conditionsBinding\(ruleContext\)\.create\(\{ operator: "eq", values: "" \}\)/u);

  const remove = controller.slice(controller.indexOf('onRemoveCondition: function'));
  const removeBody = remove.slice(0, remove.indexOf('\n    },'));
  assert.match(removeBody, /event\.getSource\(\)\.getBindingContext\("dc"\)/u);
  assert.match(removeBody, /context\.delete\(UPDATE_GROUP\)/u);

  assert.match(controller, /_conditionsBinding: function \(ruleContext\)/u);
  assert.match(controller, /bindList\(\s*"conditions", ruleContext/u);
});

// --- Operators (2026-08-28, asked for: "= of !=, en dan andere") --------------------------------

/**
 * The exact vocabulary rule-engine.js already offers ValidationRules/DerivationRules for their own
 * comparison column - asked for directly ("volgens mij alle mogelijke operatoren") rather than a
 * smaller, WorkflowRules-only set, and served the same way qualityRuleOptions already does.
 */
test('the operator picker offers the same comparisons ValidationRules/DerivationRules already use', () => {
  const handler = serviceJs.slice(serviceJs.indexOf("this.on('workflowRuleOptions'"));
  const body = handler.slice(0, handler.indexOf('\n    });'));
  assert.match(body, /comparisons: Object\.entries\(COMPARISONS\)\.map/u);
  assert.match(serviceCds, /comparisons {2}: array of ComparisonOption;/u);

  const workflowRulesJs = read(ROOT, 'srv', 'checks', 'workflow-rules.js');
  assert.match(workflowRulesJs, /require\('\.\/rule-engine'\)/u);
  assert.match(workflowRulesJs, /COMPARISONS\[condition\.operator\]/u);
  // The composition carries the operator, not the two now-legacy scalar columns.
  assert.match(rulesCds, /operator : String\(10\) default 'eq';/u);
});

// --- Duplicate (2026-08-28, asked for: "copy en paste" for a rule) ------------------------------

/**
 * "Copy and paste" for a rule: the same `binding.create` mechanism Add Rule already uses, just
 * pre-filled from the selected row instead of blank - conditions included, each created as its OWN
 * new WorkflowRuleConditions row against the fresh rule context (see _conditionsBinding), rather
 * than relying on the OData v4 model's create() to support a deep-insert payload. Identity and
 * managed columns are stripped so the copy becomes its OWN row rather than colliding with the
 * original's key - shared with the Excel import via STRIP_ON_COPY.
 */
test('Duplicate copies the selected row, its conditions, and strips their identity', () => {
  const button = view.slice(view.indexOf('text="Duplicate"'));
  assert.match(button.slice(0, button.indexOf('/>')), /press="\.onDuplicateRule"/u);

  const stripDeclaration = controller.slice(0, controller.indexOf('return Controller.extend'));
  assert.match(stripDeclaration, /var STRIP_ON_COPY = \[/u);
  for (const stripped of ['ID', '@odata.etag', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy']) {
    assert.match(stripDeclaration, new RegExp(`["']${stripped.replace(/[.]/u, '\\.')}["']`, 'u'), `${stripped} is stripped`);
  }

  const fn = controller.slice(controller.indexOf('onDuplicateRule: function'));
  const body = fn.slice(0, fn.indexOf('\n    },\n\n    /** A fresh list binding'));
  assert.match(body, /getSelectedItem\(\)/u);
  assert.match(body, /Object\.assign\(\{\}, context\.getObject\(\)\)/u);
  assert.match(body, /var newContext = binding\.create\(copy\)/u);
  // Each of the original rule's conditions becomes its own new row of the fresh rule's own
  // composition - not a deep-insert payload sent alongside the rule itself.
  assert.match(body, /this\._conditionsBinding\(newContext\)\.create\(conditionCopy\)/u);
  assert.match(body, /MessageToast\.show\("Select the rule to duplicate\."\)/u);
});

// --- Excel (CSV) import / export (2026-08-28, asked for) ------------------------------------------

/**
 * Real .xlsx would need a third-party reader/writer this repo has never taken a dependency on -
 * CSV needs none, and Excel opens/saves it natively. The button labels say "Excel" (what a steward
 * asked for and thinks in); the mechanism is a hand-rolled RFC-4180-shaped CSV codec.
 */
test('Export/Import buttons exist and drive a CSV round trip, not a new library', () => {
  assert.match(view, /text="Export to Excel"[\s\S]{0,80}press="\.onExportExcel"/u);
  assert.match(view, /text="Import from Excel"[\s\S]{0,80}press="\.onImportExcel"/u);
  // Not "no mention of .xlsx in a comment" - this file's own comments say why real .xlsx was
  // rejected - but no actual dependency on one: nothing requires/defines a spreadsheet library.
  assert.equal(/require\(["'](xlsx|exceljs)|sap\/ui\/export\/Spreadsheet/iu.test(controller), false);
  assert.match(controller, /function toCsv\(/u);
  assert.match(controller, /function fromCsv\(/u);
  assert.match(controller, /new Blob\(/u);
  assert.match(controller, /type: "text\/csv/u);
});

/**
 * The columns of the round trip are the rule's own fields plus one Field/Operator/Value column per
 * condition slot - "de structuur die ook zichtbaar is in de app" (asked for), not a DSL packed into
 * one cell. `MAX_EXCEL_CONDITIONS` is the one thing a spreadsheet needs that the page itself does
 * not: a fixed column count, generous rather than tied to what is in use today.
 */
test('the CSV columns match what a WorkflowRules row actually holds, one triple per condition slot', () => {
  const fn = controller.slice(controller.indexOf('function csvColumns'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  for (const key of ['ID', 'requestType', 'step', 'conditionLogic', 'approvers', 'isActive']) {
    assert.match(body, new RegExp(`key: "${key}"`, 'u'), `${key} is one of the exported columns`);
  }
  assert.match(body, /"field" \+ i/u);
  assert.match(body, /"operator" \+ i/u);
  assert.match(body, /"values" \+ i/u);
  assert.match(controller, /var MAX_EXCEL_CONDITIONS = \d+;/u);
});

/** flattenForExport spreads one rule's conditions array across the fixed slot columns. */
test('flattenForExport maps a rule\'s conditions onto Condition 1/2/... columns', () => {
  const fn = controller.slice(controller.indexOf('function flattenForExport'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /condition\.field \|\| ""/u);
  assert.match(body, /condition\.operator \|\| ""/u);
  assert.match(body, /condition\.values \|\| ""/u);
  assert.match(body, /delete flat\.conditions/u);
});

/**
 * Extracted and evaluated directly (the one exception to this file's own source-pinning style,
 * because a hand-rolled CSV codec is exactly the kind of thing that looks right and is not - a
 * quoted comma, an embedded quote, or a literal newline inside the Conditions cell each broke a
 * naive version of this before it shipped).
 */
function extractCsvFunctions(source) {
  const names = ['csvEscape', 'toCsv', 'fromCsv'];
  const body = names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
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
  }).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { csvEscape, toCsv, fromCsv };`)();
}

const { toCsv, fromCsv } = extractCsvFunctions(controller);

test('toCsv/fromCsv round-trip a value containing a comma, a quote and a newline', () => {
  const rows = [{
    ID: '1', requestType: 'create', step: 'Approve',
    conditions: 'Addresses.Country = BE|NL\nGeneral.BusinessPartnerCategory = 2',
    conditionLogic: 'AND', approvers: 'Acme, "big" corp <maarten@alluvion.eu>', isActive: true
  }];
  const columns = [
    { key: 'ID', label: 'ID' }, { key: 'requestType', label: 'CR Type' },
    { key: 'step', label: 'Step' }, { key: 'conditions', label: 'Conditions' },
    { key: 'conditionLogic', label: 'Logic' }, { key: 'approvers', label: 'Approvers' },
    { key: 'isActive', label: 'Active' }
  ];
  const csv = toCsv(rows, columns);
  const table = fromCsv(csv);
  assert.equal(table.length, 2, 'a header row and one data row');
  const [, dataRow] = table;
  assert.equal(dataRow[3], rows[0].conditions, 'the embedded newline stayed inside one cell');
  assert.equal(dataRow[5], rows[0].approvers, 'the comma and the quote round-tripped exactly');
});

test('fromCsv drops a wholly blank trailing line', () => {
  const table = fromCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(table, [['a', 'b'], ['1', '2']]);
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
  // Captured BEFORE the submit (2026-08-31) so the rows actually being created can be waited on
  // individually afterwards - see the next test for why.
  const captureAt = body.indexOf('_transientRows()');
  const submitAt = body.indexOf('submitBatch(UPDATE_GROUP)');
  assert.ok(captureAt > -1 && captureAt < submitAt, 'the transient rows are captured before the submit');
  // The FINAL check - after the wait below - still runs after the submit and before anything says
  // "saved".
  const checkAt = body.lastIndexOf('_transientRows()');
  assert.ok(submitAt < checkAt, 'the verifying check still happens after the submit');
  assert.ok(checkAt < body.indexOf('MessageToast.show'));
  assert.match(body, /were not saved/u);
});

/**
 * submitBatch's own promise can resolve before a freshly created context has actually flipped out
 * of "transient" - a known SAPUI5 v4-model race, and the reason the FIRST save after Add Rule used
 * to report "not saved" for a row the batch had, in fact, just created (reported live 2026-08-31:
 * pressing Save again - nothing transient by then - made the second press look like the one that
 * worked). context.created() is the promise that genuinely completes a create, so waiting on it for
 * every row captured as transient before the submit closes the race. Applied identically to all
 * four rule pages, since all four copy this exact save idiom.
 */
test('every rule page waits on context.created() before trusting a create actually landed', () => {
  for (const [name, source] of [
    ['WorkflowRuleList', controller],
    ['ValidationRuleList', validationController],
    ['DerivationRuleList', derivationController],
    ['DuplicateRuleList', duplicateController]
  ]) {
    const save = source.slice(source.indexOf('onSave: async function'));
    const body = save.slice(0, save.indexOf('onDiscard:') > -1 ? save.indexOf('onDiscard:') : save.indexOf('\n    },\n'));
    assert.match(body, /var creating = this\._transientRows\(\);/u, `${name} captures the transient rows first`);
    assert.match(
      body,
      /await Promise\.all\(creating\.map\(function \(context\) \{\s*return context\.created\(\)\.catch\(function \(\) \{\}\);\s*\}\)\);/u,
      `${name} awaits context.created() for each`
    );
    const waitAt = body.indexOf('Promise.all(creating.map');
    const pendingAt = body.indexOf('hasPendingChanges(UPDATE_GROUP)');
    assert.ok(pendingAt > -1 && pendingAt < waitAt, `${name} checks for a rejected row before waiting on the rest`);
  }
});
