'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
    'Field', 'Value', 'Add row', 'Active'
  ]);
});

// The column is the whole difference between filling a row and proposing one, and the header
// has no space to say it, so the tooltip has to.
test('the add-row column is bound and explains itself', () => {
  const source = view('DerivationRuleList');
  assert.match(source, /selected="\{dc>createsRow\}"/u);
  assert.match(source, /tooltip="Off: the rule fills this field in a row that already exists\./u);
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
  assert.match(source, /Copied from/u);
  assert.match(source, /\$\{view>\/fieldText\}\[\$\{dc>value\}\]/u);
  assert.match(controller('DerivationRuleList'), /fieldText\[entry\.code\] = entry\.text/u);
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

// Any write drops the resident ruleset, the same way a partner write drops the name index.
test('saving a rule invalidates the rules the pipeline is holding', () => {
  assert.match(serviceJs, /qualityRules\.markStale\(\)/u);
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
 */
test('the configured stages join the registry stages, configured first', () => {
  assert.match(
    changeRequestJs,
    /validations: \[\.\.\.properties\.validations, \.\.\.configured\.validations, \.\.\.registry\.validations\]/u
  );
  assert.match(changeRequestJs, /derivations: \[\.\.\.configured\.derivations, \.\.\.registry\.derivations\]/u);
});

// Submit runs the validations and not the derivations (decided 2026-08-13): a derivation changes the
// data, so the requester has to have seen and ticked it.
test('submit runs the configured validations and still no derivations', () => {
  const submit = changeRequestJs.slice(changeRequestJs.indexOf("this.on('submitRequest'"));
  const runValidations = submit.slice(submit.indexOf('runValidations('), submit.indexOf('runValidations(') + 200);
  assert.match(runValidations, /configured\.validations/u);
  assert.equal(/configured\.derivations/u.test(submit.slice(0, submit.indexOf('recordDuplicateFindings'))), false);
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
