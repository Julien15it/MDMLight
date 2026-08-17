'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const read = (...segments) => fs.readFileSync(path.join(APP, ...segments), 'utf8');

const controller = read('ext', 'controller', 'ChangeRequestList.controller.js');
const view = read('ext', 'view', 'ChangeRequestList.view.xml');
const manifest = JSON.parse(read('manifest.json'));

const listSettings = manifest['sap.ui5'].routing.targets.BusinessPartnersList.options.settings;
const listActions = listSettings.controlConfiguration['@com.sap.vocabularies.UI.v1.LineItem']
  .actions;

// On a customer system an automatic full read makes the tile look like it has hung.
test('the business partner list does not search when the app opens', () => {
  assert.equal(listSettings.initialLoad, 'Disabled');
});

// A decision is taken against a real task in the approver's inbox, never by finding the
// request in a list. The route stays — the inbox link uses it — but nothing here reaches it.
test('the approve screen is not reachable from the change request list', () => {
  assert.equal(/ChangeRequestApprove/u.test(controller), false);
  assert.match(controller, /if \(context\.getProperty\("status"\) !== "draft"\) return;/u);
});

// A draft is still the requester's to finish, so that one route remains.
test('a draft still opens for editing', () => {
  assert.match(controller, /navTo\("ChangeRequestEdit"/u);
});

test('only a draft row offers navigation', () => {
  assert.match(
    view,
    /<ColumnListItem type="\{= \$\{cr>status\} === 'draft' \? 'Navigation' : 'Inactive' \}">/u
  );
});

// Hiding it is courtesy, the service checks the scope. Since the Duplicate Rules button moved to
// the MDM Rules tile, this is the last steward-gated action on the list report.
test('the change requests button is hidden from anyone without the steward scope', () => {
  assert.equal(listActions.ChangeRequests.visible, '{perm>/isDataSteward}');
});

// Consequence worth pinning: with the list steward-only, a requester cannot reach their own
// saved draft. Accepted while only the team creates them — this test is the reminder.
test('the only route to a saved draft is the steward-gated list', () => {
  const customActions = read('ext', 'CustomActions.js');
  assert.match(customActions, /openChangeRequests: function \(\) \{\s*navigate\("ChangeRequests"\);/u);
  const routes = manifest['sap.ui5'].routing.routes.map((route) => route.pattern);
  assert.ok(routes.includes('ChangeRequests/{changeRequest}/edit'));
  assert.ok(routes.includes('ChangeRequests'));
});
