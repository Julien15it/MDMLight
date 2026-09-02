'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateRule, toEngineRule, usableRules, createRuleStore
} = require('../srv/ai/rule-config');
const { DEFAULT_RULES, VERDICTS } = require('../srv/ai/duplicate-engine');
const { testRuleset, toEntries, TEST_MAX_PARTNERS } = require('../srv/ai/duplicate-check');

const validRow = (overrides = {}) => ({
  sequence: 10,
  field: 'Name',
  comparison: 'fuzzy',
  threshold: 0.9,
  indicator: 'strong',
  isActive: true,
  ...overrides
});

test('a rule naming a field outside the catalog is rejected at the keyboard', () => {
  const { errors } = validateRule(validRow({ field: 'FavouriteColour' }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, 'field');
});

// The grid no longer asks for a threshold, so absent has to mean "use the default", not "invalid".
test('an absent threshold is fine, an unusable one is not', () => {
  assert.deepEqual(validateRule(validRow({ threshold: null })).errors, []);
  assert.equal(toEngineRule(validRow({ threshold: null })).threshold, 0.86);
  assert.equal(validateRule(validRow({ threshold: 1.4 })).errors[0].field, 'threshold');
  assert.equal(validateRule(validRow({ threshold: 0 })).errors[0].field, 'threshold');
  assert.deepEqual(validateRule(validRow({ comparison: 'exact', threshold: null })).errors, []);
  assert.equal(toEngineRule(validRow({ comparison: 'exact', threshold: null })).threshold, undefined);
});

test('a condition is one field and one value, and half of one is rejected', () => {
  assert.deepEqual(
    validateRule(validRow({ conditionField: 'Country', conditionValue: 'BE' })).errors, []
  );
  assert.equal(
    validateRule(validRow({ conditionField: 'Country' })).errors[0].field, 'conditionValue'
  );
  assert.equal(
    validateRule(validRow({ conditionValue: 'BE' })).errors[0].field, 'conditionField'
  );
  assert.equal(
    validateRule(validRow({ conditionField: 'Nonsense', conditionValue: 'BE' })).errors[0].field,
    'conditionField'
  );
  const rule = toEngineRule(validRow({ conditionField: 'Country', conditionValue: 'BE' }));
  assert.equal(rule.conditionField, 'Country');
  assert.equal(rule.conditionValue, 'BE');
});

test('the second condition is optional, validated the same way, and ANDed onto the first', () => {
  // Neither, either or both — every combination a steward can leave the row in.
  assert.deepEqual(validateRule(validRow()).errors, []);
  assert.deepEqual(
    validateRule(validRow({ conditionField2: 'Country', conditionValue2: 'BE' })).errors, []
  );
  assert.deepEqual(validateRule(validRow({
    conditionField: 'Role', conditionValue: 'FLVN01',
    conditionField2: 'Country', conditionValue2: 'BE'
  })).errors, []);

  assert.equal(
    validateRule(validRow({ conditionField2: 'Country' })).errors[0].field, 'conditionValue2'
  );
  assert.equal(
    validateRule(validRow({ conditionValue2: 'BE' })).errors[0].field, 'conditionField2'
  );
  assert.equal(
    validateRule(validRow({ conditionField2: 'Nonsense', conditionValue2: 'BE' })).errors[0].field,
    'conditionField2'
  );

  const rule = toEngineRule(validRow({
    conditionField: 'Role', conditionValue: 'FLVN01',
    conditionField2: 'Country', conditionValue2: 'BE'
  }));
  assert.equal(rule.conditionField2, 'Country');
  assert.equal(rule.conditionValue2, 'BE');
  // Half a second condition is dropped rather than carried as a field that matches everything.
  assert.equal('conditionField2' in toEngineRule(validRow({ conditionField2: 'Country' })), false);
});

// The failure this whole flag exists to prevent: a rule that looks fine and does nothing.
test('a rule over a field the index cannot serve warns rather than passing silently', () => {
  const { errors, warnings } = validateRule(validRow({ field: 'IBAN', comparison: 'exact', threshold: null }));
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /does not carry IBAN/u);
});

test('a stored row becomes an engine rule, with blank conditions dropped', () => {
  const rule = toEngineRule(validRow({ condCountry: 'BE', condCategory: '', condRole: null }));
  assert.equal(rule.condCountry, 'BE');
  assert.equal('condCategory' in rule, false, 'a blank condition means any, not an empty match');
  assert.equal('condRole' in rule, false);
  assert.equal(rule.threshold, 0.9);
  // An exact comparison has no threshold to default to; only a fuzzy one does.
  assert.equal(toEngineRule(validRow({ comparison: 'exact', threshold: null })).threshold, undefined);
});

test('an empty configuration falls back to the defaults, never to no rules at all', async () => {
  const store = createRuleStore({ now: () => 1 });
  await store.refresh(async () => []);
  assert.equal(store.source(), 'defaults');
  assert.deepEqual(store.rules(), DEFAULT_RULES);

  await store.refresh(async () => [validRow({ isActive: false })], { force: true });
  assert.equal(store.source(), 'defaults', 'deactivating the last row must not switch the check off');
});

test('an unreadable table keeps the rules already loaded', async () => {
  const store = createRuleStore({ now: () => 1 });
  await store.refresh(async () => [validRow({ field: 'CityName', comparison: 'exact', threshold: null, indicator: 'weak' })]);
  const before = store.rules();

  const result = await store.refresh(async () => { throw new Error('database is away'); }, { force: true });
  assert.equal(result.failed, true);
  assert.deepEqual(store.rules(), before);
});

test('the ruleset is not re-read until its time to live lapses, or a write drops it', async () => {
  let clock = 1000;
  let reads = 0;
  const load = async () => { reads += 1; return [validRow()]; };
  const store = createRuleStore({ now: () => clock, ttlMs: 100 });

  await store.refresh(load);
  await store.refresh(load);
  assert.equal(reads, 1, 'inside the window, no second read');

  store.markStale();
  await store.refresh(load);
  assert.equal(reads, 2, 'a write drops it immediately');

  clock += 200;
  await store.refresh(load);
  assert.equal(reads, 3);
});

test('the test run counts each pair once and samples across verdicts', () => {
  const partners = [
    { BusinessPartner: '1', OrganizationBPName1: 'Alluvion NV' },
    { BusinessPartner: '2', OrganizationBPName1: 'Alluvion BVBA' },
    { BusinessPartner: '3', OrganizationBPName1: 'Nothing Alike' }
  ];
  const report = testRuleset(toEntries(partners), { rules: DEFAULT_RULES });
  assert.equal(report.partners, 3);
  assert.equal(report.pairs, 1, 'one pair, not two — otherwise every count is doubled');
  assert.equal(report.counts[VERDICTS.DUPLICATE], 1);
  assert.equal(report.samples.length, 1);
  assert.equal(report.samples[0].verdict, VERDICTS.DUPLICATE);
  assert.deepEqual(report.samples[0].indicators, ['Name (exact)']);
});

test('a population too large to compare pairwise refuses instead of hanging', () => {
  const many = Array.from({ length: TEST_MAX_PARTNERS + 1 }, (unused, index) => ({
    BusinessPartner: String(index), OrganizationBPName1: `Company ${index}`
  }));
  const report = testRuleset(toEntries(many), { rules: DEFAULT_RULES });
  assert.equal(report.tooLarge, true);
  assert.equal(report.limit, TEST_MAX_PARTNERS);
});
