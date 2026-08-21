'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DELIMITER, parseValueList, formatValueList, listMatches
} = require('../srv/checks/value-lists');
const {
  REQUEST_TYPES, STEPS, approverKind, conditionsHold, readConditions,
  validateWorkflowRule, runnableWorkflowRules, resolveApprovers
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

// Half a condition is the dangerous half: a field with no values would match every request.
test('half a condition is refused, from either side', () => {
  const fields = (overrides) => validateWorkflowRule(rule(overrides), model).errors.map((e) => e.field);
  assert.deepEqual(fields({ conditionField: 'Addresses.Country' }), ['conditionValues']);
  assert.deepEqual(fields({ conditionValues: 'BE' }), ['conditionField']);
  assert.deepEqual(fields({ conditionField: 'Nowhere.Country', conditionValues: 'BE' }), ['conditionField']);
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
