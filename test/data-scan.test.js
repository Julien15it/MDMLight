'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_PARTNERS, sectionsUsedBy, runnableRules, describeRule, scanValidationRules
} = require('../srv/checks/data-scan');

// An empty CSN: `resolvePayloadField` accepts any qualified name when the model carries no elements,
// which is what lets these run without loading the CAP model - see payload-fields.js.
const MODEL = { definitions: {} };

const partners = [
  { BusinessPartner: '1', BusinessPartnerCategory: '2' },
  { BusinessPartner: '2', BusinessPartnerCategory: '2' }
];

const addresses = new Map([
  ['1', [{ Country: 'BE', Region: 'VOV' }]],
  ['2', [{ Country: 'NL' }]]
]);

const readers = ({ sections = { Addresses: addresses }, rows = partners } = {}) => ({
  readPartners: async () => rows,
  readSection: async (section) => sections[section] || new Map()
});

const requiredRegion = {
  isActive: true,
  field: 'Addresses.Region',
  comparison: 'notEmpty',
  severity: 'error',
  conditionField: 'Addresses.Country',
  conditionValue: 'BE'
};

test('only the sections a ruleset actually reads are fetched', () => {
  const sections = sectionsUsedBy([
    { field: 'Addresses.Region', conditionField: 'BusinessPartnerRoles.BusinessPartnerRole' },
    // General is the payload root and arrives with the partner itself, so it is never a section read.
    { field: 'General.Language' }
  ], MODEL);
  assert.deepEqual(sections.sort(), ['Addresses', 'BusinessPartnerRoles']);
});

test('a rule that would not run is left out and counted, not run anyway', () => {
  const rules = [
    requiredRegion,
    { ...requiredRegion, isActive: false },
    // No comparison: incomplete, so it cannot be evaluated against anything.
    { isActive: true, field: 'Addresses.Region' }
  ];
  assert.equal(runnableRules(rules, MODEL).length, 1);
});

test('a rule is named by the sentence it reads as, since a validation rule has no name column', () => {
  assert.equal(
    describeRule(requiredRegion),
    'where Addresses.Country = BE: Addresses.Region notEmpty'
  );
  // The condition's own comparator since 2026-09-02, not a hardcoded `=`: a report naming a `!=`
  // rule as `=` would be describing a rule nobody wrote. A blank operator still reads as `=`.
  assert.equal(
    describeRule({ ...requiredRegion, conditionOperator: 'ne' }),
    'where Addresses.Country != BE: Addresses.Region notEmpty'
  );
  assert.equal(
    describeRule({
      ...requiredRegion, conditionOperator: 'notEmpty', conditionValue: ''
    }),
    'where Addresses.Country is not empty: Addresses.Region notEmpty'
  );
});

test('the scan reports findings per rule, and how many partners each one flags', async () => {
  const report = await scanValidationRules({
    rules: [requiredRegion],
    model: MODEL,
    ...readers()
  });

  assert.equal(report.scanned, 2);
  // Partner 1 is Belgian and has a region; partner 2 is Dutch, so the condition never holds.
  assert.equal(report.counts.error, 0);
  assert.equal(report.flaggedPartners, 0);
  assert.equal(report.rules.length, 1);
  assert.equal(report.rules[0].findings, 0);
});

test('a partner the rule fires on is counted once and sampled with its message', async () => {
  const sections = {
    Addresses: new Map([
      ['1', [{ Country: 'BE' }, { Country: 'BE' }]],
      ['2', [{ Country: 'NL' }]]
    ])
  };
  const report = await scanValidationRules({
    rules: [requiredRegion],
    model: MODEL,
    ...readers({ sections })
  });

  // Two Belgian addresses without a region is two findings, but one flagged partner - the two are
  // different news, so the report carries both.
  assert.equal(report.rules[0].findings, 2);
  assert.equal(report.rules[0].partners, 1);
  assert.equal(report.flaggedPartners, 1);
  assert.equal(report.counts.error, 2);
  assert.equal(report.rules[0].samples[0].businessPartner, '1');
  assert.match(report.rules[0].samples[0].message, /is required/u);
});

test('the loudest rule leads, so the one flagging half the estate is the one read first', async () => {
  const alwaysFires = {
    isActive: true, field: 'General.BusinessPartnerCategory', comparison: 'eq', value: '1',
    severity: 'warning'
  };
  const report = await scanValidationRules({
    rules: [requiredRegion, alwaysFires],
    model: MODEL,
    ...readers()
  });
  assert.equal(report.rules[0].findings, 2);
  assert.equal(report.counts.warning, 2);
});

test('a section that could not be read is named, never reported as nothing found', async () => {
  const report = await scanValidationRules({
    rules: [requiredRegion],
    model: MODEL,
    readPartners: async () => partners,
    readSection: async () => { throw new Error('destination unreachable'); }
  });
  assert.deepEqual(report.unavailable.map((entry) => entry.section), ['Addresses']);
  assert.match(report.unavailable[0].reason, /unreachable/u);
});

test('too many partners is refused rather than answered on a slice of them', async () => {
  const many = Array.from({ length: 3 }, (unused, index) => ({ BusinessPartner: String(index) }));
  const report = await scanValidationRules({
    rules: [requiredRegion],
    model: MODEL,
    maxPartners: 2,
    ...readers({ rows: many })
  });
  assert.equal(report.tooLarge, true);
  assert.equal(report.limit, 2);
  assert.equal(report.rules.length, 0);
});

test('no runnable rule reports itself rather than reading the population for nothing', async () => {
  let read = false;
  const report = await scanValidationRules({
    rules: [{ ...requiredRegion, isActive: false }],
    model: MODEL,
    readPartners: async () => { read = true; return partners; },
    readSection: async () => new Map()
  });
  assert.equal(read, false, 'no remote read for a ruleset that cannot run');
  assert.equal(report.skipped, 1);
  assert.deepEqual(report.rules, []);
});

test('the partner cap is a real number, so the scan cannot be unbounded by default', () => {
  assert.ok(MAX_PARTNERS > 0 && Number.isFinite(MAX_PARTNERS));
});
