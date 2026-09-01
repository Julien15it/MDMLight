'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'app', 'mdmrules', 'webapp');
const BP_APP = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'manifest.json'), 'utf8'));
const bpManifest = JSON.parse(fs.readFileSync(path.join(BP_APP, 'manifest.json'), 'utf8'));
const view = fs.readFileSync(path.join(APP, 'ext', 'view', 'DuplicateRuleList.view.xml'), 'utf8');
const controllerSource = fs.readFileSync(
  path.join(APP, 'ext', 'controller', 'DuplicateRuleList.controller.js'),
  'utf8'
);

const routing = manifest['sap.ui5'].routing;
const route = routing.routes.find((entry) => entry.name === 'DuplicateRuleList');

// `xlsxCodec` fills the sixth factory parameter (`XlsxCodec`, added 2026-08-31 alongside Duplicate/
// Export/Import) - defaulted to `{}` since most callers here never touch it. `messageBox`/
// `messageToast` default to harmless no-op stubs, since `_applyImportedXlsx` always ends by calling
// one or the other.
function loadController(xlsxCodec, messageBox, messageToast) {
  let definition;
  const base = { extend: (name, members) => ({ name, members }) };
  vm.runInNewContext(controllerSource, {
    sap: { ui: { define: (unused, factory) => {
      definition = factory(
        base, {}, function () {},
        messageBox || { error: () => {} },
        messageToast || { show: () => {} },
        xlsxCodec || {}
      );
    } } }
  });
  return definition.members;
}

// The same tolerant boolean parser XlsxCodec.isTruthyCell uses (see test/xlsx-codec.test.js) -
// stubbed here rather than loaded, since these tests exercise `_applyImportedXlsx`'s own
// wholesale-replace logic, not the codec.
const STUB_XLSX_CODEC = {
  isTruthyCell: (value) => (typeof value === 'boolean' ? value : /^(true|1|yes|x)$/iu.test(String(value === undefined ? '' : value).trim()))
};

function mockContext(object) {
  return {
    getObject: () => object,
    setProperty(key, value) { object[key] = value; },
    deleted: false,
    delete(group) { this.deleted = true; this.deleteGroup = group; }
  };
}

test('the rules page is reachable through its own route and model', () => {
  assert.ok(route, 'the route is registered');
  assert.equal(route.pattern, 'DuplicateRules');
  assert.equal(routing.targets.DuplicateRuleList.name,
    'mdm.md.mdmrules.manage.ext.view.DuplicateRuleList');
  assert.equal(manifest['sap.app'].dataSources.duplicateConfigService.uri, 'service/duplicateconfig/');
  assert.equal(manifest['sap.ui5'].models.dc.dataSource, 'duplicateConfigService');
});

// Without a route entry the approuter catch-all sends the calls to the HTML5 repo, where they 404.
test('the service the page calls is routed through the approuter', () => {
  const routes = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'app', 'mdmrules', 'xs-app.json'), 'utf8')
  ).routes;
  const configRoute = routes.find((entry) => entry.source.includes('duplicateconfig'));
  assert.ok(configRoute, 'the duplicate config service has its own route');
  assert.equal(configRoute.authenticationType, 'xsuaa');
  assert.ok(routes.indexOf(configRoute) < routes.findIndex((entry) => entry.source === '^(.*)$'));
});

test('the steward scope exists and is not folded into partner maintenance', () => {
  const security = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xs-security.json'), 'utf8'));
  assert.ok(security.scopes.some((scope) => scope.name === '$XSAPPNAME.Steward'));
  const steward = security['role-templates'].find((role) => role.name === 'DataSteward');
  assert.ok(steward, 'a role template grants the scope, or nobody can be given it');
  assert.ok(steward['scope-references'].includes('$XSAPPNAME.Steward'));
  assert.equal(steward['scope-references'].includes('$XSAPPNAME.Maintain'), false);
  const manager = security['role-templates'].find((role) => role.name === 'BusinessPartnerManager');
  assert.equal(manager['scope-references'].includes('$XSAPPNAME.Steward'), false);
});

// Moved to the MDM Configuration Panel tile (2026-08-17): rule configuration is not a partner-list action.
test('the partner list no longer carries a rules button', () => {
  const actions = bpManifest['sap.ui5'].routing.targets.BusinessPartnersList.options.settings
    .controlConfiguration['@com.sap.vocabularies.UI.v1.LineItem'].actions;
  assert.equal(Object.hasOwn(actions, 'DuplicateRules'), false);
  const source = fs.readFileSync(path.join(BP_APP, 'ext', 'CustomActions.js'), 'utf8');
  assert.equal(/openDuplicateRules/u.test(source), false, 'and the handler goes with it');
});

