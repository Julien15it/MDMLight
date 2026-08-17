'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const APP = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'manifest.json'), 'utf8'));
const routing = manifest['sap.ui5'].routing;
const hub = fs.readFileSync(path.join(APP, 'ext', 'view', 'MDMRuleHub.view.xml'), 'utf8');
const component = fs.readFileSync(path.join(APP, 'Component.js'), 'utf8');

const read = (file) => fs.readFileSync(path.join(APP, 'ext', file), 'utf8');

// One app, two tiles. Both inbounds resolve to this component, so something has to tell them
// apart — that is the whole job of `screen=rules`.
test('the MDM Rules tile has its own inbound, distinguished by a startup parameter', () => {
  const inbound = manifest['sap.app'].crossNavigation.inbounds['MDMRules-manage'];
  assert.ok(inbound, 'the inbound is declared');
  assert.equal(inbound.semanticObject, 'MDMRules');
  assert.equal(inbound.action, 'manage');
  assert.equal(inbound.signature.parameters.screen.defaultValue.value, 'rules');
  // The partner tile keeps its own inbound untouched.
  assert.equal(manifest['sap.app'].crossNavigation.inbounds['BusinessPartner-manage'].semanticObject, 'BusinessPartner');
});

// navTo on a router that has not started yet is dropped silently, which reads as a broken tile.
test('the rules tile lands on the hub, and only that tile does', () => {
  assert.match(component, /screen \|\| \[\]\)\[0\] !== "rules"/u);
  assert.match(component, /navTo\("MDMRuleHub", \{\}, true\)/u);
  // Attaching after initialisation never fires; navigating before it is dropped. Both are handled.
  assert.match(component, /isInitialized\(\)\) openHub\(\);\s*else router\.attachInitialized\(openHub\)/u);
});

test('each rule screen has a route, a target and a view that exists', () => {
  for (const name of ['MDMRuleHub', 'ValidationRuleList', 'DerivationRuleList']) {
    const route = routing.routes.find((entry) => entry.name === name);
    assert.ok(route, `${name} has a route`);
    assert.equal(route.target, name);
    assert.equal(routing.targets[name].name, `mdm.md.businesspartner.manage.ext.view.${name}`);
    assert.ok(fs.existsSync(path.join(APP, 'ext', 'view', `${name}.view.xml`)), `${name}.view.xml exists`);
    assert.ok(
      fs.existsSync(path.join(APP, 'ext', 'controller', `${name}.controller.js`)),
      `${name}.controller.js exists`
    );
  }
});

test('the hub offers exactly the three rule kinds, each wired to its page', () => {
  for (const header of ['Duplicate Check Rules', 'Validation Rules', 'Derivation Rules']) {
    assert.ok(hub.includes(`header="${header}"`), `${header} is offered`);
  }
  assert.equal((hub.match(/<GenericTile/gu) || []).length, 3);
  const controller = read(path.join('controller', 'MDMRuleHub.controller.js'));
  for (const target of ['DuplicateRuleList', 'ValidationRuleList', 'DerivationRuleList']) {
    assert.match(controller, new RegExp(`navTo\\("${target}"\\)`, 'u'));
  }
});

// A table that looks live and silently stores nothing is worse than no table at all.
test('the unimplemented rule pages say so, and cannot pretend to save', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    const view = read(path.join('view', `${name}.view.xml`));
    assert.match(view, /Preview only/u);
    assert.match(view, /type="Warning"/u);
    assert.match(view, /text="Save"[\s\S]{0,80}enabled="false"/u, `${name} cannot save`);
  }
});

// Binding these to DuplicateRules to "make them work" would show duplicate rules under a
// Validation Rules heading and let someone edit them by accident.
test('the preview pages keep their rows local and never touch the duplicate rules', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    const view = read(path.join('view', `${name}.view.xml`));
    assert.match(view, /items="\{ path: 'rules>\/rules' \}"/u);
    assert.equal(/dc>\/DuplicateRules/u.test(view), false, `${name} does not bind the real rules`);
  }
});

// The catalog is the real one: empty dropdowns would make the preview unreadable, and a second
// hand-kept copy is what goes stale.
test('the preview pages take their field list from ruleOptions', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    const controller = read(path.join('controller', `${name}.controller.js`));
    assert.match(controller, /bindContext\("\/ruleOptions\(\.\.\.\)"\)/u);
    // Never interrupts: a preview with empty dropdowns is still a readable preview.
    assert.match(controller, /catch \(error\)[\s\S]{0,160}console\.warn/u);
  }
});

test('every rule page can get back where it came from', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    assert.match(read(path.join('view', `${name}.view.xml`)), /navButtonPress="\.onBackToHub"/u);
    assert.match(read(path.join('controller', `${name}.controller.js`)), /navTo\("MDMRuleHub", \{\}, true\)/u);
  }
  assert.match(hub, /navButtonPress="\.onBackToList"/u);
});
