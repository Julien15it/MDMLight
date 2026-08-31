'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DELIMITER, parseValueList, formatValueList, listMatches
} = require('../srv/checks/value-lists');
const {
  REQUEST_TYPES, STEPS, approverKind, conditionsHold, readConditions,
  validateCondition, validateWorkflowRule, runnableWorkflowRules, resolveApprovers
} = require('../srv/checks/workflow-rules');
const { compare } = require('../srv/checks/rule-engine');

/**
 * The same CSN stand-in as quality-rule-engine.test.js: a small injected model keeps this about the
 * engine rather than about the staging schema, which has its own tests.
 */
const model = {
  definitions: {
    'mdmlight.staging.StagedGeneral': {
      elements: {
        ID: { type: 'cds.UUID' },
        Language: { type: 'cds.String' },
        OrganizationBPName1: { type: 'cds.String' },
        BusinessPartnerCategory: { type: 'cds.String' }
      }
    },
    'mdmlight.staging.StagedAddresses': {
      elements: {
        ID: { type: 'cds.UUID' },
        Country: { type: 'cds.String' },
        Region: { type: 'cds.String' }
      }
    }
  }
};

const payload = (root = {}, sections = {}) => ({ root, sections });

const rule = (overrides = {}) => ({
  requestType: 'create',
  step: 'Approve',
  approvers: 'maarten@alluvion.eu',
  isActive: true,
  ...overrides
});

// ---------------------------------------------------------------------------
// The encoding
//
// The grid offers ONE value per field again (multiple values were withdrawn on 2026-08-21 - see
// "Multiple values per condition" in CLAUDE.md). These stay because the READ path still parses a
// delimited list: rows written while the feature was live may hold `BE|NL`, and a stored rule that
// silently stopped matching is the failure this codebase refuses everywhere else.
// ---------------------------------------------------------------------------

/**
 * A stored single value has to already be a valid one-entry list - that is what lets the other
 * tables' condition columns become multi-value later without touching a row.
 */
test('a single stored value is a one-entry list', () => {
  assert.deepEqual(parseValueList('BE'), ['BE']);
  assert.deepEqual(parseValueList(''), []);
  assert.deepEqual(parseValueList(null), []);
});

test('a list round-trips, trimmed, without empties or duplicates', () => {
  assert.deepEqual(parseValueList(' BE | NL ||NL| FR '), ['BE', 'NL', 'FR']);
  assert.equal(formatValueList(['BE', 'NL', 'BE']), `BE${DELIMITER}NL`);
  assert.deepEqual(parseValueList(formatValueList(['BE', 'NL'])), ['BE', 'NL']);
});

// Commas and semicolons are in the data - "Acme, Inc" and address text - and would split a value in
// half. Neither appears in an e-mail address, a country code or a role, and nor does the delimiter.
test('the delimiter is not a character the data carries', () => {
  assert.equal(DELIMITER, '|');
  assert.deepEqual(parseValueList('Acme, Inc|Beta; Ltd'), ['Acme, Inc', 'Beta; Ltd']);
});

