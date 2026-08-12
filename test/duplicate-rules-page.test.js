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

test('the toolbar action points at a handler that exists', () => {
  const actions = routing.targets.BusinessPartnersList.options.settings
    .controlConfiguration['@com.sap.vocabularies.UI.v1.LineItem'].actions;
  assert.equal(
    actions.DuplicateRules.press,
    'mdm.md.businesspartner.manage.ext.CustomActions.openDuplicateRules'
  );
  const source = fs.readFileSync(path.join(APP, 'ext', 'CustomActions.js'), 'utf8');
  assert.match(source, /openDuplicateRules:\s*function/u);
  assert.match(source, /navigate\("DuplicateRules"\)/u);
});

// The whole reason ruleOptions() exists: a copy kept in the view goes stale the moment the
// code-defined catalog grows a field.
test('the field, comparison and indicator lists come from the service', () => {
  assert.match(view, /items="\{ path: 'opt>\/fields'/u);
  assert.match(view, /items="\{ path: 'opt>\/comparisons'/u);
  assert.match(view, /items="\{ path: 'opt>\/indicators'/u);
  assert.match(controllerSource, /_callAction\("ruleOptions"/u);
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
  assert.deepEqual(_localProblems([
    { field: 'Name', comparison: 'exact', indicator: 'definitive' }
  ]), []);
  assert.equal(_localProblems([
    { field: 'Name', comparison: 'fuzzy', indicator: 'strong' }
  ]).length, 1);
  assert.equal(_localProblems([
    { field: 'Name', comparison: 'fuzzy', threshold: 1.5, indicator: 'strong' }
  ]).length, 1);
  assert.equal(_localProblems([
    { field: '', comparison: '', indicator: '' }
  ]).length, 3);
});
