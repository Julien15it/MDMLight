'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCandidate, fieldValues } = require('../srv/ai/duplicate-fields');
const {
  DEFAULT_RULES,
  VERDICTS,
  compareValues,
  conditionsMatch,
  indicatorsFor,
  verdictFor,
  evaluate
} = require('../srv/ai/duplicate-engine');

const RULES = Object.freeze([
  { sequence: 10, condCountry: 'BE', condCategory: '2', field: 'TaxNumber.BE0', comparison: 'exact', indicator: 'definitive' },
  { sequence: 20, field: 'Name', comparison: 'fuzzy', threshold: 0.86, indicator: 'strong' },
  { sequence: 30, field: 'PostalCode', comparison: 'exact', indicator: 'weak' },
  { sequence: 40, field: 'CityName', comparison: 'exact', indicator: 'weak' }
]);

const partner = (id, overrides = {}) => ({
  BusinessPartner: id,
  BusinessPartnerFullName: 'Alluvion NV',
  BusinessPartnerCategory: '2',
  ...overrides
});

const entries = (...partners) => partners.map((row) => ({ partner: row }));

test('the default ruleset reproduces the hard-coded name check', () => {
  const [found] = evaluate(
    { Name: 'Alluvion' },
    entries(partner('1', { BusinessPartnerFullName: 'Aluvion BVBA' })),
    { rules: DEFAULT_RULES }
  );
  assert.equal(found.partner.BusinessPartner, '1');
  assert.equal(found.verdict, VERDICTS.SMALL);
  assert.equal(found.indicators.length, 1);
  assert.equal(found.indicators[0].field, 'Name');
});

test('a candidate carrying only a name never reaches a definitive verdict', () => {
  const other = partner('2', {
    Country: 'BE',
    taxNumbers: [{ BPTaxType: 'BE0', BPTaxNumber: 'BE0123456789' }],
    addresses: [{ PostalCode: '9000', CityName: 'Gent', Country: 'BE' }]
  });
  const [found] = evaluate({ Name: 'Alluvion', BusinessPartnerCategory: '2' }, entries(other), { rules: RULES });
  assert.equal(found.verdict, VERDICTS.SMALL);
  assert.deepEqual(found.indicators.map((row) => row.field), ['Name']);
});

test('blank is never a match — two partners lacking a VAT number share nothing', () => {
  const left = { Name: 'Alluvion', Country: 'BE', BusinessPartnerCategory: '2' };
  const right = partner('3', { BusinessPartnerFullName: 'Totally Different Company', Country: 'BE' });
  assert.deepEqual(evaluate(left, entries(right), { rules: RULES }), []);
  assert.equal(compareValues('exact', [], [], 1), 0);
  assert.equal(compareValues('exact', ['BE0123'], [], 1), 0);
});

test('an identical Belgian VAT number is a definitive duplicate', () => {
  const left = {
    Name: 'Something Else Entirely',
    BusinessPartnerCategory: '2',
    Country: 'BE',
    taxNumbers: [{ BPTaxType: 'BE0', BPTaxNumber: '0123.456.789' }]
  };
  const right = partner('4', {
    BusinessPartnerFullName: 'Nothing Alike BV',
    addresses: [{ Country: 'BE' }],
    taxNumbers: [{ BPTaxType: 'BE0', BPTaxNumber: 'BE 0123 456 789' }]
  });
  const [found] = evaluate(left, entries(right), { rules: RULES });
  assert.equal(found.verdict, VERDICTS.DUPLICATE);
  assert.equal(found.indicators[0].field, 'TaxNumber.BE0');
});

test('a bare VAT number takes the record country, so BE and NL do not collide', () => {
  assert.deepEqual(fieldValues({ Country: 'BE', taxNumbers: [{ BPTaxNumber: '0123456789' }] }, 'TaxNumber'), ['BE0123456789']);
  assert.deepEqual(fieldValues({ Country: 'NL', taxNumbers: [{ BPTaxNumber: '0123456789' }] }, 'TaxNumber'), ['NL0123456789']);
  assert.deepEqual(fieldValues({ taxNumbers: [{ BPTaxNumber: 'BE0123456789' }] }, 'TaxNumber'), ['BE0123456789']);
});

