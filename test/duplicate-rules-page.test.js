'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'manifest.json'), 'utf8'));
const view = fs.readFileSync(path.join(APP, 'ext', 'view', 'DuplicateRuleList.view.xml'), 'utf8');
const controllerSource = fs.readFileSync(
  path.join(APP, 'ext', 'controller', 'DuplicateRuleList.controller.js'),
  'utf8'
);

const routing = manifest['sap.ui5'].routing;
const route = routing.routes.find((entry) => entry.name === 'DuplicateRuleList');

function loadController() {
  let definition;
  const base = { extend: (name, members) => ({ name, members }) };
  vm.runInNewContext(controllerSource, {
    sap: { ui: { define: (unused, factory) => { definition = factory(base, {}, function () {}, {}, {}); } } }
  });
  return definition.members;
}

test('the rules page is reachable through its own route and model', () => {
  assert.ok(route, 'the route is registered');
  assert.equal(route.pattern, 'DuplicateRules');
  assert.equal(routing.targets.DuplicateRuleList.name,
    'mdm.md.businesspartner.manage.ext.view.DuplicateRuleList');
  assert.equal(manifest['sap.app'].dataSources.duplicateConfigService.uri, 'service/duplicateconfig/');
  assert.equal(manifest['sap.ui5'].models.dc.dataSource, 'duplicateConfigService');
});

// Without a route entry the approuter catch-all sends the calls to the HTML5 repo, where they 404.
test('the service the page calls is routed through the approuter', () => {
  const routes = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'app', 'businesspartner', 'xs-app.json'), 'utf8')
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

// Moved to the MDM Rules tile (2026-08-17): rule configuration is not a partner-list action.
test('the partner list no longer carries a rules button', () => {
  const actions = routing.targets.BusinessPartnersList.options.settings
    .controlConfiguration['@com.sap.vocabularies.UI.v1.LineItem'].actions;
  assert.equal(Object.hasOwn(actions, 'DuplicateRules'), false);
  const source = fs.readFileSync(path.join(APP, 'ext', 'CustomActions.js'), 'utf8');
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
  assert.match(controllerSource, /_callAction\("ruleOptions"/u);
  // Bare-string arrays do not bind inside a table cell; every list is code/text for that reason.
  assert.equal(/<core:Item key="\{opt>\}"/u.test(view), false);
  assert.equal((view.match(/<core:Item key="\{opt>code\}" text="\{opt>text\}"/gu) || []).length, 5);
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
  for (const width of ['12%', '10%', '18%', '17%']) {
    assert.ok(view.includes(`width="${width}"`), `no column at ${width}`);
  }
  // A ComboBox left at its default width is what put the gaps between the cells.
  assert.equal((view.match(/<ComboBox\s+width="100%"/gu) || []).length, 5);
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
