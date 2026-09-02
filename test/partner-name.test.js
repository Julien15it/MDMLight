'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { fullNameOf, withFullName } = require('../srv/partner-name');
const { ROOT_CREATE_EXCLUDED_FIELDS } = require('../srv/business-partner-service')._internals;

test('the category decides which name fields are read', () => {
  const root = {
    BusinessPartnerCategory: '1',
    FirstName: 'Maarten', LastName: 'Eylenbosch',
    OrganizationBPName1: 'Alluvion'
  };
  // S/4 discards name fields that do not match the category, so neither may this.
  assert.equal(fullNameOf(root), 'Maarten Eylenbosch');
  assert.equal(fullNameOf({ ...root, BusinessPartnerCategory: '2' }), 'Alluvion');
});

test('a person keeps the middle name, a group both its names', () => {
  assert.equal(
    fullNameOf({ BusinessPartnerCategory: '1', FirstName: 'A', MiddleName: 'B', LastName: 'C' }),
    'A B C'
  );
  assert.equal(
    fullNameOf({
      BusinessPartnerCategory: '3',
      GroupBusinessPartnerName1: 'Alluvion', GroupBusinessPartnerName2: 'Group'
    }),
    'Alluvion Group'
  );
});

// Better named than blank: this labels a request somebody is about to read.
test('a category whose own fields are empty falls through the others', () => {
  assert.equal(fullNameOf({ BusinessPartnerCategory: '2', FirstName: 'Maarten' }), 'Maarten');
  assert.equal(fullNameOf({ BusinessPartnerCategory: '9', OrganizationBPName1: 'Alluvion' }), 'Alluvion');
  assert.equal(fullNameOf({ OrganizationBPName1: 'Alluvion', OrganizationBPName2: 'NV' }), 'Alluvion NV');
});

test('blank components do not leave stray spaces', () => {
  assert.equal(
    fullNameOf({ BusinessPartnerCategory: '2', OrganizationBPName1: 'Alluvion', OrganizationBPName2: '' }),
    'Alluvion'
  );
  assert.equal(
    fullNameOf({ BusinessPartnerCategory: '1', FirstName: 'A', MiddleName: null, LastName: 'C' }),
    'A C'
  );
});

// A change request over an existing partner carries S/4's own value; composing over it would replace
// what S/4 says with a guess.
test('a name S/4 already derived is never overwritten', () => {
  const row = withFullName({
    BusinessPartnerCategory: '2',
    OrganizationBPName1: 'Alluvion',
    BusinessPartnerFullName: 'Alluvion NV (as S/4 has it)'
  });
  assert.equal(row.BusinessPartnerFullName, 'Alluvion NV (as S/4 has it)');
  // A blank one is not a value, so it is composed.
  assert.equal(
    withFullName({ BusinessPartnerCategory: '2', OrganizationBPName1: 'Alluvion', BusinessPartnerFullName: '  ' })
      .BusinessPartnerFullName,
    'Alluvion'
  );
});

// --- Wiring ---------------------------------------------------------------------------------

const root = (...segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');

test('the workflow row is composed, and the staged payload is not', () => {
  const service = root('srv', 'change-request-service.js');
  assert.match(service, /A_BusinessPartner: withFullName\(withBusinessPartner\(general\)\)/u);
  // Never on the way in: a value on the staged root would be forwarded to S/4 on the post.
  assert.equal(/withFullName\(payload/u.test(service), false);
  assert.equal(/withFullName\(.*stageable/u.test(service), false);
});

// S/4 marks it sap:creatable="false", so a create carrying it is a create S/4 rejects.
test('the derived name can never travel to S/4 on a create either', () => {
  assert.ok(ROOT_CREATE_EXCLUDED_FIELDS.has('BusinessPartnerFullName'));
  assert.ok(ROOT_CREATE_EXCLUDED_FIELDS.has('BusinessPartnerName'));
  assert.match(
    root('srv', 'business-partner-service.js'),
    /excluded: isCreate \? ROOT_CREATE_EXCLUDED_FIELDS : ROOT_UPDATE_EXCLUDED_FIELDS/u
  );
});

// One composed name, so the search list and the approver's task cannot disagree about a request.
test('the search list composes the same name as the workflow', () => {
  const searchResults = root('srv', 'search-results.js');
  assert.match(searchResults, /const \{ fullNameOf \} = require\('\.\/partner-name'\);/u);
  assert.match(searchResults, /const stagedFullName = fullNameOf;/u);
});
