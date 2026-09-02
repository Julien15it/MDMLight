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
    'conditionField', 'conditionOperator', 'conditionValue', 'conditionLogic',
    'conditionField2', 'conditionOperator2', 'conditionValue2', 'conditionLogic2',
    'conditionField3', 'conditionOperator3', 'conditionValue3', 'conditionLogic3',
    'conditionField4', 'conditionOperator4', 'conditionValue4', 'conditionLogic4',
    'conditionField5', 'conditionOperator5', 'conditionValue5',
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
