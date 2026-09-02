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

test('the partner app keeps one inbound and no rules routing', () => {
  assert.deepEqual(Object.keys(bpManifest['sap.app'].crossNavigation.inbounds), ['BusinessPartner-manage']);
  const names = bpManifest['sap.ui5'].routing.routes.map((entry) => entry.name);
  for (const gone of [
    'MDMRuleHub', 'DuplicateRuleList', 'ValidationRuleList', 'DerivationRuleList', 'WorkflowRuleList'
  ]) {
    assert.equal(names.includes(gone), false, `${gone} is still routed in the partner app`);
    assert.equal(Object.hasOwn(bpManifest['sap.ui5'].routing.targets, gone), false);
  }
  // The startup-parameter hack the second inbound needed goes with it.
  const bpComponent = fs.readFileSync(path.join(BP_APP, 'Component.js'), 'utf8');
  assert.equal(/_routeStartupScreen/u.test(bpComponent), false, 'the screen=rules router is gone');
  assert.equal(/\.screen\b/u.test(bpComponent), false, 'and so is the parameter it read');
  assert.equal(/MDMRuleHub/u.test(bpComponent), false);
});

test('each rule screen has a route, a target and a view that exists', () => {
  for (const name of [
    'MDMRuleHub', 'DuplicateRuleList', 'ValidationRuleList', 'DerivationRuleList',
    'FieldPropertyProfileList', 'WorkflowRuleList'
  ]) {
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

/**
 * These two were previews until 2026-08-19 - local rows, Save disabled, a Warning strip saying so.
 * They store and run now, so the assertions are inverted: a page that still said "preview only"
 * while writing to the database would be the lie the old strip existed to prevent.
 */
test('the rule pages store their rows and can save them', () => {
  for (const [name, entity] of [['ValidationRuleList', 'ValidationRules'], ['DerivationRuleList', 'DerivationRules']]) {
    const view = read(path.join('view', `${name}.view.xml`));
    assert.equal(/Preview only/u.test(view), false, `${name} no longer claims to be a preview`);
    assert.match(view, new RegExp(`items="\\{ path: 'dc>/${entity}'`, 'u'), `${name} binds its own entity`);
    assert.match(view, /text="Save"[\s\S]{0,120}press="\.onSave"/u, `${name} can save`);
    // Each page binds its own table. Binding DuplicateRules would show duplicate rules under a
    // Validation Rules heading and let someone edit them by accident.
    assert.equal(/dc>\/DuplicateRules/u.test(view), false, `${name} does not bind the duplicate rules`);
  }
});

/**
 * The catalog is generated from the staging model server-side, so the dropdowns and the value help
 * offer exactly the fields a request can hold. A hand-kept copy in the UI is what goes stale, and
 * `ruleOptions()` is the duplicate check's catalog - a different one, of normalised value bags.
 */

/**
 * Several hundred fields, so the picker is a searchable dialog rather than a ComboBox: sap.m.ComboBox
 * filters on the start of an item's text, which would have meant knowing a Country lives on Address
 * and typing that first.
 */
test('a field is chosen through a searchable value help, shared by both pages', () => {
  assert.ok(fs.existsSync(path.join(APP, 'ext', 'fragment', 'FieldValueHelp.fragment.xml')));
  const fragment = read(path.join('fragment', 'FieldValueHelp.fragment.xml'));
  assert.match(fragment, /<SelectDialog/u);
  assert.match(fragment, /items="\{ path: 'opt>\/fields'/u);
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    const view = read(path.join('view', `${name}.view.xml`));
    const controller = read(path.join('controller', `${name}.controller.js`));
    assert.match(view, /valueHelpRequest="\.onFieldValueHelp"/u);
    assert.match(controller, /ext\.fragment\.FieldValueHelp/u);
    // `contains`, and over the qualified code as well as the label.
    assert.match(controller, /FilterOperator\.Contains/u);
    // The stored value is the qualified code, never the label - a label reworded later must not
    // turn a saved rule into one that no longer resolves.
    assert.match(controller, /getProperty\("code"\)/u);
    assert.match(controller, /setProperty\(this\._target\.path, code\)/u);
  }
});

/**
 * The wrong field used to land: the confirm handler cleared the search filter and *then* asked the
 * selected item control for its value, but resetting a JSONModel list binding re-templates the rows,
 * so the item was re-bound to whatever now sat at its old position. Searching "Country" left one
 * match at position 0, and position 0 of the unfiltered catalog is a General name field.
 *
 * Two things fix it and both are pinned: the value is read off the binding context, and the filter is
 * reset when the dialog OPENS rather than when it closes.
 */
test('the value help reads the selection before anything resets the list', () => {
  for (const name of ['ValidationRuleList', 'DerivationRuleList']) {
    const controller = read(path.join('controller', `${name}.controller.js`));
    const chosen = controller.slice(controller.indexOf('onFieldChosen:'));
    const body = chosen.slice(0, chosen.indexOf('\n    },'));
    assert.equal(/filter\(\[\]\)/u.test(body), false, `${name} does not clear the filter while choosing`);
    assert.equal(/getDescription/u.test(body), false, 'the label is not what gets stored');
    // The code is read out before the property is written, not after a reset.
    assert.ok(body.indexOf('getProperty("code")') < body.indexOf('setProperty('));
    // And the reset happens on the way in, on the shared dialog.
    const open = controller.slice(controller.indexOf('onFieldValueHelp:'));
    assert.match(open.slice(0, open.indexOf('.open("")')), /getBinding\("items"\)[\s\S]{0,80}filter\(\[\]\)/u);
  }
});

// Back from the hub leaves the app for the SITE, not for the Manage BP tile - landing on another
// app's tile is not "back". An empty shellHash is the launchpad home. It must also not throw where
// there is no shell, which is every local run.
test('the hub leaves for the site, and survives having no shell', () => {
  const controller = read(path.join('controller', 'MDMRuleHub.controller.js'));
  assert.equal(/navTo\("BusinessPartnersList"/u.test(controller), false);
  assert.match(controller, /CrossApplicationNavigation/u);
  assert.match(controller, /shellHash: "#"/u);
  assert.equal(/semanticObject: "BusinessPartner"/u.test(controller), false, 'not back to a tile');
  assert.match(controller, /if \(!shell\) return/u);
});
