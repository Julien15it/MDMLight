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

// ---------------------------------------------------------------------------
// Five slots, one Logic per gap (2026-09-01, asked for): "provide an 'add condition' button next to
// 'add rule' ... pressing this should add an extra Logic and an extra Condition column". Columns,
// not a composition - see db/workflow-rules.cds for why that route is closed permanently.
// ---------------------------------------------------------------------------

test('a rule can carry five conditions, each with its own field, operator and value', () => {
  const five = readConditions(rule({
    conditionField: 'Addresses.Country', conditionValues: 'BE',
    conditionField2: 'Addresses.Region', conditionOperator2: 'notEmpty',
    conditionField3: 'General.BusinessPartnerCategory', conditionValues3: '2',
    conditionField4: 'General.Language', conditionValues4: 'NL',
    conditionField5: 'General.OrganizationBPName1', conditionOperator5: 'contains', conditionValues5: 'alluvion'
  }), model);
  assert.equal(five.length, 5);
  const all = payload(
    { BusinessPartnerCategory: '2', Language: 'NL', OrganizationBPName1: 'Alluvion BV' },
    { Addresses: [{ Country: 'BE', Region: 'VAN' }] }
  );
  assert.equal(conditionsHold(five, all, model), true);
  // One of the five failing is enough, because they are ANDed by default.
  assert.equal(conditionsHold(five, payload(
    { BusinessPartnerCategory: '2', Language: 'NL', OrganizationBPName1: 'Somebody Else' },
    { Addresses: [{ Country: 'BE', Region: 'VAN' }] }
  ), model), false);
});

// Left to right, no precedence: `A OR B AND C` is `(A OR B) AND C`, which is how the row reads.
test('each Logic column joins its own pair, folded left to right', () => {
  const conditions = readConditions(rule({
    conditionField: 'Addresses.Country', conditionValues: 'BE',
    conditionLogic: 'OR',
    conditionField2: 'Addresses.Country', conditionValues2: 'NL',
    conditionLogic2: 'AND',
    conditionField3: 'General.BusinessPartnerCategory', conditionValues3: '2'
  }), model);
  const dutchOrg = payload({ BusinessPartnerCategory: '2' }, { Addresses: [{ Country: 'NL' }] });
  assert.equal(conditionsHold(conditions, dutchOrg, model), true, 'NL satisfies the OR, category the AND');
  const dutchPerson = payload({ BusinessPartnerCategory: '1' }, { Addresses: [{ Country: 'NL' }] });
  assert.equal(conditionsHold(conditions, dutchPerson, model), false, 'the trailing AND still has to hold');
  const frenchOrg = payload({ BusinessPartnerCategory: '2' }, { Addresses: [{ Country: 'FR' }] });
  assert.equal(conditionsHold(conditions, frenchOrg, model), false, 'neither side of the OR holds');
});

// A blank slot takes its own Logic with it, so what survives is joined by the logic written
// immediately before it - never by a column with nothing left beside it.
test('a blank middle slot leaves the surviving conditions joined by their own Logic', () => {
  const conditions = readConditions(rule({
    conditionField: 'Addresses.Country', conditionValues: 'BE',
    conditionLogic: 'AND',
    conditionLogic2: 'OR',
    conditionField3: 'General.BusinessPartnerCategory', conditionValues3: '2'
  }), model);
  assert.equal(conditions.length, 2);
  assert.equal(conditions[1].logic, 'OR');
  assert.equal(conditionsHold(conditions, payload({ BusinessPartnerCategory: '2' }, {}), model), true);
  assert.equal(conditionsHold(conditions, payload({}, { Addresses: [{ Country: 'BE' }] }), model), true);
  assert.equal(conditionsHold(conditions, payload({ BusinessPartnerCategory: '1' }, { Addresses: [{ Country: 'FR' }] }), model), false);
});

