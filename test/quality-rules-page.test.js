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
    'Condition 1 Field', 'Condition 1 Values', 'Condition 2 Field', 'Condition 2 Values',
    'Field', 'Comparison', 'Value', 'Severity', 'Active'
  ]);
});

test('the derivation table has the columns a rule needs, in order', () => {
  const columns = [...view('DerivationRuleList').matchAll(/<Column[^>]*>\s*<Text text="([^"]+)"/gu)]
    .map((match) => match[1]);
  assert.deepEqual(columns, [
    'Condition 1 Field', 'Condition 1 Values', 'Condition 2 Field', 'Condition 2 Values',
    'Field', 'Value', 'Active'
  ]);
});

/**
 * Both pages carry the same two condition pairs as the duplicate table, and the same "any" meaning.
 * The VALUES became a list on 2026-08-21 - one row for "Country is BE, NL, FR or DE" - so they are
 * token cells naming their column through custom data, while the fields stay bound Inputs.
 */
test('the conditions are the duplicate table conditions', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    const source = view(name);
    for (const column of ['conditionField', 'conditionField2']) {
      assert.match(source, new RegExp(`\\{dc>${column}\\}`, 'u'), `${name} binds ${column}`);
    }
    // The columns keep their singular names: `cds-deploy` cannot rename an element any more than
    // it can drop one, so these tables hold a list in `conditionValue` while the workflow table,
    // written after the decision, has `conditionValues`.
    for (const column of ['conditionValue', 'conditionValue2']) {
      assert.match(source, new RegExp(`app:listPath="${column}"`, 'u'), `${name} tokenises ${column}`);
    }
    // Every `value="{dc>conditionValue…}"` binding belongs to the hidden writer beside the token
    // cell - that binding is what makes the list travel - and there is exactly one per column.
    for (const column of ['conditionValue', 'conditionValue2']) {
      const bindings = (source.match(new RegExp(`value="\\{dc>${column}\\}"`, 'gu')) || []).length;
      const sinks = (source.match(new RegExp(`app:listSink="${column}"`, 'gu')) || []).length;
      assert.equal(bindings, sinks, `${name}: ${column} is bound only by its writer`);
      assert.equal(bindings, 1, `${name}: ${column} has exactly one writer`);
    }
    assert.match(source, /placeholder="any"/u);
    // A value with no field would be half a condition; the cell is disabled until there is one.
    assert.match(source, /enabled="\{= !!\$\{dc>conditionField\} \}"/u);
    // Rendered rows are filled from the stored value, which is what keeps tokens and column in step.
    assert.match(source, /updateFinished="\.onRowsRendered"/u);
  }
  assert.match(rulesCds, /aspect ruleConditions/u);
});

/**
 * One implementation of the token cells for all four rule pages. Sixty lines of aggregation
 * bookkeeping copied four times drifts the first time one copy is fixed - the same reasoning that
 * put the maintenance screen in app/reuse.
 */
test('every rule page uses the one shared token cell, and none carries a copy', () => {
  const shared = read(APP, 'ext', 'ListCell.js');
  assert.match(shared, /new Token\(\{ key: value, text: value \}\)/u);
  assert.match(shared, /removeAllTokens\(\)/u);
  // tokenUpdate fires before the aggregation changes, so the list comes from the event.
  assert.match(shared, /addedTokens/u);
  assert.match(shared, /removedTokens/u);
  for (const name of [
    'DuplicateRuleList', 'ValidationRuleList', 'DerivationRuleList', 'WorkflowRuleList'
  ]) {
    const source = controller(name);
    assert.match(source, /ListCell\.mixin\(this, \{/u, `${name} takes the shared handlers`);
    assert.equal(/new Token\(/u.test(source), false, `${name} builds no tokens of its own`);
    assert.equal(/removeAllTokens/u.test(source), false, `${name} keeps no copy`);
  }
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


/**
 * A rule saved, then lost its two list columns the moment the app was left and re-entered
 * (reported 2026-08-21). The row was in the database; those two columns were empty in it.
 *
 * The cause was the write path, not the data: a `MultiInput`'s tokens are an aggregation, so the
 * cells wrote the column with `context.setProperty`. That reaches the client model - which is why
 * the values survived navigating around inside the app, off the model cache - and never reached the
 * server. Every column on these pages that does save is written by a **two-way binding**, so each
 * token cell now has a hidden bound `Input` beside it that does the writing.
 *
 * Pinned per column on every page, because a page that grew a token cell without a writer would
 * fail silently in exactly the same way.
 */
test('every token cell has the bound control that writes it', () => {
  for (const name of [
    'DuplicateRuleList', 'ValidationRuleList', 'DerivationRuleList', 'WorkflowRuleList'
  ]) {
    const source = view(name);
    const columns = [...source.matchAll(/app:listPath="([^"]+)"/gu)].map((match) => match[1]);
    assert.ok(columns.length >= 2, `${name} has token cells`);
    for (const column of columns) {
      assert.match(
        source,
        new RegExp(`app:listSink="${column}"`, 'u'),
        `${name} has a bound writer for ${column}`
      );
      assert.match(
        source,
        new RegExp(`value="\\{dc>${column}\\}"`, 'u'),
        `${name} binds ${column} two-way, which is what makes it travel`
      );
    }
  }
  // The module writes through it, and says so loudly rather than silently falling back.
  const shared = read(APP, 'ext', 'ListCell.js');
  assert.match(shared, /sink\.setValue\(stored\)/u);
  assert.match(shared, /has no bound writer, so it cannot be saved/u);
});


/**
 * A typed approver address stopped sticking the moment the write moved onto the binding (reported
 * 2026-08-21): the write path re-read the model to redraw the tokens, and through a two-way binding
 * that read does not reliably see what was just written - so it came back with the PREVIOUS value
 * and removed the token a line after adding it. `context.setProperty` had hidden this by updating
 * the client cache synchronously.
 *
 * So the write path draws what it wrote, and only the render path reads the model.
 */
test('the write path draws what it wrote, and never re-reads the model', () => {
  const shared = read(APP, 'ext', 'ListCell.js');
  const write = shared.slice(shared.indexOf('var writeTokens = function'));
  const body = write.slice(0, write.indexOf('
    };'));
  assert.match(body, /applyTokens\(cell, stored\)/u, 'it draws the list it just wrote');
  assert.equal(
    /getProperty\(/u.test(body),
    false,
    'the write path reads nothing back out of the model'
  );
  assert.equal(/fillTokens\(/u.test(body), false, 'and does not go through the render path');
  // The render path is the only reader, and it is the one the table calls on updateFinished.
  const fill = shared.slice(shared.indexOf('var fillTokens = function'));
  assert.match(fill.slice(0, fill.indexOf('};')), /context\.getProperty\(path\)/u);
  // Still self-correcting: a stray token the control added is compared against and cleaned up.
  assert.match(shared, /var shown = formatList\(cell\.getTokens\(\)/u);
});
