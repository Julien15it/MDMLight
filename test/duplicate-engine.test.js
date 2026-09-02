'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCandidate, fieldValues } = require('../srv/ai/duplicate-fields');
const {
  DEFAULT_RULES,
  VERDICTS,
  compareValues,
  conditionsMatch,
  requiredFields,
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

test('a name-only candidate reaches Duplicate on an exact or near-exact name', () => {
  const found = evaluate(
    { Name: 'Alluvion NV' },
    entries(
      partner('1', { BusinessPartnerFullName: 'Alluvion' }),
      partner('2', { BusinessPartnerFullName: 'Alluvion BVBA' }),
      partner('3', { BusinessPartnerFullName: 'Aluvion' })
    ),
    { rules: DEFAULT_RULES }
  );
  assert.equal(found.length, 3);
  for (const row of found) {
    assert.equal(row.verdict, VERDICTS.DUPLICATE, `BP ${row.partner.BusinessPartner}`);
    assert.equal(row.indicators.length, 1, 'one field contributes once');
    assert.equal(row.indicators[0].field, 'Name');
  }
});

test('a differing tax number rules the pair out however well the names match', () => {
  const left = { Name: 'Alluvion NV', Country: 'BE', taxNumbers: [{ BPTaxNumber: '0666471360' }] };
  const same = partner('5', { Country: 'BE', taxNumbers: [{ BPTaxNumber: 'BE0666471360' }] });
  const other = partner('6', { Country: 'BE', taxNumbers: [{ BPTaxNumber: 'BE0417497106' }] });
  const found = evaluate(left, entries(same, other), { rules: DEFAULT_RULES });
  assert.deepEqual(found.map((row) => row.partner.BusinessPartner), ['5']);
  assert.equal(found[0].verdict, VERDICTS.DUPLICATE);
});

test('a differing country rules the pair out — Delta NV in BE is not Delta Inc in US', () => {
  const left = { Name: 'Delta', Country: 'BE' };
  const found = evaluate(left, entries(partner('7', { BusinessPartnerFullName: 'Delta Inc', Country: 'US' })), {
    rules: DEFAULT_RULES
  });
  assert.deepEqual(found, []);
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

// BP 208 in the sandbox carries all three of these for the same enterprise number.
test('BE0, BE1 and BE2 spellings of one enterprise number normalise alike', () => {
  assert.deepEqual(fieldValues({
    Country: 'BE',
    taxNumbers: [
      { BPTaxType: 'BE0', BPTaxNumber: 'BE0448207405' },
      { BPTaxType: 'BE1', BPTaxNumber: '0448207405' },
      { BPTaxType: 'BE2', BPTaxNumber: '448207405' }
    ]
  }, 'TaxNumber'), ['BE0448207405']);
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

// The case this exists for: "if the role is Vendor and the country is BE".
test('two condition pairs are ANDed, and an empty pair narrows nothing', () => {
  const rules = [{
    conditionField: 'Role',
    conditionValue: 'FLVN01',
    conditionField2: 'Country',
    conditionValue2: 'BE',
    field: 'Name',
    comparison: 'exact',
    indicator: 'definitive'
  }];
  const both = partner('30', { Country: 'BE', roles: [{ BusinessPartnerRole: 'FLVN01' }] });
  const wrongRole = partner('31', { Country: 'BE', roles: [{ BusinessPartnerRole: 'FLCU01' }] });
  const wrongCountry = partner('32', { Country: 'DE', roles: [{ BusinessPartnerRole: 'FLVN01' }] });
  const candidate = {
    Name: 'Alluvion NV', Country: 'BE', roles: [{ BusinessPartnerRole: 'FLVN01' }]
  };
  const found = evaluate(candidate, entries(both, wrongRole, wrongCountry), { rules });
  assert.deepEqual(found.map((row) => row.partner.BusinessPartner), ['30']);

  // Both condition fields have to reach the bag, or the rule silently gates on nothing.
  assert.ok(requiredFields(rules).includes('Role'));
  assert.ok(requiredFields(rules).includes('Country'));

  // Leaving the second pair empty must not narrow the rule — it means "any". Dropping the country
  // condition lets the German vendor through, which the two-condition run excluded.
  const roleOnly = [{ ...rules[0], conditionField2: null, conditionValue2: '' }];
  assert.deepEqual(
    evaluate(candidate, entries(both, wrongRole, wrongCountry), { rules: roleOnly })
      .map((row) => row.partner.BusinessPartner),
    ['30', '32']
  );
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
  assert.deepEqual(found.unrunnableRules, [
    { field: 'Name', comparison: 'semantic', reason: 'unsupported_comparison' },
    { field: 'NotInTheCatalog', comparison: 'exact', reason: 'unknown_field' }
  ]);
});

// --- Five condition slots, one Logic per gap (2026-09-01) ----------------------------------------

/**
 * Rolled out from WorkflowRules onto this table the same day. Only Country is used here on purpose:
 * every slot compares the same field, so what the test is measuring is the FOLD, not the matcher.
 *
 * Left to right, no precedence: `BE OR NL AND NL` is `(BE OR NL) AND NL`, which is how the row
 * reads. A BE partner satisfies the first half and fails the trailing AND - which is exactly what
 * a rule that merely ORed everything together could not tell apart.
 */
test('a third condition slot narrows the rule, each gap under its own Logic', () => {
  const rule = {
    field: 'Name',
    comparison: 'fuzzy',
    indicator: 'strong',
    conditionField: 'Country',
    conditionValue: 'BE',
    conditionLogic: 'OR',
    conditionField2: 'Country',
    conditionValue2: 'NL',
    conditionLogic2: 'AND',
    conditionField3: 'Country',
    conditionValue3: 'NL'
  };
  assert.equal(conditionsMatch(rule, buildCandidate({ Country: 'NL' })), true);
  assert.equal(conditionsMatch(rule, buildCandidate({ Country: 'BE' })), false, 'the trailing AND still has to hold');
  assert.equal(conditionsMatch(rule, buildCandidate({ Country: 'FR' })), false, 'neither side of the OR holds');
});

// The comparator (2026-09-02, asked for): a condition on this table is field/comparator/values,
// the same as one on the Workflow Agent Determination page.
test('a duplicate condition is evaluated under its own comparator', () => {
  const rules = (conditionOperator) => [{
    conditionField: 'Country',
    conditionOperator,
    conditionValue: 'BE',
    field: 'Name',
    comparison: 'exact',
    indicator: 'definitive'
  }];
  const belgian = partner('40', { Country: 'BE' });
  const german = partner('41', { Country: 'DE' });
  const candidate = { Name: 'Alluvion NV', Country: 'BE' };

  // The rule has to hold on BOTH records of the pair, so a `!=` rule with a Belgian candidate
  // participates for nobody - which is the honest answer, not a silently widened rule.
  assert.deepEqual(
    evaluate(candidate, entries(belgian, german), { rules: rules('eq') })
      .map((row) => row.partner.BusinessPartner),
    ['40']
  );
  assert.deepEqual(
    evaluate({ Name: 'Alluvion NV', Country: 'DE' }, entries(belgian, german), { rules: rules('ne') })
      .map((row) => row.partner.BusinessPartner),
    ['41']
  );
  // Blank is what every row stored before the column existed carries, and it still means equality.
  assert.deepEqual(
    evaluate(candidate, entries(belgian, german), { rules: rules(undefined) })
      .map((row) => row.partner.BusinessPartner),
    ['40']
  );
});

// `is empty` / `is not empty` are answered on the BAG - "this partner has no value for that field
// at all" - and are a complete condition with no value, so they must not be dropped as half-written.
test('a duplicate condition can ask about emptiness', () => {
  const rules = (conditionOperator) => [{
    conditionField: 'Country',
    conditionOperator,
    field: 'Name',
    comparison: 'exact',
    indicator: 'definitive'
  }];
  const noCountry = partner('42', {});
  const belgian = partner('43', { Country: 'BE' });

  assert.deepEqual(
    evaluate({ Name: 'Alluvion NV' }, entries(noCountry, belgian), { rules: rules('empty') })
      .map((row) => row.partner.BusinessPartner),
    ['42']
  );
  assert.deepEqual(
    evaluate({ Name: 'Alluvion NV', Country: 'BE' }, entries(noCountry, belgian), { rules: rules('notEmpty') })
      .map((row) => row.partner.BusinessPartner),
    ['43']
  );
});