// A rule saved with two slots has no later column filled in at all - it must read exactly as it did.
test('a rule saved before the extra slots existed is unchanged', () => {
  const two = readConditions(rule({
    conditionField: 'Addresses.Country', conditionValues: 'BE',
    conditionField2: 'General.BusinessPartnerCategory', conditionValues2: '2'
  }), model);
  assert.equal(two.length, 2);
  assert.equal(conditionsHold(two, payload({ BusinessPartnerCategory: '2' }, { Addresses: [{ Country: 'BE' }] }), model), true);
  assert.equal(conditionsHold(two, payload({ BusinessPartnerCategory: '2' }, { Addresses: [{ Country: 'FR' }] }), model), false);
});

// Half a condition is the dangerous half in the new slots too, and so is a logic nothing recognises.
test('every slot validates, and so does every Logic column', () => {
  const errors = validateWorkflowRule(rule({
    conditionField5: 'Addresses.Country',
    conditionLogic3: 'MAYBE'
  }), model).errors;
  assert.equal(errors.some((error) => /condition 5 needs at least one value/u.test(error.message)), true);
  assert.equal(errors.some((error) => error.field === 'conditionLogic3'), true);
});

// ---------------------------------------------------------------------------
// Two fixed condition slots (reverted 2026-08-31), on direct feedback: "ik wil dit naast elkaar
// zoals het ervoor was ... niet hoe het nu is" - a dynamic, unbounded `conditionRows` composition
// (db/workflow-rules.cds) was built and briefly deployed-toward, and turned out not to be what was
// wanted after all. `conditionRows`/`WorkflowRuleConditions` stay in the model, permanently unused -
// see the abandoned-column tests in workflow-rules-page.test.js.
//
// The operator per slot survives the revert, because the ORIGINAL two-slot layout already had one
// ("dan je = of != en dan andere") - it was never a bare field/value pair.
// ---------------------------------------------------------------------------

test('eq keeps the existing OR-across-values, wildcard-matching behaviour', () => {
  const conditions = readConditions(rule({
    conditionField: 'Addresses.Country', conditionOperator: 'eq', conditionValues: 'BE|NL'
  }), model);
  assert.equal(conditionsHold(conditions, payload({}, { Addresses: [{ Country: 'NL' }] }), model), true);
  assert.equal(conditionsHold(conditions, payload({}, { Addresses: [{ Country: 'FR' }] }), model), false);
});

// "!=" is the exact negation of the same "some row, some value" shape - not "every row disagrees".
test('ne holds when some row differs from every listed value', () => {
  const conditions = readConditions(rule({
    conditionField: 'Addresses.Country', conditionOperator: 'ne', conditionValues: 'BE'
  }), model);
  const oneMatchesOneDoesnt = payload({}, { Addresses: [{ Country: 'BE' }, { Country: 'NL' }] });
  const bothMatch = payload({}, { Addresses: [{ Country: 'BE' }] });
  assert.equal(conditionsHold(conditions, oneMatchesOneDoesnt, model), true);
  assert.equal(conditionsHold(conditions, bothMatch, model), false);
});

test('empty/notEmpty need no listed value at all', () => {
  const mustBeEmpty = readConditions(rule({
    conditionField: 'General.OrganizationBPName1', conditionOperator: 'empty', conditionValues: ''
  }), model);
  assert.equal(conditionsHold(mustBeEmpty, payload({ OrganizationBPName1: '' }), model), true);
  assert.equal(conditionsHold(mustBeEmpty, payload({ OrganizationBPName1: 'Acme' }), model), false);
});

test('an unknown or blank operator falls back to eq, never crashes the engine', () => {
  const conditions = readConditions(rule({
    conditionField: 'Addresses.Country', conditionOperator: 'nonsense', conditionValues: 'BE'
  }), model);
  assert.equal(conditions[0].operator, 'eq');
  assert.equal(conditionsHold(conditions, payload({}, { Addresses: [{ Country: 'BE' }] }), model), true);
});

