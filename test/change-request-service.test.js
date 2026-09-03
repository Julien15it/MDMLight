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
  resolveRelationNumber,
  resolveEffectiveRole,
  currentStepAssignee
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
        BusinessPartnerCategory: { type: 'cds.String' },
        OrganizationBPName1: { type: 'cds.String' },
        FirstName: { type: 'cds.String' },
        LastName: { type: 'cds.String' },
        // The shape is driven by the REMOTE entity's elements, so a field missing from this mock can
        // never appear however the row is built. The live A_BusinessPartner has it, and has been
        // sending it as a blank all along - which is the whole point of composing a value for it.
        BusinessPartnerFullName: { type: 'cds.String' }
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
  // S/4 derives the full name and has never seen this partner, and staging holds no such column -
  // so it is composed here, or the approver's task shows a blank where the name should be.
  assert.equal(result.A_BusinessPartner.businessPartnerFullName, 'Test 0608');
});

test('the composed full name follows the category, and survives an empty record', async () => {
  const person = await buildBusinessPartnerInput(stagingDb({
    StagedGeneral: [{
      BusinessPartnerCategory: '1',
      FirstName: 'Maarten',
      LastName: 'Eylenbosch',
      OrganizationBPName1: 'Ignored For A Person'
    }]
  }), s4Mock, { ID: 'cr-3', businessPartner: null });
  assert.equal(person.A_BusinessPartner.businessPartnerFullName, 'Maarten Eylenbosch');

  // Nothing to compose from is still a blank, not a crash or a stray space.
  const empty = await buildBusinessPartnerInput(stagingDb({ StagedGeneral: [{}] }), s4Mock, {
    ID: 'cr-4', businessPartner: null
  });
  assert.equal(empty.A_BusinessPartner.businessPartnerFullName, '');
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
const SITE = 'https://alluvion-dev-cf.launchpad.cfapps.eu10.hana.ondemand.com/site?siteId=988d11c0-0c6c-42f2-840d-f8875105417b';

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

/**
 * Site Manager hands you the URL ending in `#Shell-home`, so that is what gets pasted into
 * WORKZONE_URL. Keeping both hashes would resolve to the launchpad home instead of the request.
 */

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

// --- Disambiguating which of a user's several approver-shaped roles applies (2026-09-02) ---------

test('currentStepAssignee indexes the stored sequence by approvalsReceived', () => {
  assert.equal(
    currentStepAssignee({
      approverSequenceJson: JSON.stringify(['Approver Sales', 'Approver Finance']),
      approvalsReceived: 0
    }),
    'Approver Sales'
  );
  assert.equal(
    currentStepAssignee({
      approverSequenceJson: JSON.stringify(['Approver Sales', 'Approver Finance']),
      approvalsReceived: 1
    }),
    'Approver Finance'
  );
  // Missing approvalsReceived reads as 0, the same default decideRequest itself uses.
  assert.equal(
    currentStepAssignee({ approverSequenceJson: JSON.stringify(['Approver Sales']) }),
    'Approver Sales'
  );
});

test('currentStepAssignee answers null rather than throwing on anything it cannot use', () => {
  assert.equal(currentStepAssignee(null), null);
  assert.equal(currentStepAssignee({}), null);
  assert.equal(currentStepAssignee({ approverSequenceJson: 'not json' }), null);
  assert.equal(currentStepAssignee({ approverSequenceJson: JSON.stringify({ not: 'an array' }) }), null);
  // Past the end of the sequence - should not happen (decideRequest never lets approvalsReceived
  // exceed requiredApprovals), but a request from before either column existed could disagree.
  assert.equal(
    currentStepAssignee({ approverSequenceJson: JSON.stringify(['Approver Sales']), approvalsReceived: 5 }),
    null
  );
});

/**
 * "Stel een user heeft 2 rollen, dat is er altijd 1 overheersende rol... is er een manier dat jij dit
 * kan onthouden in welke stap de user zit?" (2026-09-02, asked for). A user holding two approver-
 * shaped roles cannot be disambiguated by `specificRoleFor` alone (it returns null on purpose rather
 * than guess) - resolveEffectiveRole now asks "is it THIS user's turn on THIS request" first, using
 * the request's own stored approver sequence. The user-branch (an `@` entry) needs no BTP call at
 * all, so it is fully testable without mocking btp-agents.
 */
test('resolveEffectiveRole picks the current step\'s assignee when it names this exact user', async () => {
  const req = { user: { attr: { email: 'maarten@alluvion.eu' } }, data: {} };
  const header = {
    approverSequenceJson: JSON.stringify(['maarten@alluvion.eu', 'julien@alluvion.eu']),
    approvalsReceived: 0
  };
  assert.equal(await resolveEffectiveRole(req, 'Approver', header), 'maarten@alluvion.eu');
});

test('resolveEffectiveRole ignores a step assignee that is not the current user', async () => {
  // No BTP binding in this test environment, so the role-branch (isMemberOfRole) resolves false and
  // the email-branch is a plain string mismatch either way - both fall through to specificRoleFor,
  // which itself falls back to the bare category with no BTP service bound.
  const req = { user: { attr: { email: 'someone-else@alluvion.eu' } }, data: {} };
  const header = {
    approverSequenceJson: JSON.stringify(['maarten@alluvion.eu']),
    approvalsReceived: 0
  };
  assert.equal(await resolveEffectiveRole(req, 'Approver', header), 'Approver');
});

test('resolveEffectiveRole with no header falls back to the role-only resolution, unchanged', async () => {
  const req = { user: { attr: { email: 'maarten@alluvion.eu' } }, data: {} };
  assert.equal(await resolveEffectiveRole(req, 'Approver', null), 'Approver');
  assert.equal(await resolveEffectiveRole(req, 'Requester', null), 'Requester');
});
