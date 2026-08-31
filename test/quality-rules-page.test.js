'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'mdmrules', 'webapp');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const view = (name) => read(APP, 'ext', 'view', `${name}.view.xml`);
const controller = (name) => read(APP, 'ext', 'controller', `${name}.controller.js`);

const serviceCds = read(ROOT, 'srv', 'duplicate-config-service.cds');
const serviceJs = read(ROOT, 'srv', 'duplicate-config-service.js');
const rulesCds = read(ROOT, 'db', 'quality-rules.cds');
const changeRequestJs = read(ROOT, 'srv', 'change-request-service.js');

// The columns are the agreed shape of a rule, so they are pinned rather than left to a refactor.
test('the validation table has the columns a rule needs, in order', () => {
  const columns = [...view('ValidationRuleList').matchAll(/<Column[^>]*>\s*<Text text="([^"]+)"/gu)]
    .map((match) => match[1]);
  assert.deepEqual(columns, [
    'Condition 1 Field', 'Condition 1 Value', 'Condition 2 Field', 'Condition 2 Value',
    'Field', 'Comparison', 'Value', 'Severity', 'Active'
  ]);
});

test('the derivation table has the columns a rule needs, in order', () => {
  const columns = [...view('DerivationRuleList').matchAll(/<Column[^>]*>\s*<Text text="([^"]+)"/gu)]
    .map((match) => match[1]);
  assert.deepEqual(columns, [
    'Condition 1 Field', 'Condition 1 Value', 'Condition 2 Field', 'Condition 2 Value',
    'Field', 'Value', 'Active'
  ]);
});

// Both pages carry the same two condition pairs as the duplicate table, and the same "any" meaning.
test('the conditions are the duplicate table conditions', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    const source = view(name);
    for (const column of ['conditionField', 'conditionValue', 'conditionField2', 'conditionValue2']) {
      assert.match(source, new RegExp(`\\{dc>${column}\\}`, 'u'), `${name} binds ${column}`);
    }
    assert.match(source, /placeholder="any"/u);
    // A value with no field would be half a condition; the cell is disabled until there is one.
    assert.match(source, /enabled="\{= !!\$\{dc>conditionField\} \}"/u);
  }
  assert.match(rulesCds, /aspect ruleConditions/u);
});

/**
 * The Value cell is disabled for the comparisons that compare against nothing. A cell that accepted
 * a value the engine ignores is how a steward comes to believe a rule says something it does not.
 */
test('the validation Value cell switches itself off where a value is meaningless', () => {
  assert.match(view('ValidationRuleList'), /enabled="\{= \$\{view>\/needsValue\}\[\$\{dc>comparison\}\] !== false \}"/u);
  assert.match(serviceCds, /needsValue : Boolean/u);
  assert.match(controller('ValidationRuleList'), /needsValue\[entry\.code\] = entry\.needsValue !== false/u);
});

/**
 * The Value column means two things, and the page has to say which one it read: a plain value is
 * written as text, a value naming a field copies that field. Nothing else disambiguates them, so
 * the "Copied from" hint is the feedback that a reference was understood as one.
 */
test('the derivation page says when a Value was read as a field', () => {
  const source = view('DerivationRuleList');
  const ctrl = controller('DerivationRuleList');
  assert.match(source, /formatter: '\.formatValueHint'/u);
  assert.match(source, /formatter: '\.isFieldReference'/u);
  assert.match(ctrl, /Copied from/u);
  assert.match(ctrl, /fieldText\[entry\.code\] = entry\.text/u);
});

/**
 * A literal is the other half of the Value column, and it gets NO hint. It used to get
 * "Copied from undefined": the text was concatenated from a catalog lookup that misses for a
 * free-form value, and the `visible` guard beside it did not stop the text being rendered. The
 * lookup now decides the string itself, so there is nothing to hide.
 */
test('a free-form value gets no hint rather than an undefined one', () => {
  const source = view('DerivationRuleList');
  assert.equal(/'Copied from ' \+/u.test(source), false, 'no concatenation left in the view');
  const ctrl = controller('DerivationRuleList');
  const hint = ctrl.slice(ctrl.indexOf('formatValueHint: function'));
  assert.match(hint.slice(0, hint.indexOf('isFieldReference:')), /label \? "Copied from " \+ label : ""/u);
});

