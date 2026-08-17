'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const APP = path.join(__dirname, '..', 'app', 'mdmrules', 'webapp');
const BP_APP = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'manifest.json'), 'utf8'));
const bpManifest = JSON.parse(fs.readFileSync(path.join(BP_APP, 'manifest.json'), 'utf8'));
const routing = manifest['sap.ui5'].routing;
const hub = fs.readFileSync(path.join(APP, 'ext', 'view', 'MDMRuleHub.view.xml'), 'utf8');
const component = fs.readFileSync(path.join(APP, 'Component.js'), 'utf8');

const read = (file) => fs.readFileSync(path.join(APP, 'ext', file), 'utf8');

// Work Zone standard edition exposes only the FIRST inbound of an app, so the rules tile has to be
// its own app. A second inbound on the partner app was silently dropped and never reached the
// Content Explorer at all.
test('the rules app is its own app with exactly one inbound', () => {
  const inbounds = manifest['sap.app'].crossNavigation.inbounds;
  assert.deepEqual(Object.keys(inbounds), ['MDMRules-manage']);
  assert.equal(inbounds['MDMRules-manage'].semanticObject, 'MDMRules');
  assert.equal(inbounds['MDMRules-manage'].action, 'manage');
  assert.equal(manifest['sap.app'].id, 'mdm.md.mdmrules.manage');
});

// Unique per subaccount, or the deploy collides; shared service, or it needs its own destinations.
test('the two apps share the business service and differ only by app id', () => {
  assert.equal(manifest['sap.cloud'].service, bpManifest['sap.cloud'].service);
  assert.notEqual(manifest['sap.app'].id, bpManifest['sap.app'].id);
});

test('the partner app keeps one inbound and no rules routing', () => {
  assert.deepEqual(Object.keys(bpManifest['sap.app'].crossNavigation.inbounds), ['BusinessPartner-manage']);
  const names = bpManifest['sap.ui5'].routing.routes.map((entry) => entry.name);
  for (const gone of ['MDMRuleHub', 'DuplicateRuleList', 'ValidationRuleList', 'DerivationRuleList']) {
    assert.equal(names.includes(gone), false, `${gone} is still routed in the partner app`);
    assert.equal(Object.hasOwn(bpManifest['sap.ui5'].routing.targets, gone), false);
  }
  // The startup-parameter hack the second inbound needed goes with it.
  const bpComponent = fs.readFileSync(path.join(BP_APP, 'Component.js'), 'utf8');
  assert.equal(/screen/u.test(bpComponent), false, 'screen=rules routing is gone');
  assert.equal(/MDMRuleHub/u.test(bpComponent), false);
});

// The hub is the app root, so it must be what an empty hash resolves to.
test('the hub is the landing page and starts the router itself', () => {
  const root = routing.routes.find((entry) => entry.pattern === '');
  assert.ok(root, 'an empty pattern is routed');
  assert.equal(root.name, 'MDMRuleHub');
  assert.match(component, /getRouter\(\)\.initialize\(\)/u);
});

test('each rule screen has a route, a target and a view that exists', () => {
  for (const name of ['MDMRuleHub', 'DuplicateRuleList', 'ValidationRuleList', 'DerivationRuleList']) {
    const route = routing.routes.find((entry) => entry.name === name);
    assert.ok(route, `${name} has a route`);
    assert.equal(route.target, name);
    assert.equal(routing.targets[name].name, `mdm.md.mdmrules.manage.ext.view.${name}`);
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

// Back from the hub leaves the app, so it is an intent and not a route - and it must not throw
// where there is no shell, which is every local run.
test('the hub leaves for the partner app by intent, and survives having no shell', () => {
  const controller = read(path.join('controller', 'MDMRuleHub.controller.js'));
  assert.equal(/navTo\("BusinessPartnersList"/u.test(controller), false);
  assert.match(controller, /CrossApplicationNavigation/u);
  assert.match(controller, /semanticObject: "BusinessPartner", action: "manage"/u);
  assert.match(controller, /if \(!shell\) return/u);
});