test('a list matches on any entry, not on all of them', () => {
  assert.equal(listMatches('BE|NL|FR', 'NL', compare), true);
  assert.equal(listMatches('BE|NL|FR', 'nl', compare), true, 'text compares case-insensitively');
  assert.equal(listMatches('BE|NL|FR', 'DE', compare), false);
  assert.equal(listMatches('', 'BE', compare), false);
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

// The whole point of the list: four countries are one row rather than four.
test('one condition covers several values, and holds on any of them', () => {
  const conditions = readConditions(
    rule({ conditionField: 'Addresses.Country', conditionValues: 'BE|NL|FR|DE' }), model
  );
  const belgian = payload({}, { Addresses: [{ Country: 'BE' }] });
  const spanish = payload({}, { Addresses: [{ Country: 'ES' }] });
  assert.equal(conditionsHold(conditions, belgian, model), true);
  assert.equal(conditionsHold(conditions, spanish, model), false);
});

// A row of this table targets no section of its own, so a condition is a statement about the
// PARTNER: any row of the named section satisfying it is enough.
test('a condition holds when any row of the section matches', () => {
  const conditions = readConditions(
    rule({ conditionField: 'Addresses.Country', conditionValues: 'NL' }), model
  );
  const two = payload({}, { Addresses: [{ Country: 'BE' }, { Country: 'NL' }] });
  assert.equal(conditionsHold(conditions, two, model), true);
});

test('both pairs are ANDed, and an empty pair means any', () => {
  const both = readConditions(rule({
    conditionField: 'Addresses.Country', conditionValues: 'BE',
    conditionField2: 'General.BusinessPartnerCategory', conditionValues2: '2'
  }), model);
  assert.equal(conditionsHold(both, payload({ BusinessPartnerCategory: '2' }, { Addresses: [{ Country: 'BE' }] }), model), true);
  assert.equal(conditionsHold(both, payload({ BusinessPartnerCategory: '1' }, { Addresses: [{ Country: 'BE' }] }), model), false);
  // No condition at all applies to everything - that is what an empty pair is for.
  assert.equal(conditionsHold(readConditions(rule(), model), payload(), model), true);
});

// ---------------------------------------------------------------------------
// The dynamic `conditions` composition (2026-08-28) - replaces the two fixed pairs above for any
// rule saved from now on. One condition per ROW of WorkflowRuleConditions, each carrying its own
// field/operator/values, added and removed independently of the rule's own edits.
// ---------------------------------------------------------------------------

// The whole point of the composition: a rule is not stuck at two conditions any more.
test('a rule can hold more than two conditions, folded by conditionLogic', () => {
  const rule3 = rule({
    conditions: [
      { field: 'Addresses.Country', operator: 'eq', values: 'BE|NL' },
      { field: 'General.BusinessPartnerCategory', operator: 'eq', values: '2' },
      { field: 'General.OrganizationBPName1', operator: 'eq', values: 'Acme' }
    ],
    conditionLogic: 'AND'
  });
  const conditions = readConditions(rule3, model);
  assert.equal(conditions.length, 3);
  const matching = payload(
    { BusinessPartnerCategory: '2', OrganizationBPName1: 'Acme' },
    { Addresses: [{ Country: 'NL' }] }
  );
  const missingOne = payload(
    { BusinessPartnerCategory: '2', OrganizationBPName1: 'Something Else' },
    { Addresses: [{ Country: 'NL' }] }
  );
  assert.equal(conditionsHold(conditions, matching, model), true);
  assert.equal(conditionsHold(conditions, missingOne, model), false);
});

// A rule saved before 2026-08-28 has real data in the legacy columns and no `conditions` rows - it
// must keep matching exactly as it always did, with no migration.
test('readConditions falls back to the legacy columns only while `conditions` is empty', () => {
  const legacy = rule({ conditionField: 'Addresses.Country', conditionValues: 'BE' });
  assert.deepEqual(readConditions(legacy, model).map((c) => c.field), ['Addresses.Country']);

  // The moment a rule has real condition rows, those are what have the current truth - the legacy
  // columns are not merged in alongside them, even if a stale value still sits there.
  const migrated = rule({
    conditionField: 'Addresses.Country', conditionValues: 'BE',
    conditions: [{ field: 'General.BusinessPartnerCategory', operator: 'eq', values: '2' }]
  });
  assert.deepEqual(readConditions(migrated, model).map((c) => c.field), ['General.BusinessPartnerCategory']);
});

// --- Operators (2026-08-28, asked for: "= of !=, en dan andere") -------------------------------
//
// The exact vocabulary rule-engine.js already offers ValidationRules/DerivationRules for their own
// comparison column - reused rather than a smaller, WorkflowRules-only set.

test('eq keeps the existing OR-across-values, wildcard-matching behaviour', () => {
  const conditions = readConditions(rule({
    conditions: [{ field: 'Addresses.Country', operator: 'eq', values: 'BE|NL' }]
  }), model);
  assert.equal(conditionsHold(conditions, payload({}, { Addresses: [{ Country: 'NL' }] }), model), true);
  assert.equal(conditionsHold(conditions, payload({}, { Addresses: [{ Country: 'FR' }] }), model), false);
});

// "!=" is the exact negation of the same "some row, some value" shape - not "every row disagrees".
test('ne holds when some row differs from every listed value', () => {
  const conditions = readConditions(rule({
    conditions: [{ field: 'Addresses.Country', operator: 'ne', values: 'BE' }]
  }), model);
  const oneMatchesOneDoesnt = payload({}, { Addresses: [{ Country: 'BE' }, { Country: 'NL' }] });
  const bothMatch = payload({}, { Addresses: [{ Country: 'BE' }] });
  assert.equal(conditionsHold(conditions, oneMatchesOneDoesnt, model), true);
  assert.equal(conditionsHold(conditions, bothMatch, model), false);
});

test('lt/le/gt/ge compare numerically, the same comparator rule-engine.js uses elsewhere', () => {
  const atLeast5 = readConditions(rule({
    conditions: [{ field: 'General.BusinessPartnerCategory', operator: 'ge', values: '5' }]
  }), model);
  assert.equal(conditionsHold(atLeast5, payload({ BusinessPartnerCategory: '7' }), model), true);
  assert.equal(conditionsHold(atLeast5, payload({ BusinessPartnerCategory: '3' }), model), false);
});

test('empty/notEmpty need no listed value at all', () => {
  const mustBeEmpty = readConditions(rule({
    conditions: [{ field: 'General.OrganizationBPName1', operator: 'empty', values: '' }]
  }), model);
  assert.equal(conditionsHold(mustBeEmpty, payload({ OrganizationBPName1: '' }), model), true);
  assert.equal(conditionsHold(mustBeEmpty, payload({ OrganizationBPName1: 'Acme' }), model), false);
});

test('an unknown or blank operator falls back to eq, never crashes the engine', () => {
  const conditions = readConditions(rule({
    conditions: [{ field: 'Addresses.Country', operator: 'nonsense', values: 'BE' }]
  }), model);
  assert.equal(conditions[0].operator, 'eq');
  assert.equal(conditionsHold(conditions, payload({}, { Addresses: [{ Country: 'BE' }] }), model), true);
});

// --- Validating one condition row on its own (2026-08-28) -----------------------------------

test('validateCondition: half a condition is refused, from either side', () => {
  const fields = (row) => validateCondition(row, model, 'condition 1').map((e) => e.field);
  assert.deepEqual(fields({ field: 'Addresses.Country', values: '' }), ['values']);
  assert.deepEqual(fields({ field: '', values: 'BE' }), ['field']);
  assert.deepEqual(fields({ field: 'Nowhere.Country', values: 'BE' }), ['field']);
  assert.deepEqual(fields({ field: 'Addresses.Country', operator: 'eq', values: 'BE' }), []);
});

// "is empty"/"is not empty" are the one pair that takes no value - a field with nothing after it is
// not "half a condition", it is the whole condition.
test("validateCondition: empty/notEmpty need no value, unlike every other operator", () => {
  assert.deepEqual(
    validateCondition({ field: 'General.OrganizationBPName1', operator: 'empty', values: '' }, model, 'c1'),
    []
  );
  assert.deepEqual(
    validateCondition({ field: 'Addresses.Country', operator: 'eq', values: '' }, model, 'c1').map((e) => e.field),
    ['values']
  );
});

test('validateCondition: an unknown operator is refused at the keyboard', () => {
  const errors = validateCondition({ field: 'Addresses.Country', operator: 'maybe', values: 'BE' }, model, 'c1');
  assert.ok(errors.some((e) => e.field === 'operator'));
});

// ---------------------------------------------------------------------------
// What a row has to carry
// ---------------------------------------------------------------------------

test('a rule needs a CR type, a step and somebody to approve it', () => {
  assert.deepEqual(validateWorkflowRule(rule(), model).errors, []);
  const fields = (overrides) => validateWorkflowRule(rule(overrides), model).errors.map((e) => e.field);
  assert.deepEqual(fields({ requestType: '' }), ['requestType']);
  assert.deepEqual(fields({ step: '' }), ['step']);
  assert.deepEqual(fields({ approvers: '' }), ['approvers']);
  // No `*` on the CR type: an approver list is not something to default.
  assert.deepEqual(fields({ requestType: '*' }), ['requestType']);
  assert.deepEqual(fields({ requestType: 'archive' }), ['requestType']);
  assert.deepEqual(fields({ step: 'Review' }), ['step']);
});

// All four types, unlike the field property profiles' list: this table is where a steward says who
// approves a block or a delete, and saying it before the app processes those types is harmless.
test('all four CR types can be configured, and one step exists', () => {
  assert.deepEqual([...REQUEST_TYPES], ['create', 'change', 'block', 'delete']);
  assert.deepEqual([...STEPS], ['Approve']);
  for (const requestType of REQUEST_TYPES) {
    assert.deepEqual(validateWorkflowRule(rule({ requestType }), model).errors, []);
  }
});

// Half a condition is the dangerous half: a field with no values would match every request. Only
// checked when the rule's conditions were actually sent alongside it (see validateWorkflowRule) -
// each row also validates on its own write, through validateCondition, tested separately above.
test('half a condition is refused, from either side', () => {
  const fields = (conditions) => validateWorkflowRule(rule({ conditions }), model).errors.map((e) => e.field);
  assert.deepEqual(fields([{ field: 'Addresses.Country', operator: 'eq', values: '' }]), ['values']);
  assert.deepEqual(fields([{ field: '', operator: 'eq', values: 'BE' }]), ['field']);
  assert.deepEqual(fields([{ field: 'Nowhere.Country', operator: 'eq', values: 'BE' }]), ['field']);
});

// The legacy two columns are dead going forward - a rule saved under the old shape must not be
// refused now that nothing validates them any more.
test('the legacy condition columns are no longer validated', () => {
  const errors = validateWorkflowRule(
    rule({ conditionField: 'Addresses.Country' }), model
  ).errors;
  assert.deepEqual(errors, []);
});

// The whole reason for the composition: three or more conditions, not just two.
test('a rule can hold more than two conditions', () => {
  const errors = validateWorkflowRule(rule({
    conditions: [
      { field: 'Addresses.Country', operator: 'eq', values: 'BE|NL' },
      { field: 'General.BusinessPartnerCategory', operator: 'eq', values: '2' },
      { field: 'General.OrganizationBPName1', operator: 'eq', values: 'Acme' }
    ]
  }), model).errors;
  assert.deepEqual(errors, []);
});

/**
 * A role is not checked against a list: roles live in SBPA, and a copy kept in CAP would go stale.
 * A mistyped address falls into the same branch though, so it is warned about rather than accepted
 * in silence.
 */
test('an approver is a user or a role, and a mistyped address is warned about', () => {
  assert.equal(approverKind('maarten@alluvion.eu'), 'user');
  assert.equal(approverKind('DataSteward'), 'role');
  assert.equal(approverKind('SomeRoleNobodyDefinedYet'), 'role');
  assert.deepEqual(validateWorkflowRule(rule({ approvers: 'DataSteward' }), model).errors, []);
  const warnings = validateWorkflowRule(rule({ approvers: 'maarten@alluvion' }), model).warnings;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /passed on as a role/u);
});

test('an inactive or unusable row is not runnable', () => {
  const rows = [rule(), rule({ isActive: false }), rule({ approvers: '' })];
  assert.equal(runnableWorkflowRules(rows, model).length, 1);
});

// ---------------------------------------------------------------------------
// Resolving the approvers
// ---------------------------------------------------------------------------

// Maarten's example, end to end: "CR type Create, Step Approve, Condition field Country, Condition
// values BE NL FR DE, users three of us".
test('the configured line resolves to the three approvers it names', () => {
  const rules = [rule({
    conditionField: 'Addresses.Country',
    conditionValues: 'BE|NL|FR|DE',
    approvers: 'maarten@alluvion.eu|arthur@alluvion.eu|julien@alluvion.eu'
  })];
  const approvers = resolveApprovers({
    rules,
    requestType: 'create',
    payload: payload({}, { Addresses: [{ Country: 'NL' }] }),
    model
  });
  assert.deepEqual(approvers.map((entry) => entry.value), [
    'maarten@alluvion.eu', 'arthur@alluvion.eu', 'julien@alluvion.eu'
  ]);
  assert.deepEqual([...new Set(approvers.map((entry) => entry.step))], ['Approve']);
  assert.deepEqual([...new Set(approvers.map((entry) => entry.kind))], ['user']);
});

test('a rule for another CR type, or whose conditions miss, contributes nobody', () => {
  const rules = [rule({ conditionField: 'Addresses.Country', conditionValues: 'BE' })];
  const belgian = payload({}, { Addresses: [{ Country: 'BE' }] });
  assert.equal(resolveApprovers({ rules, requestType: 'change', payload: belgian, model }).length, 0);
  assert.equal(resolveApprovers({
    rules, requestType: 'create', payload: payload({}, { Addresses: [{ Country: 'ES' }] }), model
  }).length, 0);
});

// Extra lines are extra approvers, which is what the Add button is for. Rows are additive and carry
// no order of their own, so they contribute in table order.
test('several rules add up, in table order, without repeating a person', () => {
  const rules = [
    rule({ approvers: 'first@alluvion.eu|second@alluvion.eu' }),
    rule({ approvers: 'second@alluvion.eu|DataSteward' })
  ];
  const approvers = resolveApprovers({ rules, requestType: 'create', payload: payload(), model });
  assert.deepEqual(approvers.map((entry) => entry.value), [
    'first@alluvion.eu', 'second@alluvion.eu', 'DataSteward'
  ]);
  // A role and a user are told apart, because that is the one thing SBPA needs to assign a task.
  assert.deepEqual(approvers.map((entry) => entry.kind), ['user', 'user', 'role']);
});

/**
 * Empty is a legitimate answer and never an exception: it is what an installation with no rules
 * configured sends, and what every submit sent before this table existed, so SBPA reads it as
 * "route it the way you did before" rather than as a request nobody can approve.
 */
test('no rules, or unusable ones, resolve to an empty list rather than an error', () => {
  assert.deepEqual(resolveApprovers({ rules: [], requestType: 'create', payload: payload(), model }), []);
  assert.deepEqual(resolveApprovers({
    rules: [rule({ approvers: '' }), rule({ isActive: false })],
    requestType: 'create',
    payload: payload(),
    model
  }), []);
  assert.deepEqual(resolveApprovers({}), []);
});