/**
 * No standing banners on any of the three rule pages (asked for 2026-08-19). The strips that remain
 * are all `Warning` and all conditionally bound, so a page carries a message only when something is
 * actually wrong with it - an explanation of what a derivation is belongs in the docs, and the
 * per-cell "Copied from" hint covers the one thing the columns cannot say.
 */
test('no rule page carries a permanent explanatory strip', () => {
  for (const name of ['DuplicateRuleList', 'ValidationRuleList', 'DerivationRuleList']) {
    const source = view(name);
    assert.equal(/type="Information"/u.test(source), false, `${name} has no Information strip`);
    for (const [, strip] of [...source.matchAll(/<MessageStrip([\s\S]*?)\/>/gu)]) {
      assert.match(strip, /visible="\{/u, `every strip on ${name} is conditional`);
    }
  }
});

test('both tables are exposed by the steward service and validated on write', () => {
  assert.match(serviceCds, /entity ValidationRules as projection on quality\.ValidationRules/u);
  assert.match(serviceCds, /entity DerivationRules as projection on quality\.DerivationRules/u);
  assert.match(serviceCds, /@requires: 'Steward'/u);
  assert.match(serviceCds, /function qualityRuleOptions\(\) returns QualityRuleOptions/u);
  // Caught at the keyboard: by check time the answer has already been given.
  assert.match(serviceJs, /guard\('ValidationRules', VALIDATIONS, validateValidationRule\)/u);
  assert.match(serviceJs, /guard\('DerivationRules', DERIVATIONS, validateDerivationRule\)/u);
});

// The path keeps its old name on purpose - it is in app/mdmrules/xs-app.json and in the deployed
// approuter config, so renaming it would cost a route change to gain nothing.
test('the new tables need no new approuter route', () => {
  assert.match(serviceCds, /@path: '\/service\/duplicateconfig'/u);
  const routes = JSON.parse(read(ROOT, 'app', 'mdmrules', 'xs-app.json')).routes;
  const configRoute = routes.find((entry) => entry.source.includes('duplicateconfig'));
  assert.ok(configRoute, 'the one route already covers all three tables');
  assert.ok(routes.indexOf(configRoute) < routes.findIndex((entry) => entry.source === '^(.*)$'));
});

/**
 * Any write drops the resident ruleset, the same way a partner write drops the name index.
 *
 * The call is `guard`'s default parameter since the workflow rule table joined it (2026-08-21):
 * that table needs its own store dropped, not this one. So what is pinned is the default and the
 * two tables that take it - a quality table given a different store would fail here, which is the
 * mistake worth catching.
 */
test('saving a rule invalidates the rules the pipeline is holding', () => {
  assert.match(serviceJs, /markStale = qualityRules\.markStale/u);
  assert.match(serviceJs, /entity, \(\) => markStale\(\)/u);
  for (const table of ['ValidationRules', 'DerivationRules']) {
    assert.match(
      serviceJs,
      new RegExp(`guard\\('${table}', [A-Z_]+, validate\\w+\\);`, 'u'),
      `${table} takes the quality store`
    );
  }
});

/**
 * Configured first in both lists, and each half of that is a decision:
 * validations because these are offline and a request that fails one should not cost a VIES call,
 * derivations because the pipeline never overwrites - so the stage that fills a field first wins,
 * and an explicitly configured rule is a decision somebody made about that field.
 *
 * The field property validations joined the head of the validation list on 2026-08-20, ahead of the
 * configured rules for the same reason they lead: they are offline, and "this field is required" is
 * the most basic complaint there is.
 *
 * The relation stage joined the tail on 2026-08-24, and last for the mirror of that reason: it is
 * the only validation that goes to S/4 - it reads CVI's business-partner-to-customer/vendor
 * assignment - so the offline complaints are the ones a requester reads first.
 */
test('the configured stages join the registry stages, configured first', () => {
  // node_required joined the offline group on 2026-08-28, before the cached and remote stages: it
  // reads MAINTENANCE_ENTITIES and the payload and nothing else, so it is the cheapest of the lot.
  assert.match(
    changeRequestJs,
    /validations: \[\.\.\.properties\.validations, \.\.\.configured\.validations, \.\.\.nodeRequiredStages\.validations,\s*\.\.\.createCviStages\(\)\.validations, \.\.\.registry\.validations,\s*\.\.\.relationStages\([^)]*\)\.validations\]/u
  );
  assert.match(
    changeRequestJs,
    /derivations: \[\.\.\.configured\.derivations, \.\.\.registry\.derivations,\s*\.\.\.createCviStages\(\)\.derivations, \.\.\.createDerivationStages\(\)\.derivations\]/u
  );
});

