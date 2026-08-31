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
 * searchable value help - several hundred fields is not a ComboBox. Since the Conditions column
 * became a free-text TextArea (2026-08-28), there is no bound Input for the value help to write
 * into directly any more - "Insert Field" is a plain Button (`press`, not `valueHelpRequest`) that
 * APPENDS the chosen field as a new line instead of replacing the cell's whole value.
 */
test('a condition field is chosen through the shared value help', () => {
  const insertButton = view.slice(view.indexOf('text="Insert Field"'));
  assert.match(insertButton.slice(0, insertButton.indexOf('/>')), /press="\.onFieldValueHelp"/u);
  assert.match(controller, /ext\.fragment\.FieldValueHelp/u);
  assert.match(controller, /FilterOperator\.Contains/u);
  // The stored value is the qualified code, and it is read off the binding context BEFORE anything
  // resets the list - the bug that used to write a General name field when "Country" was searched.
  const chosen = controller.slice(controller.indexOf('onFieldChosen:'));
  const body = chosen.slice(0, chosen.indexOf('\n    },'));
  assert.ok(body.indexOf('getProperty("code")') < body.indexOf('setProperty('));
  assert.equal(/filter\(\[\]\)/u.test(body), false);
  // Appended as a new line, never overwriting what is already typed - the whole point of this
  // column is to hold more than one condition.
  assert.match(body, /mode === "append"/u);
  assert.match(body, /prefix \+ code \+ " = "/u);
  const open = controller.slice(controller.indexOf('onFieldValueHelp:'));
  assert.match(open.slice(0, open.indexOf('.open("")')), /getBinding\("items"\)[\s\S]{0,80}filter\(\[\]\)/u);
});

/**
 * Neither cell is ever disabled any more (2026-08-28): the Conditions TextArea has no "field chosen
 * first" gate to begin with (there is no separate field/value split left to gate between), and Logic
 * is always enabled because the engine itself ignores it for zero or one condition - see
 * joinConditions in srv/checks/value-lists.js. Nothing left to disable is not the same as nothing
 * left to validate: half a condition (a field with no value after "=", or the reverse) is still
 * refused, just by validateWorkflowRule/onSave rather than by a disabled cell.
 */
test('the conditions cell and the logic combo are always editable', () => {
  assert.equal(/enabled="\{= !!\$\{dc>conditionField/u.test(view), false);
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
  // Conditions is a TextArea rather than an Input, but it is still exactly one bound property - the
  // multi-value part is expressed as lines of TEXT inside that one column, never as several cells
  // or a token control.
  assert.match(view, /<TextArea[\s\S]{0,200}value="\{dc>conditions\}"/u, 'conditions is a bound TextArea');
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
  assert.match(controller, /needs a value after "="/u);
  assert.match(serviceJs, /guard\('WorkflowRules', WORKFLOW_RULES, validateWorkflowRule/u);
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

// --- Duplicate (2026-08-28, asked for: "copy en paste" for a rule) ------------------------------

/**
 * "Copy and paste" for a rule: the same `binding.create` mechanism Add Rule already uses, just
 * pre-filled from the selected row instead of blank. Identity and managed columns are stripped so
 * the copy becomes its OWN row rather than colliding with the original's key.
 */
test('Duplicate copies the selected row, stripping its identity', () => {
  const button = view.slice(view.indexOf('text="Duplicate"'));
  assert.match(button.slice(0, button.indexOf('/>')), /press="\.onDuplicateRule"/u);

  const fn = controller.slice(controller.indexOf('onDuplicateRule: function'));
  const body = fn.slice(0, fn.indexOf('\n    },'));
  assert.match(body, /getSelectedItem\(\)/u);
  assert.match(body, /Object\.assign\(\{\}, context\.getObject\(\)\)/u);
  for (const stripped of ['ID', '@odata.etag', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy']) {
    assert.match(body, new RegExp(`["']${stripped.replace(/[.]/u, '\\.')}["']`, 'u'), `${stripped} is stripped`);
  }
  assert.match(body, /binding\.create\(copy\)/u);
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

/** The columns of the round trip are exactly the fields a rule needs - see db/workflow-rules.cds. */
test('the CSV columns match what a WorkflowRules row actually holds', () => {
  const csvColumns = controller.slice(
    controller.indexOf('var CSV_COLUMNS'), controller.indexOf('];') + 2
  );
  for (const key of ['ID', 'requestType', 'step', 'conditions', 'conditionLogic', 'approvers', 'isActive']) {
    assert.match(csvColumns, new RegExp(`key: "${key}"`, 'u'), `${key} is one of the exported columns`);
  }
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
  // Checked after the submit and before anything says "saved".
  assert.ok(body.indexOf('submitBatch(UPDATE_GROUP)') < body.indexOf('_transientRows()'));
  assert.ok(body.indexOf('_transientRows()') < body.indexOf('MessageToast.show'));
  assert.match(body, /were not saved/u);
});
