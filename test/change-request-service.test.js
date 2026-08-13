'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ChangeRequestService = require('../srv/change-request-service');
const { approveUrl, buildBusinessPartnerInput, activeStagedRows } = ChangeRequestService._internals;

/** Fakes `db.run` against the staging tables, keyed by their bare entity name. */
function stagingDb(tables) {
  return {
    run: async (query) => {
      const from = query?.SELECT?.from;
      const ref = Array.isArray(from?.ref) ? from.ref[from.ref.length - 1] : from;
      const name = String(ref).split('.').pop();
      const rows = tables[name] || [];
      return query?.SELECT?.one ? (rows[0] || null) : rows;
    }
  };
}

const s4Mock = {
  entities: {
    A_BusinessPartner: {
      elements: {
        BusinessPartner: { type: 'cds.String' },
        OrganizationBPName1: { type: 'cds.String' }
      }
    },
    A_BusinessPartnerAddress: {
      elements: {
        BusinessPartner: { type: 'cds.String' },
        AddressID: { type: 'cds.String' },
        CityName: { type: 'cds.String' }
      }
    },
    A_BusinessPartnerRole: {
      elements: {
        BusinessPartner: { type: 'cds.String' },
        BusinessPartnerRole: { type: 'cds.String' }
      }
    }
  }
};

test('activeStagedRows drops rows staged for deletion', async () => {
  const db = stagingDb({
    StagedAddresses: [
      { action: 'C', AddressID: '1' },
      { action: 'D', AddressID: '2' },
      { action: 'U', AddressID: '3' }
    ]
  });
  const rows = await activeStagedRows(db, 'mdmlight.staging.StagedAddresses', 'cr-1');
  assert.deepEqual(rows.map((row) => row.AddressID), ['1', '3']);
});

test('buildBusinessPartnerInput shapes staged rows for a create request (no BusinessPartner yet)', async () => {
  const db = stagingDb({
    StagedGeneral: [{ OrganizationBPName1: 'Test 0608' }],
    StagedAddresses: [{ action: 'C', AddressID: null, CityName: 'Gent' }],
    StagedRoles: [{ action: 'C', BusinessPartnerRole: 'FLVN00' }]
  });
  const header = { ID: 'cr-1', businessPartner: null };

  const result = await buildBusinessPartnerInput(db, s4Mock, header);

  assert.equal(result.A_BusinessPartner.organizationBPName1, 'Test 0608');
  // No BusinessPartner known yet for a create - must not be backfilled.
  assert.equal(result.A_BusinessPartner.businessPartner, '');
  assert.equal(result.A_BusinessPartnerAddress[0].cityName, 'Gent');
  assert.equal(result.A_BusinessPartnerAddress[0].businessPartner, '');
  assert.equal(result.A_BusinessPartnerRole[0].businessPartnerRole, 'FLVN00');
});

test('buildBusinessPartnerInput backfills the known BusinessPartner onto staged child rows for a change request', async () => {
  const db = stagingDb({
    StagedGeneral: [{}],
    StagedAddresses: [{ action: 'U', AddressID: '1', CityName: 'Antwerpen' }]
  });
  const header = { ID: 'cr-2', businessPartner: '561' };

  const result = await buildBusinessPartnerInput(db, s4Mock, header);

  assert.equal(result.A_BusinessPartner.businessPartner, '561');
  assert.equal(result.A_BusinessPartnerAddress[0].businessPartner, '561');
  assert.equal(result.A_BusinessPartnerAddress[0].addressID, '1');
});

test('approveUrl degrades to an empty string without an approuter route (local/hybrid dev)', () => {
  const original = process.env.APPROUTER_URL;
  delete process.env.APPROUTER_URL;
  try {
    assert.equal(approveUrl('11111111-1111-1111-1111-111111111111'), '');
  } finally {
    if (original === undefined) delete process.env.APPROUTER_URL;
    else process.env.APPROUTER_URL = original;
  }
});

test('approveUrl builds a deep link to the ChangeRequestApprove route', () => {
  const original = process.env.APPROUTER_URL;
  process.env.APPROUTER_URL = 'https://alluvion-dev-cf-dev-mdm-businesspartner-approuter.cfapps.eu10-004.hana.ondemand.com';
  try {
    assert.equal(
      approveUrl('11111111-1111-1111-1111-111111111111'),
      'https://alluvion-dev-cf-dev-mdm-businesspartner-approuter.cfapps.eu10-004.hana.ondemand.com/mdmmdbusinesspartnermanage/index.html#ChangeRequests/11111111-1111-1111-1111-111111111111/approve'
    );
  } finally {
    if (original === undefined) delete process.env.APPROUTER_URL;
    else process.env.APPROUTER_URL = original;
  }
});

test('approveUrl tolerates a trailing slash on APPROUTER_URL', () => {
  const original = process.env.APPROUTER_URL;
  process.env.APPROUTER_URL = 'https://example.cfapps.eu10-004.hana.ondemand.com/';
  try {
    assert.equal(
      approveUrl('cr-1'),
      'https://example.cfapps.eu10-004.hana.ondemand.com/mdmmdbusinesspartnermanage/index.html#ChangeRequests/cr-1/approve'
    );
  } finally {
    if (original === undefined) delete process.env.APPROUTER_URL;
    else process.env.APPROUTER_URL = original;
  }
});