// Submit runs the validations and not the derivations (decided 2026-08-13): a derivation changes the
// data, so the requester has to have seen and ticked it.
test('submit runs the configured validations and still no derivations', () => {
  const submit = changeRequestJs.slice(changeRequestJs.indexOf("this.on('submitRequest'"));
  assert.match(submit, /runSubmitValidations\(/u);
  assert.equal(/configured\.derivations/u.test(submit.slice(0, submit.indexOf('recordDuplicateFindings'))), false);

  // The configured validations themselves live on the shared runSubmitValidations function now
  // (2026-08-31, also used by resubmit/data steward complete/decideRequest's approve gate), not
  // copied into submitRequest's own body.
  const runner = changeRequestJs.slice(
    changeRequestJs.indexOf('const runSubmitValidations ='),
    changeRequestJs.indexOf("this.on('checkRequest'")
  );
  assert.match(runner, /configured\.validations/u);
});

/**
 * The section ids are shared, not copied. A section in NODES that the catalog does not know would be
 * a field nobody can write a rule about; one in the catalog that NODES does not stage would be a
 * rule pointing at a node nothing stores.
 */
test('the staging nodes and the rule catalog are one list', () => {
  assert.match(changeRequestJs, /const NODES = Object\.fromEntries\(/u);
  assert.match(changeRequestJs, /PAYLOAD_NODES/u);
  const { PAYLOAD_NODES, ROOT_SECTION } = require('../srv/checks/payload-fields');
  assert.equal(PAYLOAD_NODES[ROOT_SECTION].root, true);
  // Every node names a staging entity, so a rule can always be traced to a table.
  for (const [section, node] of Object.entries(PAYLOAD_NODES)) {
    assert.match(node.entity, /^mdmlight\.staging\.Staged/u, `${section} names its staging entity`);
  }
});

// There are no default validations to fall back to, so an unreadable table must not pass as
// "nothing to report" - the same discipline the pipeline applies to a duplicate check that failed.
test('an unreadable rule table reports itself instead of running silently', async () => {
  const store = require('../srv/checks/rule-store');
  store.reset();
  const stages = await store.configuredStages({
    readRows: async () => { throw new Error('no database here'); }
  });
  const findings = await stages.validations[0].run({ root: {}, sections: {} });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].message, /could not be read/u);
  assert.match(findings[0].message, /no database here/u);
  store.reset();
});

test('a readable table becomes the stages, and an empty one becomes none', async () => {
  const store = require('../srv/checks/rule-store');
  store.reset();
  const empty = await store.configuredStages({ readRows: async () => ({ validations: [], derivations: [] }) });
  assert.deepEqual(empty.validations, []);
  assert.deepEqual(empty.derivations, []);

  store.reset();
  const loaded = await store.configuredStages({
    readRows: async () => ({
      validations: [{ field: 'General.Language', comparison: 'notEmpty', isActive: true }],
      derivations: []
    })
  });
  assert.equal(loaded.validations.length, 1);
  assert.equal(loaded.validations[0].name, 'configured_validation');
  store.reset();
});

// --- Duplicate, and Excel import/export - a real .xlsx (2026-08-31, asked for on all four rule
// pages, built for WorkflowRuleList first) --------------------------------------------------------

