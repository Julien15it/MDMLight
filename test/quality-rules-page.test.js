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

/**
 * The Value cell is disabled for the comparisons that compare against nothing. A cell that accepted
 * a value the engine ignores is how a steward comes to believe a rule says something it does not.
 */

/**
 * The Value column means two things, and the page has to say which one it read: a plain value is
 * written as text, a value naming a field copies that field. Nothing else disambiguates them, so
 * the "Copied from" hint is the feedback that a reference was understood as one.
 */

/**
 * A literal is the other half of the Value column, and it gets NO hint. It used to get
 * "Copied from undefined": the text was concatenated from a catalog lookup that misses for a
 * free-form value, and the `visible` guard beside it did not stop the text being rendered. The
 * lookup now decides the string itself, so there is nothing to hide.
 */

/**
 * No standing banners on any of the three rule pages (asked for 2026-08-19). The strips that remain
 * are all `Warning` and all conditionally bound, so a page carries a message only when something is
 * actually wrong with it - an explanation of what a derivation is belongs in the docs, and the
 * per-cell "Copied from" hint covers the one thing the columns cannot say.
 */

test('both tables are exposed by the steward service and validated on write', () => {
  assert.match(serviceCds, /entity ValidationRules as projection on quality\.ValidationRules/u);
  assert.match(serviceCds, /entity DerivationRules as projection on quality\.DerivationRules/u);
  assert.match(serviceCds, /@requires: 'Steward'/u);
  assert.match(serviceCds, /function qualityRuleOptions\(\) returns QualityRuleOptions/u);
  // Caught at the keyboard: by check time the answer has already been given.
  assert.match(serviceJs, /guard\('ValidationRules', VALIDATIONS, validateValidationRule\)/u);
  assert.match(serviceJs, /guard\('DerivationRules', DERIVATIONS, validateDerivationRule\)/u);
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

// No `ID` column on either page (dropped 2026-08-31 along with ID-matching on import - see the
// wholesale-replace test below).
test('xlsxColumns mirrors each page\'s own table exactly, minus the generated ID', () => {
  const validationKeys = loadXlsxColumns('ValidationRuleList')().map((c) => c.key);
  assert.deepEqual(validationKeys, [
    'conditionField', 'conditionOperator', 'conditionValue', 'conditionLogic',
    'conditionField2', 'conditionOperator2', 'conditionValue2', 'conditionLogic2',
    'conditionField3', 'conditionOperator3', 'conditionValue3', 'conditionLogic3',
    'conditionField4', 'conditionOperator4', 'conditionValue4', 'conditionLogic4',
    'conditionField5', 'conditionOperator5', 'conditionValue5',
    'field', 'comparison', 'value', 'severity', 'isActive'
  ]);
  assert.equal(validationKeys.includes('ID'), false);

  const derivationKeys = loadXlsxColumns('DerivationRuleList')().map((c) => c.key);
  assert.deepEqual(derivationKeys, [
    'conditionField', 'conditionOperator', 'conditionValue', 'conditionLogic',
    'conditionField2', 'conditionOperator2', 'conditionValue2', 'conditionLogic2',
    'conditionField3', 'conditionOperator3', 'conditionValue3', 'conditionLogic3',
    'conditionField4', 'conditionOperator4', 'conditionValue4', 'conditionLogic4',
    'conditionField5', 'conditionOperator5', 'conditionValue5',
    'field', 'value', 'isActive'
  ]);
  assert.equal(derivationKeys.includes('ID'), false);
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
 * Import now REPLACES the table wholesale, the same change WorkflowRuleList got the same day
 * (2026-08-31, on direct feedback: matching by ID was dropped in favour of just overriding with
 * whatever the file holds), applied to both quality-rule pages too. Rows are built directly against
 * each page's own column order, rather than through a generic label-lookup, so a mistake here cannot
 * mask one in the code being tested.
 */
test('import deletes every existing row and creates one for every row in the file, on both pages', () => {
  // Keyed, not positional: the row went from 10 cells to 19 when the extra condition slots landed
  // (2026-09-01), and a positional fixture silently stopped filling Field/Comparison at all, so
  // nothing was created and the failure named the import rather than the fixture.
  const cases = {
    ValidationRuleList: {
      values: { field: 'General.Language', comparison: 'eq', value: 'NL', severity: 'error', isActive: 'true' }
    },
    DerivationRuleList: {
      values: { field: 'General.Language', value: 'NL', isActive: 'true' }
    }
  };

  for (const name of Object.keys(cases)) {
    const toasts = [];
    const members = loadController(name, STUB_XLSX_CODEC, undefined, { show: (text) => toasts.push(text) });
    const xlsxColumns = loadXlsxColumns(name);

    // Two rows already on the page - neither should survive untouched, even one whose data happens
    // to match the row in the file.
    const first = mockContext({});
    const second = mockContext({});
    const created = [];
    const binding = { getCurrentContexts: () => [first, second], create: (record) => created.push(record) };
    const fakeThis = { _table: () => ({ getBinding: () => binding }), _markDirty: () => {}, _syncConditionColumns: () => {} };

    const columns = xlsxColumns();
    const header = columns.map((column) => column.label);
    const values = cases[name].values;
    const row = columns.map((column) => values[column.key]
      || (column.key === 'conditionLogic' ? 'AND' : ''));
    members._applyImportedXlsx.call(fakeThis, [header, row]);

    assert.equal(first.deleted, true, `${name}: first row deleted`);
    assert.equal(first.deleteGroup, 'ruleChanges');
    assert.equal(second.deleted, true, `${name}: second row deleted`);
    assert.equal(created.length, 1, `${name}: one new row for the one non-blank row in the file`);
    assert.match(toasts[0], /2 existing rule\(s\) replaced by 1 from the file/u, name);
  }
});

// --- Five condition slots, Add/Delete Condition and the scrollbar (2026-09-01) -------------------
//
// Rolled out from Workflow Agent Determination onto these two pages and the duplicate one, asked
// for directly. Field Properties is deliberately untouched: it conditions through profiles, not
// through a condition row, so there is nothing here for it to take over.

const CONDITION_PAGES = ['ValidationRuleList', 'DerivationRuleList'];

/**
 * `targetType: 'any'` on every `dc>` reference inside an expression binding. Without it UI5 formats
 * the referenced property into the type of the BOUND control property - a Boolean here - and a
 * String value throws a FormatException, leaving the cell at its default. Found in the deployed
 * app's console on the workflow page (2026-09-01); these three pages carried the same latent bug.
 */
test('no expression binding on a Boolean property reads a dc property untyped', () => {
  for (const name of [...CONDITION_PAGES, 'DuplicateRuleList']) {
    const source = view(name);
    assert.equal(
      /enabled="\{=[^"]*\$\{dc>[^,}]*\}/u.test(source),
      false,
      `${name} has no untyped reference in an enabled binding`
    );
    assert.match(source, /\$\{path: 'dc>conditionField', targetType: 'any'\}/u, `${name} types its references`);
  }
});

/**
 * Several values per condition, on every rule table (2026-09-01, asked for: "the plural
 * conditionvalue can be reused on the other tables as well").
 *
 * The COLUMN NAMES cannot follow WorkflowRules plural conditionValues - cds-deploy refuses to
 * rename a deployed element as firmly as it refuses to drop one, and naming only slots 3-5 plural
 * would leave each table disagreeing with itself. What the plural NAME stands for does apply
 * everywhere, and always did: parseValueList is shared, so BE|NL|FR is one condition on all four
 * tables. What was missing was any sign of it on these pages, which said only "any".
 */
test('every condition value cell offers a list, not just one value', () => {
  for (const name of CONDITION_PAGES) {
    const source = view(name);
    for (const suffix of ['', '2', '3', '4', '5']) {
      const cell = source.slice(source.indexOf(`value="{dc>conditionValue${suffix}}"`));
      assert.match(
        cell.slice(0, cell.indexOf('/>')),
        /placeholder="any, or Value1[|]Value2"/u,
        `${name} condition ${suffix || '1'} says a list is allowed`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// One "Condition N" column: field, comparator, values (2026-09-02, asked for)
// ---------------------------------------------------------------------------

/**
 * "Make it so our Condition combinations are built the same way as in Workflow Agent Determination -
 * Condition 1 contains the field, the comparator, the values. The other tiles should have the exact
 * same way of working." So all three of the remaining rule tables draw ONE column per slot holding
 * the three controls side by side, where they used to draw a Field column and a Value column with
 * equality implied between them.
 */
test('every rule tile builds a condition the way the workflow tile does', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList', 'DuplicateRuleList', 'WorkflowRuleList']) {
    const source = view(name);
    for (const suffix of ['', '2', '3', '4', '5']) {
      // The comparator sits between the field and the value, in that order, inside one HBox.
      const slot = source.slice(source.indexOf(`dc>conditionField${suffix}}`));
      const operator = slot.indexOf(`dc>conditionOperator${suffix}}`);
      assert.ok(operator > 0, `${name} condition ${suffix || '1'} has a comparator`);
      assert.ok(
        operator < slot.indexOf(`dc>condition${name === 'WorkflowRuleList' ? 'Values' : 'Value'}${suffix}}`),
        `${name} puts the comparator before the value`
      );
    }
    // One column per slot, titled by the slot alone - the field and value are inside it now.
    assert.match(source, /<Column width="24rem"[^>]*><Text text="Condition 1" \/><\/Column>/u,
      `${name} draws one 24rem Condition 1 column`);
    assert.equal(source.includes('Condition 1 Field" /></Column>'), false,
      `${name} no longer splits a condition across two columns`);
  }
});

// The comparator vocabulary is the engine's, served, never a hand-kept copy in a page - and it is
// NOT the duplicate table's own `comparisons`, which say how two RECORDS are matched.
test('the condition comparator list is served, and told apart from record matching', () => {
  assert.match(view('ValidationRuleList'), /items="\{ path: 'opt>\/comparisons'/u);
  assert.match(view('DerivationRuleList'), /items="\{ path: 'opt>\/comparisons'/u);
  assert.match(view('DuplicateRuleList'), /items="\{ path: 'opt>\/conditionComparisons'/u);
  assert.match(serviceCds, /conditionComparisons : array of ComparisonOption;/u);
  assert.match(serviceJs, /conditionComparisons: Object\.entries\(COMPARISONS\)/u);
});

// Additive columns, defaulting to `eq`: cds-deploy can add an element and can neither drop nor
// retype one, and a null has to go on meaning what every stored row already meant.
test('the comparator is a new column on both rule schemas, defaulting to equality', () => {
  const duplicateCds = read(ROOT, 'db', 'duplicate-rules.cds');
  for (const source of [rulesCds, duplicateCds]) {
    // Read line by line rather than as one pattern: the two files align their colons differently,
    // and how a .cds file is indented is not what this test is about.
    const declared = source.split('\n')
      .map((line) => line.trim().replace(/\s+/gu, ' '))
      .filter((line) => line.startsWith('conditionOperator'));
    for (const suffix of ['', '2', '3', '4', '5']) {
      assert.ok(
        declared.includes(`conditionOperator${suffix} : String(12) default 'eq';`),
        `conditionOperator${suffix} is declared, defaulting to equality`
      );
    }
  }
});


/**
 * The crash that took every rule tile down (2026-09-03): "The rule options could not be loaded:
 * Cannot read properties of undefined (reading 'getObject')". Every options function answered 200 -
 * the failure was `_loadOptions` calling `_syncConditionColumns` -> `_draftRules` while the row
 * $batch was still in flight, and `getCurrentContexts()` holding UNDEFINED for a row the model had
 * not delivered yet. Field Properties was the one tile that worked, because it draws no condition
 * columns and so never calls this.
 */
test('_draftRules survives a context the model has not delivered yet', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    const members = loadController(name, STUB_XLSX_CODEC);
    const binding = {
      // An unloaded row is `undefined`; a context whose data has not arrived answers `undefined`
      // from getObject(). The first threw, the second produced a phantom blank draft.
      getCurrentContexts: () => [undefined, mockContext({ field: 'General.Language' }), mockContext(undefined)]
    };
    const rules = members._draftRules.call({ _table: () => ({ getBinding: () => binding }) });
    assert.equal(rules.length, 1, `${name}: only the row that actually arrived`);
    assert.equal(rules[0].field, 'General.Language', name);
  }
});

// No table yet is not a crash either - it is simply no drafts. Length, not deepEqual: the controller
// is loaded in its own vm realm, so the array it returns has a different Array.prototype and
// deepStrictEqual refuses it. Same trap as test/xlsx-codec.test.js - see rule-tiles.md.
test('_draftRules answers an empty list before the table exists', () => {
  const members = loadController('DerivationRuleList', STUB_XLSX_CODEC);
  assert.equal(members._draftRules.call({ _table: () => null }).length, 0);
});

// The duplicate and workflow pages carry their own copy of the same function, and went down with
// the same error. Checked as text because those two have no shared loader to call it through.
test('all four rule pages guard the same way', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList', 'DuplicateRuleList', 'WorkflowRuleList']) {
    const source = controller(name);
    assert.match(source, /return context && context\.getObject\(\);/u, name);
    assert.match(source, /\}\)\.filter\(Boolean\)\.map\(function \(data\) \{/u, name);
  }
});


/**
 * Every condition slot above the first is drawn only while the page says it is shown — the column
 * AND the Logic column that leads into it, two bindings per slot on all four pages.
 *
 * Condition 2's pair carried no binding at all: `MIN_CONDITIONS` is 1, so Delete Condition took
 * `view>/conditions` down to 1 and greyed itself out (`enabled="{= ${view>/conditions} > 1 }"`)
 * while the column it had just cleared stayed on screen — a ghost column holding a slot the engine
 * no longer reads. `tableWidthFor(1)` counts one condition column and zero Logic columns, so the
 * table was also narrower than what it drew.
 */
test('every condition slot above the first is gated on the shown count', () => {
  // Plain string counting, not a regex: the binding is full of `{`, `}` and `$`, and every one of
  // them needs escaping under /u for no gain here.
  const occurrences = (text, needle) => text.split(needle).length - 1;

  for (const name of ['ValidationRuleList', 'DerivationRuleList', 'DuplicateRuleList', 'WorkflowRuleList']) {
    const xml = view(name);
    for (const slot of [2, 3, 4, 5]) {
      const gate = 'visible="{= ${view>/conditions} &gt;= ' + slot + ' }"';
      assert.equal(
        occurrences(xml, gate), 2,
        `${name}: condition ${slot} needs its own column and its Logic column gated`
      );
    }
    // Condition 1 is never removable, so it is never gated.
    assert.ok(
      xml.includes('<Column width="24rem"><Text text="Condition 1" /></Column>'),
      `${name}: condition 1 stays ungated`
    );
  }
});
