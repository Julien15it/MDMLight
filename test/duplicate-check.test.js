'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  activeRules,
  candidateFromStagedRequest,
  checkAgainstPartners,
  duplicateFindings
} = require('../srv/ai/duplicate-check');
const { VERDICTS } = require('../srv/ai/duplicate-engine');
const { createNameIndex } = require('../srv/ai/name-index');

test('the staged request becomes a candidate the engine can read', () => {
  const candidate = candidateFromStagedRequest(
    {
      ID: 'row-uuid',
      request_ID: 'req-uuid',
      action: 'C',
      OrganizationBPName1: 'Alluvion',
      BusinessPartnerCategory: '2'
    },
    {
      Addresses: [{ Country: 'BE', PostalCode: '9000' }],
      TaxNumbers: [{ BPTaxType: 'BE0', BPTaxNumber: 'BE0666471360' }],
      BusinessPartnerRoles: [{ BusinessPartnerRole: 'FLCU01' }],
      BankDetails: []
    }
  );
  assert.equal(candidate.ID, undefined, 'staging keys never reach the engine');
  assert.equal(candidate.request_ID, undefined);
  assert.equal(candidate.action, undefined);
  assert.equal(candidate.OrganizationBPName1, 'Alluvion');
  assert.equal(candidate.addresses[0].Country, 'BE');
  assert.equal(candidate.taxNumbers[0].BPTaxNumber, 'BE0666471360');
  assert.equal(candidate.roles[0].BusinessPartnerRole, 'FLCU01');
});

test('a staged record finds the partner it duplicates', () => {
  const found = checkAgainstPartners(
    candidateFromStagedRequest(
      { OrganizationBPName1: 'Alluvion', BusinessPartnerCategory: '2' },
      { TaxNumbers: [{ BPTaxType: 'BE0', BPTaxNumber: 'BE0666471360' }] }
    ),
    [
      { BusinessPartner: '5', OrganizationBPName1: 'Something Else', taxNumbers: [{ BPTaxNumber: 'BE0666471360' }] },
      { BusinessPartner: '9', OrganizationBPName1: 'Nothing Alike' }
    ]
  );
  assert.deepEqual(found.map((row) => row.partner.BusinessPartner), ['5']);
  assert.equal(found[0].verdict, VERDICTS.DUPLICATE);
});

test('findings carry the verdict and the severity separately', () => {
  const [finding] = duplicateFindings([{
    partner: { BusinessPartner: '5' },
    verdict: VERDICTS.DUPLICATE,
    score: 0.923456,
    indicators: [{ field: 'Name', comparison: 'fuzzy', indicator: 'definitive', score: 0.923456 }]
  }]);
  assert.equal(finding.checkName, 'duplicate_check');
  assert.equal(finding.severity, 'error');
  assert.equal(finding.verdict, VERDICTS.DUPLICATE);
  assert.equal(finding.candidateBP, '5');
  assert.equal(finding.score, 0.9235);
  assert.match(finding.message, /Duplicate: Business Partner 5 matches on Name \(fuzzy\)/u);
});

test('a lesser verdict does not raise an error the approver must clear', () => {
  const severities = [VERDICTS.STRONG, VERDICTS.SMALL].map((verdict) => duplicateFindings([{
    partner: { BusinessPartner: '7' }, verdict, score: 0.9, indicators: []
  }])[0].severity);
  assert.deepEqual(severities, ['warning', 'info']);
});

test('the index and the fallback read run the same rules', async () => {
  const partners = [
    { BusinessPartner: '1', OrganizationBPName1: 'Alluvion NV' },
    { BusinessPartner: '2', OrganizationBPName1: 'Nothing Alike' }
  ];
  const index = createNameIndex();
  await index.refresh(async () => partners);

  const viaIndex = index.match({ Name: 'Alluvion' }, { rules: activeRules() });
  const viaRead = checkAgainstPartners({ Name: 'Alluvion' }, partners);
  assert.deepEqual(
    viaIndex.map((row) => [row.partner.BusinessPartner, row.verdict]),
    viaRead.map((row) => [row.partner.BusinessPartner, row.verdict])
  );
  assert.equal(viaIndex[0].verdict, VERDICTS.DUPLICATE);
});