test('Duplicate, Export to Excel and Import from Excel are wired up on both pages', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    const source = view(name);
    const ctrl = controller(name);
    assert.match(source, /text="Duplicate"[\s\S]{0,80}press="\.onDuplicateRule"/u, `${name} has Duplicate`);
    assert.match(source, /text="Export to Excel"[\s\S]{0,80}press="\.onExportExcel"/u, `${name} has Export`);
    assert.match(source, /text="Import from Excel"[\s\S]{0,80}press="\.onImportExcel"/u, `${name} has Import`);
    assert.match(ctrl, /mdm\/md\/mdmrules\/manage\/ext\/util\/XlsxCodec/u, `${name} depends on XlsxCodec`);
    assert.match(ctrl, new RegExp(`XlsxCodec\\.buildWorkbook\\(\\s*"${name.replace('List', '')}s?"`, 'u'));
    assert.match(ctrl, /XlsxCodec\.readWorkbook\(/u);
    // No copy of the codec itself, and no third-party spreadsheet library.
    assert.equal(/function zipStore\(/u.test(ctrl), false, `${name} carries no codec copy`);
    assert.equal(/require\(["'](xlsx|exceljs|jszip|pako)["']/iu.test(ctrl), false);
  }
});

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`function not found: ${name}`);
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

function loadXlsxColumns(name) {
  const body = extractFunction(controller(name), 'xlsxColumns');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn xlsxColumns;`)();
}

test('xlsxColumns mirrors each page\'s own table exactly', () => {
  assert.deepEqual(loadXlsxColumns('ValidationRuleList')().map((c) => c.key), [
    'ID', 'conditionField', 'conditionValue', 'conditionLogic', 'conditionField2', 'conditionValue2',
    'field', 'comparison', 'value', 'severity', 'isActive'
  ]);
  assert.deepEqual(loadXlsxColumns('DerivationRuleList')().map((c) => c.key), [
    'ID', 'conditionField', 'conditionValue', 'conditionLogic', 'conditionField2', 'conditionValue2',
    'field', 'value', 'isActive'
  ]);
});

/**
 * `xlsxCodec` fills the ninth factory parameter (`XlsxCodec`); `messageBox`/`messageToast` default
 * to harmless no-op stubs, since `_applyImportedXlsx` always ends by calling one or the other. Both
 * pages share the identical nine-parameter factory signature, so one loader serves both.
 */
function loadController(name, xlsxCodec, messageBox, messageToast) {
  let definition;
  const base = { extend: (ctrlName, members) => ({ name: ctrlName, members }) };
  vm.runInNewContext(controller(name), {
    sap: { ui: { define: (unused, factory) => {
      definition = factory(
        base, {}, function () {}, {}, function () {}, {},
        messageBox || { error: () => {} },
        messageToast || { show: () => {} },
        xlsxCodec || {}
      );
    } } }
  });
  return definition.members;
}

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

/**
 * The same wholesale-replace fix WorkflowRuleList got the same day (2026-08-31), applied to both
 * quality-rule pages too: a row missing from the imported file is DELETED (staged, not saved), not
 * left untouched. Rows are built directly against each page's own column order, rather than through
 * a generic label-lookup, so a mistake here cannot mask one in the code being tested.
 */
test('an existing rule whose ID is absent from the import is removed, on both pages', () => {
  const cases = {
    ValidationRuleList: {
      // ID, Condition1Field, Condition1Value, Logic, Condition2Field, Condition2Value, Field,
      // Comparison, Value, Severity, Active
      row: (id) => [id, '', '', 'AND', '', '', 'General.Language', 'eq', 'NL', 'error', 'true']
    },
    DerivationRuleList: {
      // ID, Condition1Field, Condition1Value, Logic, Condition2Field, Condition2Value, Field, Value, Active
      row: (id) => [id, '', '', 'AND', '', '', 'General.Language', 'NL', 'true']
    }
  };

  for (const name of Object.keys(cases)) {
    const toasts = [];
    const members = loadController(name, STUB_XLSX_CODEC, undefined, { show: (text) => toasts.push(text) });
    const xlsxColumns = loadXlsxColumns(name);

    const kept = mockContext({ ID: 'kept' });
    const gone = mockContext({ ID: 'gone' });
    const created = [];
    const binding = { getCurrentContexts: () => [kept, gone], create: (record) => created.push(record) };
    const fakeThis = { _table: () => ({ getBinding: () => binding }), _markDirty: () => {} };

    const header = xlsxColumns().map((column) => column.label);
    // The import file only re-lists "kept" - "gone" must be removed.
    members._applyImportedXlsx.call(fakeThis, [header, cases[name].row('kept')]);

    assert.equal(kept.deleted, false, `${name}: kept row stays`);
    assert.equal(gone.deleted, true, `${name}: missing row is removed`);
    assert.equal(gone.deleteGroup, 'ruleChanges');
    assert.equal(created.length, 0, `${name}: the one row in the file matched an existing rule`);
    assert.match(toasts[0], /1 removed/u, name);
  }
});
