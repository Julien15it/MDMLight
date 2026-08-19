'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ChangeRequestService = require('../srv/change-request-service');
const {
  approveUrl,
  reworkUrl,
  buildBusinessPartnerInput,
  activeStagedRows,
  SUPPORTED_REQUEST_TYPES,
  FINDING_COLUMNS,
  stagedFinding,
  resolveRelationNumber
} = ChangeRequestService._internals;

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

test('resolveRelationNumber reads the real Customer/Supplier number via navigation, not the BP number', async () => {
  // The exact scenario reported live: BusinessPartner 249 has Customer 6 -
  // a system where CVI does not use the same number range for both.
  let requestedPath;
  const s4 = { send: async (request) => { requestedPath = request.path; return { Customer: '6' }; } };

  const result = await resolveRelationNumber(s4, '249', 'Customer');

  assert.equal(requestedPath, "/A_BusinessPartner('249')/to_Customer");
  assert.equal(result, '6');
});

test('resolveRelationNumber returns null when the navigation has no target', async () => {
  const s4 = { send: async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); } };
  assert.equal(await resolveRelationNumber(s4, '249', 'Supplier'), null);
});

test('resolveRelationNumber passes the BusinessPartner number straight through for any other relation field', async () => {
  const s4 = { send: async () => { throw new Error('must not be called'); } };
  assert.equal(await resolveRelationNumber(s4, '249', 'BusinessPartner'), '249');
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

/**
 * The managed approuter serves the app through Work Zone, so a deep link is the site URL plus a
 * cross-navigation intent - not the standalone approuter's `<host>/<app>/index.html#<route>`, which
 * 404s since that module was removed. WORKZONE_URL replaced APPROUTER_URL so the stale value left
 * on the deployed app cannot resurrect the dead host.
 */
const SITE = 'https://alluvion.launchpad.cfapps.eu10-004.hana.ondemand.com/site';

function withWorkzoneUrl(value, run) {
  const original = process.env.WORKZONE_URL;
  if (value === undefined) delete process.env.WORKZONE_URL;
  else process.env.WORKZONE_URL = value;
  try {
    run();
  } finally {
    if (original === undefined) delete process.env.WORKZONE_URL;
    else process.env.WORKZONE_URL = original;
  }
}

// A missing link is diagnosable; a link to a host that no longer exists is not.
test('approveUrl degrades to an empty string without a Work Zone site URL', () => {
  withWorkzoneUrl(undefined, () => {
    assert.equal(approveUrl('11111111-1111-1111-1111-111111111111'), '');
    assert.equal(reworkUrl('11111111-1111-1111-1111-111111111111'), '');
  });
});

test('the deep links are Work Zone intents, not standalone approuter paths', () => {
  withWorkzoneUrl(SITE, () => {
    assert.equal(
      approveUrl('11111111-1111-1111-1111-111111111111'),
      `${SITE}#BusinessPartner-manage&/ChangeRequests/11111111-1111-1111-1111-111111111111/approve`
    );
    assert.equal(
      reworkUrl('11111111-1111-1111-1111-111111111111'),
      `${SITE}#BusinessPartner-manage&/ChangeRequests/11111111-1111-1111-1111-111111111111/rework`
    );
    // The shape that 404'd: an app path plus index.html belongs to the removed standalone approuter.
    assert.equal(/index\.html/u.test(approveUrl('x')), false);
  });
});

// The intent has to match the inbound in the partner app's manifest, or the link resolves to nothing.
test('the intent matches the app inbound', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'app', 'businesspartner', 'webapp', 'manifest.json'), 'utf8'
  ));
  const inbound = manifest['sap.app'].crossNavigation.inbounds['BusinessPartner-manage'];
  assert.ok(inbound, 'the inbound exists');
  withWorkzoneUrl(SITE, () => {
    assert.ok(approveUrl('x').includes(`#${inbound.semanticObject}-${inbound.action}&/`));
  });
});

test('a trailing slash on the site URL does not double up', () => {
  withWorkzoneUrl(SITE + '/', () => {
    assert.equal(
      approveUrl('cr-1'),
      `${SITE}#BusinessPartner-manage&/ChangeRequests/cr-1/approve`
    );
  });
});

// block and delete are reserved: they would stage cleanly and then mean nothing to postToS4.
test('only the request types that can reach S/4 are accepted', () => {
  assert.deepEqual([...SUPPORTED_REQUEST_TYPES], ['create', 'change']);
  const staging = fs.readFileSync(path.join(__dirname, '..', 'db', 'staging.cds'), 'utf8');
  assert.match(staging, /enum \{ create; change; block; delete \}/u);
  for (const reserved of ['block', 'delete']) {
    assert.equal(SUPPORTED_REQUEST_TYPES.includes(reserved), false);
  }
});

// candidateName and reasons travel to the SPA payload but are not columns: spreading a finding
// straight into the insert would fail on them.
test('only real CheckFindings columns are staged', () => {
  const staged = stagedFinding({
    checkName: 'duplicate_check',
    severity: 'error',
    verdict: 'duplicate',
    message: 'Duplicate: Business Partner 4711 matches on Name (exact).',
    candidateBP: '4711',
    candidateRequest: null,
    score: 0.9235,
    candidateName: 'Alluvion NV',
    reasons: ['Name (exact)']
  });
  assert.equal(staged.candidateName, undefined);
  assert.equal(staged.reasons, undefined);
  assert.equal(staged.candidateBP, '4711');
  assert.equal(staged.verdict, 'duplicate');
  assert.equal(Object.keys(staged).every((key) => FINDING_COLUMNS.includes(key)), true);
});

// A resubmit supersedes the previous findings rather than deleting them, so serving every set at
// once made one duplicate pair read as several. isStale was written and never read.
test('only current findings are exposed, and a row with no value counts as current', () => {
  const cds = fs.readFileSync(path.join(__dirname, '..', 'srv', 'change-request-service.cds'), 'utf8');
  assert.match(cds, /where isStale is null or isStale = false/u);
});