// Leaving the rules page has to land on the hub it was opened from, not on the partner list.
test('the rules page returns to the hub, saved or not', () => {
  assert.equal(/navTo\("BusinessPartnersList"/u.test(controllerSource), false);
  const matches = controllerSource.match(/navTo\("MDMRuleHub", \{\}, true\)/gu) || [];
  assert.equal(matches.length, 2, 'both the clean exit and the discard-changes one');
});

// The whole reason ruleOptions() exists: a copy kept in the view goes stale the moment the
// code-defined catalog grows a field.
test('the field, comparison and indicator lists come from the service', () => {
  assert.match(view, /items="\{ path: 'opt>\/fields'/u);
  assert.match(view, /items="\{ path: 'opt>\/comparisons'/u);
  assert.match(view, /items="\{ path: 'opt>\/indicators'/u);
  assert.match(view, /items="\{ path: 'opt>\/conditionLogics'/u);
  assert.match(controllerSource, /_callAction\("ruleOptions"/u);
  // Bare-string arrays do not bind inside a table cell; every list is code/text for that reason.
  assert.equal(/<core:Item key="\{opt>\}"/u.test(view), false);
  // Twelve since 2026-09-01, when the table went to five condition slots: five condition-field
  // pickers, the four AND/OR/NOR cells between them, and the rule's own Field, Comparison and
  // Indicator. (Six before that: two conditions, one logic, and the same three.)
  assert.equal((view.match(/<core:Item key="\{opt>code\}" text="\{opt>text\}"/gu) || []).length, 12);
  // `key` is a CDS keyword and prefixes a key element, so the property cannot be called that.
  const serviceCds = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'duplicate-config-service.cds'), 'utf8'
  );
  assert.equal(/^\s*key\s*:/mu.test(serviceCds), false, 'key : Type does not compile');
});

// The dropdowns were empty because ruleOptions() ran in onInit, before component models reach a
// routed view. The table filled anyway — a declarative binding resolves late, a one-shot call does
// not — which is exactly why the page looked half-working rather than broken.
test('the options call falls back to the component model', () => {
  assert.match(controllerSource, /getOwnerComponent\(\)/u);
  assert.match(controllerSource, /getModel\("dc"\) \|\|/u);
  assert.match(controllerSource, /if \(!model\) throw new Error/u, 'no model must not read as undefined');
});

test('the grid asks only for what a steward has to decide', () => {
  for (const gone of ['dc>sequence', 'dc>threshold', 'dc>condCountry', 'dc>condCategory',
    'dc>condGrouping', 'dc>condRole']) {
    assert.equal(view.includes(gone), false, `${gone} is still on the grid`);
  }
  assert.match(view, /\{dc>conditionField\}/u);
  assert.match(view, /\{dc>conditionValue\}/u);
  // Two independent conditions, so a steward can write "Role = Vendor and Country = BE".
  assert.match(view, /\{dc>conditionField2\}/u);
  assert.match(view, /\{dc>conditionValue2\}/u);
});

// Columns sized to the row, not to their content, and no standing explanation above the table.
test('the grid fills the page and carries no permanent info strip', () => {
  assert.equal(view.includes('type="Information"'), false, 'the info strip is gone');
  assert.equal(view.includes('Rows are additive'), false);
  // Rem, not percentages, since 2026-09-01: a hidden condition column contributes no share of
  // 100%, so percentages re-flowed the whole row every time a condition was revealed - and a
  // fixed-layout table needs a real width to overflow with rather than redistributing into
  // whatever space it has. See the scrolling test below for the arithmetic.
  for (const width of ['14rem', '9rem', '6rem', '18rem', '15rem', '4rem']) {
    assert.ok(view.includes(`width="${width}"`), `no column at ${width}`);
  }
  // Scoped to the COLUMNS: the cell controls inside them are still `width="100%"`, which is what
  // fills the column rather than sizing it.
  assert.equal(/<Column\b[^>]*width="\d+%"/u.test(view), false, 'no percentage column widths are left');
  // A ComboBox left at its default width is what put the gaps between the cells. Twelve of them
  // now - see the core:Item count above for what they are.
  assert.equal((view.match(/<ComboBox\s+width="100%"/gu) || []).length, 12);
});

// The permission model is unchanged by the move to a tile: a tile cannot be hidden from the app,
// so the hub says so and the service still refuses the write.
test('a non-steward is told the rules are not theirs to save', () => {
  const hub = fs.readFileSync(path.join(APP, 'ext', 'view', 'MDMRuleHub.view.xml'), 'utf8');
  assert.match(hub, /!\$\{perm>\/isDataSteward\}/u);
  assert.match(hub, /limited to data stewards/u);
  const component = fs.readFileSync(path.join(APP, 'Component.js'), 'utf8');
  assert.match(component, /isDataSteward: false/u, 'it starts hidden, never briefly visible');
  assert.match(component, /currentUserPermissions/u);
});

test('the page warns about a field the index cannot serve, and about running on defaults', () => {
  assert.match(view, /Not held in the duplicate index/u);
  assert.match(view, /\$\{view>\/source\} === 'defaults'/u);
  assert.match(view, /never switched off by an empty table/u);
});

// A warning nothing can ever set is worse than no warning: it reads as an all-clear.
test('every state the view binds is actually populated by the controller', () => {
  const bound = [...view.matchAll(/view>\/(\w+)/gu)].map((match) => match[1]);
  assert.ok(bound.includes('source'), 'the defaults banner binds it');
  for (const property of new Set(bound)) {
    assert.match(
      controllerSource,
      new RegExp(`(setProperty\\("/${property}"|${property}:)`, 'u'),
      `view>/${property} is bound but never set`
    );
  }
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'duplicate-config-service.js'), 'utf8'
  );
  assert.match(service, /source: ruleStore\.source\(\)/u, 'ruleOptions has to report it');
});

test('edits are batched behind an explicit save rather than written per keystroke', () => {
  assert.match(view, /\$\$updateGroupId: 'ruleChanges'/u);
  assert.match(controllerSource, /submitBatch\(UPDATE_GROUP\)/u);
  assert.match(controllerSource, /resetChanges\(UPDATE_GROUP\)/u);
});

test('the client refuses a fuzzy rule with no usable threshold before the round trip', () => {
  const { _localProblems } = loadController();
  // Lengths, not deepEqual: the controller runs in its own vm realm, so its arrays fail a
  // prototype-strict comparison against arrays built out here.
  assert.equal(_localProblems([
    { field: 'Name', comparison: 'exact', indicator: 'definitive' }
  ]).length, 0);
  assert.equal(_localProblems([
    { field: 'Name', comparison: 'fuzzy', indicator: 'strong' }
  ]).length, 0, 'no threshold means the default, not an error');
  assert.equal(_localProblems([
    { field: 'Name', comparison: 'fuzzy', threshold: 1.5, indicator: 'strong' }
  ]).length, 1);
  assert.equal(_localProblems([
    { field: 'Name', comparison: 'exact', indicator: 'strong', conditionField: 'Country' }
  ]).length, 1, 'a condition field with no value would match everything');
  assert.equal(_localProblems([
    { field: 'Name', comparison: 'exact', indicator: 'strong', conditionField2: 'Country' }
  ]).length, 1, 'the second condition is checked the same way as the first');
  assert.equal(_localProblems([
    {
      field: 'Name', comparison: 'exact', indicator: 'strong',
      conditionField: 'Role', conditionValue: 'FLVN01',
      conditionField2: 'Country', conditionValue2: 'BE'
    }
  ]).length, 0, 'both conditions filled is the case this exists for');
  assert.equal(_localProblems([
    { field: '', comparison: '', indicator: '' }
  ]).length, 3);
});

// --- Duplicate, and Excel import/export - a real .xlsx (2026-08-31, asked for on all four rule
// pages, built for WorkflowRuleList first) --------------------------------------------------------

test('Duplicate, Export to Excel and Import from Excel are all wired up', () => {
  assert.match(view, /text="Duplicate"[\s\S]{0,80}press="\.onDuplicateRule"/u);
  assert.match(view, /text="Export to Excel"[\s\S]{0,80}press="\.onExportExcel"/u);
  assert.match(view, /text="Import from Excel"[\s\S]{0,80}press="\.onImportExcel"/u);
  assert.match(controllerSource, /mdm\/md\/mdmrules\/manage\/ext\/util\/XlsxCodec/u);
  assert.match(controllerSource, /XlsxCodec\.buildWorkbook\(\s*"DuplicateRules"/u);
  assert.match(controllerSource, /XlsxCodec\.readWorkbook\(/u);
  // No copy of the codec itself, and no third-party spreadsheet library.
  assert.equal(/function zipStore\(/u.test(controllerSource), false);
  assert.equal(/require\(["'](xlsx|exceljs|jszip|pako)["']/iu.test(controllerSource), false);
});

/**
 * The columns mirror the page itself exactly - `sequence` and `threshold` exist on the entity but
 * are not columns here (see `onAddRule`'s own comment: neither is worth a column a steward has to
 * think about), so neither is exported either. No `ID` column either (dropped 2026-08-31 along with
 * ID-matching on import - see the wholesale-replace test below).
 */
test('xlsxColumns matches exactly what a DuplicateRules row holds on screen, minus the generated ID', () => {
  const start = controllerSource.indexOf('function xlsxColumns');
  const braceStart = controllerSource.indexOf('{', start);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < controllerSource.length; i += 1) {
    if (controllerSource[i] === '{') depth += 1;
    if (controllerSource[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  const body = controllerSource.slice(start, end);
  const keys = [...body.matchAll(/key: "([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(keys, [
    'conditionField', 'conditionValue', 'conditionLogic', 'conditionField2', 'conditionValue2',
    'conditionLogic2', 'conditionField3', 'conditionValue3',
    'conditionLogic3', 'conditionField4', 'conditionValue4',
    'conditionLogic4', 'conditionField5', 'conditionValue5',
    'field', 'comparison', 'indicator', 'isActive'
  ]);
  assert.equal(keys.includes('ID'), false);
  assert.equal(keys.includes('sequence'), false);
  assert.equal(keys.includes('threshold'), false);
});

function extractXlsxColumnsFn() {
  const start = controllerSource.indexOf('function xlsxColumns');
  const braceStart = controllerSource.indexOf('{', start);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < controllerSource.length; i += 1) {
    if (controllerSource[i] === '{') depth += 1;
    if (controllerSource[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${controllerSource.slice(start, end)}\nreturn xlsxColumns;`)();
}

/**
 * Import now REPLACES the table wholesale, the same change WorkflowRuleList got the same day
 * (2026-08-31, on direct feedback: matching by ID was dropped in favour of just overriding with
 * whatever the file holds). Executed through `loadController()` (the real vm-loaded controller, so
 * `xlsxColumns`/`XlsxCodec`/`UPDATE_GROUP` are all wired exactly as the page itself wires them)
 * rather than hand-extracted, since this controller has no separate helper-extraction harness of
 * its own.
 */
test('import deletes every existing row and creates one for every row in the file', () => {
  const toasts = [];
  const members = loadController(STUB_XLSX_CODEC, undefined, { show: (text) => toasts.push(text) });
  const xlsxColumns = extractXlsxColumnsFn();

  // Two rows already on the page - neither should survive untouched, even one whose data happens
  // to match a row in the file.
  const first = mockContext({ field: 'Name', comparison: 'exact', indicator: 'strong' });
  const second = mockContext({ field: 'TaxNumber', comparison: 'exact', indicator: 'strong' });
  const created = [];
  const binding = { getCurrentContexts: () => [first, second], create: (record) => created.push(record) };
  const fakeThis = { _table: () => ({ getBinding: () => binding }), _markDirty: () => {}, _syncConditionColumns: () => {} };

  // The file names only one row - data-identical to "first". Built BY KEY rather than by position:
  // the row went from 9 cells to 18 when the extra condition slots landed (2026-09-01), and a
  // positional fixture silently stopped filling Field/Comparison at all, so nothing was created.
  const columns = xlsxColumns();
  const values = { field: 'Name', comparison: 'exact', indicator: 'strong', isActive: 'true' };
  const table = [
    columns.map((column) => column.label),
    columns.map((column) => values[column.key] || (column.key === 'conditionLogic' ? 'AND' : ''))
  ];
  members._applyImportedXlsx.call(fakeThis, table);

  assert.equal(first.deleted, true, 'deleted even though a data-identical row exists in the file');
  assert.equal(first.deleteGroup, 'ruleChanges');
  assert.equal(second.deleted, true);
  assert.equal(created.length, 1, 'one new row for the one non-blank row in the file');
  assert.match(toasts[0], /2 existing rule\(s\) replaced by 1 from the file/u);
});

// --- Five condition slots, Add/Delete Condition and the scrollbar (2026-09-01) -------------------
//
// The same rollout Workflow Agent Determination got, asked for on this page too.

test('the duplicate table carries five condition slots, three of them hidden until asked for', () => {
  for (const suffix of ['3', '4', '5']) {
    assert.match(view, new RegExp(`selectedKey="\\{dc>conditionField${suffix}\\}"`, 'u'));
    assert.match(view, new RegExp(`value="\\{dc>conditionValue${suffix}\\}"`, 'u'));
  }
  for (const suffix of ['', '2', '3', '4']) {
    assert.match(view, new RegExp(`selectedKey="\\{dc>conditionLogic${suffix}\\}"`, 'u'));
  }
  assert.match(view, /visible="\{= \$\{view>\/conditions\} &gt;= 3 \}"/u);
  assert.match(view, /visible="\{= \$\{view>\/conditions\} &gt;= 5 \}"/u);
});

test('the duplicate table scrolls sideways rather than squeezing its cells', () => {
  const scroller = view.slice(view.indexOf('<ScrollContainer'));
  assert.match(scroller.slice(0, scroller.indexOf('>')), /horizontal="true"[\s\S]*vertical="false"/u);
  assert.ok(view.indexOf('<ScrollContainer') < view.indexOf('<Table'), 'the table is inside it');
  assert.match(view, /<\/Table>\s*<\/ScrollContainer>/u);
  assert.match(view, /width="\{view>\/tableWidth\}"/u, 'a real width, not 100%');

  const fixed = Number(/var FIXED_REM = (\d+);/u.exec(controllerSource)[1]);
  const declared = [...view.matchAll(/<Column width="(\d+)rem"/gu)]
    .map((match) => Number(match[1]))
    .reduce((sum, each) => sum + each, 0);
  assert.equal(declared, fixed + (23 * 5) + (6 * 4), 'the widths add up to the formula');
  // The MultiSelect checkbox column (2026-09-02) has no <Column> to carry a width, so SELECT_REM is
  // the only place it is accounted for - and the formula has to include it or the real columns are
  // squeezed to make room.
  assert.match(controllerSource, /var SELECT_REM = \d+;/u);
  assert.match(controllerSource, /SELECT_REM \+ FIXED_REM \+ \(23 \* conditions\)/u);
});

test('Add and Delete Condition are wired, and Condition 1 is never removable', () => {
  const add = view.slice(view.indexOf('text="Add Condition"'));
  assert.match(add.slice(0, add.indexOf('/>')), /press="\.onAddCondition"/u);
  const remove = view.slice(view.indexOf('text="Delete Condition"'));
  assert.match(remove.slice(0, remove.indexOf('/>')), /press="\.onDeleteCondition"/u);
  assert.match(remove.slice(0, remove.indexOf('/>')), /enabled="\{= \$\{view>\/conditions\} &gt; 1 \}"/u);

  assert.match(controllerSource, /var MIN_CONDITIONS = 1;/u);
  assert.match(controllerSource, /if \(shown <= MIN_CONDITIONS\) return;/u);
  // Removing a column CLEARS the slot, or the engine goes on matching on a condition nobody sees.
  assert.match(controllerSource, /context\.setProperty\(slot\.field, null\)/u);
  assert.match(controllerSource, /context\.setProperty\(slot\.value, null\)/u);
  assert.match(controllerSource, /options\.conditionSlots/u);
});

/**
 * The Logic column never reached the engine before (found 2026-09-01 while adding the extra slots):
 * `conditionsMatch` reads it off the rule, and `toEngineRule` copied every condition column EXCEPT
 * the logic - so every duplicate rule was ANDed however the grid was set. It travels with its own
 * slot now, which is also what makes a five-slot rule joinable at all.
 */
test('the condition logic travels to the engine, per slot', () => {
  const { toEngineRule } = require('../srv/ai/rule-config');
  const rule = toEngineRule({
    field: 'Name',
    comparison: 'fuzzy',
    indicator: 'strong',
    conditionField: 'Country',
    conditionValue: 'BE',
    conditionLogic: 'OR',
    conditionField2: 'Country',
    conditionValue2: 'NL'
  });
  assert.equal(rule.conditionLogic, 'OR');
  // A slot that carries no condition carries no logic either - there is nothing for it to join.
  assert.equal(rule.conditionLogic2, undefined);
});

// The duplicate page advertises the list its engine has always accepted, same as the other three.
test('every condition value cell offers a list, not just one value', () => {
  for (const suffix of ['', '2', '3', '4', '5']) {
    const cell = view.slice(view.indexOf(`value="{dc>conditionValue${suffix}}"`));
    assert.match(cell.slice(0, cell.indexOf('/>')), /placeholder="any, or Value1[|]Value2"/u);
  }
  // The read path is what makes that true, and it is the shared one.
  const { conditionsMatch } = require('../srv/ai/duplicate-engine');
  const { buildCandidate } = require('../srv/ai/duplicate-fields');
  const rule = { field: 'Name', comparison: 'fuzzy', indicator: 'strong', conditionField: 'Country', conditionValue: 'BE|NL' };
  assert.equal(conditionsMatch(rule, buildCandidate({ Country: 'NL' })), true);
  assert.equal(conditionsMatch(rule, buildCandidate({ Country: 'DE' })), false);
});
