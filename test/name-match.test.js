'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DUPLICATE_THRESHOLD,
  companyFingerprint,
  partnerFingerprints,
  scoreFingerprint,
  rankDuplicates
} = require('../srv/ai/name-match');

const entriesFor = (partners) => partners.map((partner) => ({
  partner,
  fingerprints: partnerFingerprints(partner)
}));

test('strips legal forms and punctuation so variants share a fingerprint', () => {
  assert.equal(companyFingerprint('Coca-Cola European Partners NV'), 'cocacolaeuropeanpartners');
  assert.equal(companyFingerprint('Coca Cola European Partners'), 'cocacolaeuropeanpartners');
  assert.equal(companyFingerprint('Alluvion BVBA'), 'alluvion');
});

test('collects one fingerprint per distinct name field', () => {
  assert.deepEqual(partnerFingerprints({
    BusinessPartnerFullName: 'Alluvion NV',
    BusinessPartnerName: 'Alluvion',
    OrganizationBPName1: 'Alluvion Consulting'
  }), ['alluvion', 'alluvionconsulting']);
  assert.deepEqual(partnerFingerprints({}), []);
});

test('the threshold was raised from 0.82 for full-index scans', () => {
  assert.equal(DUPLICATE_THRESHOLD, 0.86);
});

test('scores a one-letter spelling variant above the threshold', () => {
  const score = scoreFingerprint('alluvion', 'aluvion');
  assert.ok(score >= DUPLICATE_THRESHOLD, `expected >= ${DUPLICATE_THRESHOLD}, got ${score}`);
});

test('short names must match exactly because Dice is noisy below five characters', () => {
  assert.equal(scoreFingerprint('acme', 'acmi'), 0);
  assert.equal(scoreFingerprint('acme', 'acme'), 1);
});

test('ranks by score and caps the shortlist', () => {
  const partners = [
    { BusinessPartner: '1', OrganizationBPName1: 'Alluvion' },
    { BusinessPartner: '2', OrganizationBPName1: 'Aluvion NV' },
    { BusinessPartner: '3', OrganizationBPName1: 'Something Else' }
  ];
  const ranked = rankDuplicates('Alluvion BV', entriesFor(partners));

  assert.deepEqual(ranked.map(({ partner }) => partner.BusinessPartner), ['1', '2']);
  assert.equal(ranked[0].score, 1);
  assert.equal(rankDuplicates('Alluvion', entriesFor(partners), { limit: 1 }).length, 1);
});

test('an unusable name matches nothing', () => {
  assert.deepEqual(rankDuplicates('NV', entriesFor([{ OrganizationBPName1: 'Alluvion' }])), []);
  assert.deepEqual(rankDuplicates('', entriesFor([{ OrganizationBPName1: 'Alluvion' }])), []);
});
