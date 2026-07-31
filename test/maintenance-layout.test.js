'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webapp = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');

test('maintenance uses one Object Page layout for create, preview and edit', () => {
  const view = fs.readFileSync(
    path.join(webapp, 'ext', 'view', 'BusinessPartnerMaintenance.view.xml'),
    'utf8'
  );

  assert.match(view, /<uxap:ObjectPageLayout/);
  assert.match(view, /title="General Information"/);
  assert.match(view, /title="Names"/);
  assert.match(view, /title="Addresses"/);
  assert.match(view, /title="Customer Data"/);
  assert.match(view, /title="Supplier Data"/);
  assert.match(view, /text="Edit Business Partner"/);
  assert.doesNotMatch(view, /<IconTabBar/);
});

test('primary cards stay concise while every root field remains accessible', () => {
  const controller = fs.readFileSync(
    path.join(webapp, 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );

  assert.match(controller, /GENERAL_FIELDS/);
  assert.match(controller, /NAME_FIELDS/);
  assert.match(controller, /Additional Business Partner Fields/);
  assert.match(controller, /this\._rootSection\.fields\.filter/);
});