// A rule saved before operators existed has neither `conditionOperator` column filled in - it must
// keep matching exactly as it always did (implicit `eq`), with no migration.
test('a rule saved before operators existed reads as eq, unchanged', () => {
  const legacy = rule({ conditionField: 'Addresses.Country', conditionValues: 'BE|NL' });
  const conditions = readConditions(legacy, model);
  assert.equal(conditions[0].operator, 'eq');
  assert.equal(conditionsHold(conditions, payload({}, { Addresses: [{ Country: 'NL' }] }), model), true);
});

// `conditionRows` is abandoned (see db/workflow-rules.cds) - a rule that happens to carry rows there
// from the brief window the composition was live must be read as if they did not exist.
test('conditionRows is never read, even if a rule happens to carry rows there', () => {
  const withStaleRows = rule({
    conditionField: 'Addresses.Country', conditionValues: 'BE',
    conditionRows: [{ field: 'General.OrganizationBPName1', operator: 'eq', values: 'Ignored' }]
  });
  assert.deepEqual(readConditions(withStaleRows, model).map((c) => c.field), ['Addresses.Country']);
});

// --- Validating one condition slot on its own --------------------------------------------------

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

// ---------------------------------------------------------------------------
// What a row has to carry
// ---------------------------------------------------------------------------

test('a rule needs a CR type, a step and somebody to approve it', () => {
  assert.deepEqual(validateWorkflowRule(rule(), model).errors, []);
  const fields = (overrides) => validateWorkflowRule(rule(overrides), model).errors.map((e) => e.field);
  assert.deepEqual(fields({ requestType: '' }), ['requestType']);
  assert.deepEqual(fields({ step: '' }), ['step']);
  assert.deepEqual(fields({ approvers: '' }), ['approvers']);
  // `*` ("Any") is a valid, explicit CR type since 2026-08-31 - asked for directly, so one rule can
  // cover every type. `archive` is still not a real type.
  assert.deepEqual(fields({ requestType: '*' }), []);
  assert.deepEqual(fields({ requestType: 'archive' }), ['requestType']);
  assert.deepEqual(fields({ step: 'Review' }), ['step']);
});

/**
 * The whole point of "Any": one rule reaches every request type, so a steward is not copying the
 * same approver list onto four rows.
 */
test('a rule with requestType "*" resolves approvers for every CR type', () => {
  const rules = [rule({ requestType: '*', approvers: 'maarten@alluvion.eu' })];
  for (const requestType of ['create', 'change', 'block', 'delete']) {
    const approvers = resolveApprovers({ rules, requestType, payload: payload(), model });
    assert.deepEqual(approvers.map((entry) => entry.value), ['maarten@alluvion.eu']);
  }
});

// A `*` rule and a specific-type rule both contribute, additively, exactly like two specific rules
// already do.
test('a "*" rule and a specific-type rule both contribute for a matching request', () => {
  const rules = [
    rule({ requestType: '*', approvers: 'general@alluvion.eu' }),
    rule({ requestType: 'create', approvers: 'create-only@alluvion.eu' })
  ];
  const forCreate = resolveApprovers({ rules, requestType: 'create', payload: payload(), model });
  assert.deepEqual(forCreate.map((entry) => entry.value).sort(), ['create-only@alluvion.eu', 'general@alluvion.eu']);
  const forChange = resolveApprovers({ rules, requestType: 'change', payload: payload(), model });
  assert.deepEqual(forChange.map((entry) => entry.value), ['general@alluvion.eu']);
});

// An unknown operator in either slot is refused the same way validateCondition refuses it alone.
test('an unknown operator in either slot is refused', () => {
  const fields = (overrides) => validateWorkflowRule(rule(overrides), model).errors.map((e) => e.field);
  assert.deepEqual(
    fields({ conditionField: 'Addresses.Country', conditionOperator: 'maybe', conditionValues: 'BE' }),
    ['operator']
  );
  assert.deepEqual(
    fields({ conditionField2: 'Addresses.Country', conditionOperator2: 'maybe', conditionValues2: 'BE' }),
    ['operator']
  );
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