test('a rule only fires when its conditions hold on both records', () => {
  const belgian = { condCountry: 'BE' };
  assert.equal(conditionsMatch(belgian, buildCandidate({ Country: 'BE' })), true);
  assert.equal(conditionsMatch(belgian, buildCandidate({ Country: 'DE' })), false);
  assert.equal(conditionsMatch(belgian, buildCandidate({ Name: 'Alluvion' })), false);
  assert.equal(conditionsMatch({}, buildCandidate({ Name: 'Alluvion' })), true);

  const german = partner('5', {
    Country: 'DE',
    taxNumbers: [{ BPTaxType: 'BE0', BPTaxNumber: 'BE0123456789' }]
  });
  const left = {
    Name: 'Nothing Alike',
    BusinessPartnerCategory: '2',
    Country: 'BE',
    taxNumbers: [{ BPTaxType: 'BE0', BPTaxNumber: 'BE0123456789' }]
  };
  assert.deepEqual(evaluate(left, entries(german), { rules: RULES }), []);
});

test('conditions read a role from the roles collection', () => {
  const bag = buildCandidate({ roles: [{ BusinessPartnerRole: 'FLCU01' }] });
  assert.equal(conditionsMatch({ condRole: 'FLCU01' }, bag), true);
  assert.equal(conditionsMatch({ condRole: 'FLVN01' }, bag), false);
});

test('two rows on the same field contribute once, at the strongest indicator', () => {
  const rules = [
    { field: 'Name', comparison: 'fuzzy', threshold: 0.86, indicator: 'weak' },
    { field: 'Name', comparison: 'exact', indicator: 'strong' }
  ];
  const { indicators } = indicatorsFor({ Name: ['alluvion'] }, { Name: ['alluvion'] }, rules);
  assert.equal(indicators.length, 1);
  assert.equal(indicators[0].indicator, 'strong');
});

test('the aggregation ladder is fixed in code', () => {
  const weak = { indicator: 'weak', score: 1 };
  const strong = { indicator: 'strong', score: 1 };
  assert.equal(verdictFor([{ indicator: 'definitive', score: 1 }]), VERDICTS.DUPLICATE);
  assert.equal(verdictFor([strong, weak]), VERDICTS.STRONG);
  assert.equal(verdictFor([strong, strong]), VERDICTS.STRONG);
  assert.equal(verdictFor([strong]), VERDICTS.SMALL);
  assert.equal(verdictFor([weak, weak]), VERDICTS.SMALL);
  assert.equal(verdictFor([weak]), VERDICTS.NONE);
  assert.equal(verdictFor([]), VERDICTS.NONE);
});

test('a name hit plus a shared address is stronger than the name alone', () => {
  const left = {
    Name: 'Alluvion',
    BusinessPartnerCategory: '2',
    addresses: [{ PostalCode: '9000', CityName: 'Gent' }]
  };
  const near = partner('6', {
    BusinessPartnerFullName: 'Aluvion BVBA',
    addresses: [{ PostalCode: '2000', CityName: 'Antwerpen' }, { PostalCode: '9000', CityName: 'Gent' }]
  });
  const far = partner('7', { BusinessPartnerFullName: 'Aluvion BVBA' });
  const found = evaluate(left, entries(far, near), { rules: RULES });
  assert.equal(found[0].partner.BusinessPartner, '6');
  assert.equal(found[0].verdict, VERDICTS.STRONG);
  assert.equal(found[1].verdict, VERDICTS.SMALL);
});

test('an unevaluated rule is reported rather than passed off as no match', () => {
  const rules = [
    { field: 'Name', comparison: 'semantic', threshold: 0.9, indicator: 'strong' },
    { field: 'NotInTheCatalog', comparison: 'exact', indicator: 'definitive' }
  ];
  const found = evaluate({ Name: 'Alluvion' }, entries(partner('8')), { rules });
  assert.deepEqual(found, []);
  assert.deepEqual(found.unevaluatedRules, [
    { field: 'Name', comparison: 'semantic', reason: 'unsupported_comparison' },
    { field: 'NotInTheCatalog', comparison: 'exact', reason: 'unknown_field' }
  ]);
});

test('an inactive row is ignored', () => {
  const rules = [{ ...DEFAULT_RULES[0], isActive: false }];
  assert.deepEqual(evaluate({ Name: 'Alluvion' }, entries(partner('9')), { rules }), []);
});

test('the admin test path can exclude the partner being checked', () => {
  const rows = entries(partner('10'), partner('11'));
  assert.equal(evaluate(rows[0].partner, rows, { rules: RULES }).length, 2);
  assert.equal(evaluate(rows[0].partner, rows, { rules: RULES, excludeId: '10' }).length, 1);
});

test('index entries reuse their precomputed name fingerprints', () => {
  const entry = { partner: { BusinessPartner: '12' }, fingerprints: ['alluvion'] };
  const [found] = evaluate({ Name: 'Alluvion BVBA' }, [entry], { rules: DEFAULT_RULES });
  assert.equal(found.partner.BusinessPartner, '12');
  assert.equal(found.indicators[0].score, 1);
});
