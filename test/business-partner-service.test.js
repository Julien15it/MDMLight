'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');

const BusinessPartnerService = require('../srv/business-partner-service');
const {
  SEARCHABLE_FIELDS,
  applyBusinessPartnerSearch,
  pickDefined,
  validateBusinessPartnerCreate
} = BusinessPartnerService._internals;

test('converts Fiori free-text search to S/4-compatible contains filters', () => {
  const query = {
    SELECT: {
      from: { ref: ['BusinessPartnerService.BusinessPartners'] },
      search: [{ val: 'Acme Brussels' }],
      where: [{ ref: ['BusinessPartnerCategory'] }, '=', { val: '2' }]
    }
  };

  applyBusinessPartnerSearch(query);

  assert.equal(query.SELECT.search, undefined);
  assert.deepEqual(query.SELECT.where.slice(0, 3), [
    { xpr: [{ ref: ['BusinessPartnerCategory'] }, '=', { val: '2' }] },
    'and',
    { xpr: query.SELECT.where[2].xpr }
  ]);

  const serialized = JSON.stringify(query.SELECT.where[2]);
  assert.match(serialized, /Acme/);
  assert.match(serialized, /Brussels/);
  for (const field of SEARCHABLE_FIELDS) assert.match(serialized, new RegExp(field));
});

test('serializes the rewritten search as an OData V2 substring filter', async () => {
  const model = await cds.load('srv/external/API_BUSINESS_PARTNER');
  const query = cds.ql.SELECT
    .from('API_BUSINESS_PARTNER.A_BusinessPartner')
    .columns('BusinessPartner')
    .limit(20);

  query.SELECT.search = [{ val: "O'Hara" }];
  applyBusinessPartnerSearch(query);

  const request = cds.odata.urlify(query, {
    kind: 'odata-v2',
    model,
    method: 'GET'
  });

  assert.equal(request.method, 'GET');
  assert.match(request.path, /^A_BusinessPartner\?/);
  assert.match(request.path, /\$filter=/);
  assert.match(request.path, /substringof\('O''Hara',BusinessPartner\)/);
});

test('accepts a valid organization create payload', () => {
  assert.deepEqual(validateBusinessPartnerCreate({
    BusinessPartnerCategory: '2',
    BusinessPartnerGrouping: '0001',
    OrganizationBPName1: 'Alluvion Test'
  }), []);
});

test('reports missing create fields with UI targets', () => {
  assert.deepEqual(validateBusinessPartnerCreate({
    BusinessPartnerCategory: '1'
  }), [
    {
      target: 'BusinessPartnerGrouping',
      message: 'Enter a business partner grouping.'
    },
    {
      target: 'LastName',
      message: 'Enter the last name for a person.'
    }
  ]);
});

test('only forwards supported, defined fields to S/4 maintenance operations', () => {
  assert.deepEqual(
    pickDefined(
      {
        SearchTerm1: 'NEW',
        BusinessPartnerIsBlocked: false,
        BusinessPartnerGrouping: undefined,
        UnexpectedField: 'must not be forwarded'
      },
      ['SearchTerm1', 'BusinessPartnerIsBlocked', 'BusinessPartnerGrouping']
    ),
    {
      SearchTerm1: 'NEW',
      BusinessPartnerIsBlocked: false
    }
  );
});
