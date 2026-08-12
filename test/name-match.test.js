'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DUPLICATE_THRESHOLD,
  companyFingerprint,
  partnerFingerprints,
  scoreFingerprint
} = require('../srv/ai/name-match');
const { checkAgainstPartners } = require('../srv/ai/duplicate-check');

// Ranking moved to the engine; these pin that the name scoring still drives it the same way.
const rankByName = (name, partners, options) => checkAgainstPartners({ Name: name }, partners, options);

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

test('ranks by score, returns every match, and still honours an explicit limit', () => {
  const partners = [
    { BusinessPartner: '1', OrganizationBPName1: 'Alluvion' },
    { BusinessPartner: '2', OrganizationBPName1: 'Aluvion NV' },
    { BusinessPartner: '3', OrganizationBPName1: 'Something Else' }
  ];
  const ranked = rankByName('Alluvion BV', partners);

  assert.deepEqual(ranked.map(({ partner }) => partner.BusinessPartner), ['1', '2']);
  assert.equal(ranked[0].score, 1);
  assert.equal(rankByName('Alluvion', partners, { limit: 1 }).length, 1);
});

// The sandbox holds more Alluvion rows than the old limit of 5 ever showed.
test('every match is returned, not a shortlist', () => {
  const partners = Array.from({ length: 12 }, (unused, index) => ({
    BusinessPartner: String(index + 1),
    OrganizationBPName1: 'Alluvion'
  }));
  assert.equal(rankByName('Alluvion', partners).length, 12);
});

test('an unusable name matches nothing', () => {
  assert.deepEqual(rankByName('NV', [{ OrganizationBPName1: 'Alluvion' }]), []);
  assert.deepEqual(rankByName('', [{ OrganizationBPName1: 'Alluvion' }]), []);
});
