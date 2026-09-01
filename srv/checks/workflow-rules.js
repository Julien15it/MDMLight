'use strict';

const { compare, COMPARISONS, EMPTINESS_COMPARISONS } = require('./rule-engine');
const { sectionRows, isEmptyValue, resolvePayloadField } = require('./payload-fields');
const {
  parseValueList, listMatches, foldConditions, conditionLogicError
} = require('./value-lists');

/**
 * Turns the `WorkflowRules` table into the `approvers` list the workflow context carries. Offline
 * and deterministic like the validation and derivation engines: who approves a request must not
 * depend on a network call, and the same payload must always produce the same list.
 *
 * It resolves WHO, never HOW MANY approvals are needed or in what order they run - that stays on
 * SBPA's side, the same way `decideRequest` records an outcome without knowing the chain.
 */

// All four CR types, unlike the field property profiles' closed list: this table is where a steward
// says who approves a block or a delete, and saying it before the app processes those types is
// harmless. `SUPPORTED_REQUEST_TYPES` in change-request-service.js is what actually gates a submit.
//
// `*` joined the list (2026-08-31, asked for directly: "ik moet ook 1 hebben dat voor alle gevallen
// werkt") so one rule can name the approvers for every CR type, rather than needing the same
// approver list copied onto four rows. This is an explicit choice a steward makes on a row, not a
// silent default for a blank type - `requestType` is still `not null` and still validated, `*` is
// simply now one of the values it may hold. Listed first, the same convention the field property
// profiles' own `*` condition already uses.
const REQUEST_TYPES = Object.freeze(['*', 'create', 'change', 'block', 'delete']);

const REQUEST_TYPE_TEXT = Object.freeze({
  '*': 'Any',
  create: 'Create',
  change: 'Change',
  block: 'Block',
  delete: 'Delete'
});

// One step today. It is a column rather than an assumption because the next version of this table
// describes whole request types with several steps each - see db/workflow-rules.cds.
const STEPS = Object.freeze(['Approve']);

const STEP_TEXT = Object.freeze({
  Approve: 'Approve'
});

/** The default operator for a condition slot with nothing chosen - "field is one of these values" is
 *  exactly what `eq` means here, and it is what every condition meant before an operator existed. */
const DEFAULT_CONDITION_OPERATOR = 'eq';

/**
 * The fixed condition slots, side by side - "Condition 1", "Condition 2", and since 2026-09-01
 * three more the page reveals on demand ("provide an 'add condition' button next to 'add rule'").
 * Columns rather than the `conditionRows` composition (db/workflow-rules.cds), which was built and
 * abandoned twice: `cds-deploy` can add an element but can neither drop nor retype one, so a fixed
 * cap that the UI draws only as much of as a rule uses is the shape that survives a deploy.
 *
 * `logic` names the column joining a slot to the one BEFORE it - null on the first, which has
 * nothing to its left. Kept named `legacyConditionPairs` even though this is once again the LIVE
 * mechanism: the function name is what every caller already imports.
 */
const CONDITION_PAIRS = Object.freeze([
  Object.freeze({ field: 'conditionField', operator: 'conditionOperator', values: 'conditionValues', logic: null }),
  Object.freeze({ field: 'conditionField2', operator: 'conditionOperator2', values: 'conditionValues2', logic: 'conditionLogic' }),
  Object.freeze({ field: 'conditionField3', operator: 'conditionOperator3', values: 'conditionValues3', logic: 'conditionLogic2' }),
  Object.freeze({ field: 'conditionField4', operator: 'conditionOperator4', values: 'conditionValues4', logic: 'conditionLogic3' }),
  Object.freeze({ field: 'conditionField5', operator: 'conditionOperator5', values: 'conditionValues5', logic: 'conditionLogic4' })
]);

/** How many slots the schema carries - the page's own Add Condition ceiling. */
const MAX_CONDITIONS = CONDITION_PAIRS.length;

/** The fixed condition slots as a plain array of `{ field, operator, values, logic }`. */
function legacyConditionPairs(rule) {
  return CONDITION_PAIRS.map((pair) => ({
    field: trimmed(rule[pair.field]),
    operator: operatorOf(rule[pair.operator]),
    values: parseValueList(rule[pair.values]),
    logic: pair.logic ? trimmed(rule[pair.logic]) : null
  }));
}

// Deliberately loose: SBPA resolves both a user and a role, so an entry only has to be readable.
// A stricter address check here would reject the technical users a real installation ends up using.
const looksLikeEmail = (entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(entry);

/** `user` for an e-mail address, `role` for anything else - the one thing SBPA needs told apart. */
const approverKind = (entry) => (looksLikeEmail(entry) ? 'user' : 'role');

const trimmed = (value) => String(value === null || value === undefined ? '' : value).trim();

/**
 * The operator label this page shows: "=  equal to" -> "=" (2026-09-01, asked for). The symbol
 * already says it and the cell is narrow; `contains`, `is empty` and `is not empty` carry no symbol
 * and no double space, so they come back whole. Scoped to this table - the other three rule pages
 * still offer `COMPARISONS[code].text` in full.
 */
function symbolOnly(text) {
  return String(text === null || text === undefined ? '' : text).trim().split('  ')[0].trim();
}

/** A known operator, defaulting a blank or unusable one to `eq` - the read side always has one to
 *  apply, exactly like `conditionLogicOf` never leaves the AND/OR/NOR column unresolved. */
function operatorOf(raw) {
  const key = trimmed(raw);
  return COMPARISONS[key] ? key : DEFAULT_CONDITION_OPERATOR;
}

/**
 * The rule's conditions as `{ field, operator, values, logic, resolved }`, dropping entries with no
 * field. A dropped slot takes its own Logic with it, so the surviving conditions stay joined by the
 * logic written immediately before each of them - Condition 2 left blank means Condition 3 is joined
 * to Condition 1 by Condition 3's own Logic, never by a logic column nothing sits beside any more.
 *
 * Always the fixed slots - `conditionRows` (db/workflow-rules.cds) is abandoned, so this never reads
 * it, even for a rule that happens to carry rows there from the brief window it was live.
 */
function readConditions(rule, model) {
  return legacyConditionPairs(rule)
    .filter((condition) => condition.field)
    .map((condition) => ({ ...condition, resolved: resolvePayloadField(condition.field, model) }));
}

/**
 * One condition, over the whole payload. A row of this table targets no section of its own, so a
 * condition is always a statement about the partner: it holds if SOME row of the named section
 * satisfies it against SOME one of the listed values - the same "any row, any value" shape for every
 * operator, so `Country != BE` reads the same way `Country = BE` always has: not "every address
 * disagrees with BE", just "at least one does".
 *
 * `eq` alone keeps the wildcard/multi-value matching (`listMatches`) every other condition column in
 * this app already has - `*` as a pattern only ever meant "equal to, loosely", so it stays scoped to
 * the operator that means equality. The emptiness pair needs no listed value at all.
 */
function conditionHolds(condition, payload, model) {
  if (!condition.resolved) return false;
  const comparison = COMPARISONS[condition.operator] || COMPARISONS[DEFAULT_CONDITION_OPERATOR];
  const rows = sectionRows(payload, condition.resolved.section);
  const rawValues = rows.map((row) => row.record[condition.resolved.element]);

  // "is empty"/"is not empty" are read on the RAW value, same as rule-engine.js's own validation
  // check - an empty value is exactly the thing these two exist to notice, so it must not already
  // be filtered out before either ever sees it.
  if (EMPTINESS_COMPARISONS.includes(condition.operator)) {
    return rawValues.some((value) => comparison.apply(value));
  }

  const actual = rawValues.filter((value) => !isEmptyValue(value));
  if (!actual.length) return false;
  if (!condition.values.length) return false;
  if (condition.operator === 'eq') {
    return actual.some((value) => listMatches(condition.values, value, compare));
  }
  return actual.some((value) => condition.values.some((expected) => comparison.apply(value, expected)));
}

// Folded left to right under each condition's own preceding Logic column; zero still means "any". A
// slot with no logic stored falls back to the rule's first one, and an unset column reads as AND.
function conditionsHold(conditions, payload, model, logic) {
  return foldConditions(
    conditions.map((condition) => conditionHolds(condition, payload, model)),
    conditions.map((condition) => condition.logic || logic)
  );
}

/**
 * One condition slot's own problems - field/operator/values consistency - independent of which slot
 * it is. `validateWorkflowRule` calls this once per fixed pair (`CONDITION_PAIRS`); the service's own
 * per-row `guard` on `WorkflowRuleConditions` called it too while that composition was briefly live,
 * which is why this stayed a standalone, row-shaped function rather than being inlined.
 */
function validateCondition(row = {}, model, name) {
  const errors = [];
  const field = trimmed(row.field);
  const operator = trimmed(row.operator);
  const values = parseValueList(row.values);
  const needsValue = !operator || !COMPARISONS[operator] || COMPARISONS[operator].needsValue !== false;

  if (operator && !COMPARISONS[operator]) {
    errors.push({ field: 'operator', message: `“${operator}” is not a condition operator.` });
  }
  // Half a condition is the dangerous half: a field with no values would match everything - unless
  // the operator is one of the two that need no value at all ("is empty"/"is not empty").
  if (field && needsValue && !values.length) {
    errors.push({ field: 'values', message: `${name} needs at least one value.` });
  }
  if (!field && values.length) {
    errors.push({ field: 'field', message: `${name} needs a field.` });
  }
  if (field && !resolvePayloadField(field, model)) {
    errors.push({
      field: 'field',
      message: `“${field}” is not a field of the request payload. Choose one from the list.`
    });
  }
  return errors;
}

/** Whether one row could ever run, and what is wrong with it if not. */
function validateWorkflowRule(rule = {}, model) {
  const errors = [];
  const warnings = [];
  const requestType = trimmed(rule.requestType);
  const step = trimmed(rule.step);

  if (!requestType) {
    errors.push({ field: 'requestType', message: 'A workflow rule needs the request type it applies to.' });
  } else if (!REQUEST_TYPES.includes(requestType)) {
    errors.push({
      field: 'requestType',
      message: `“${requestType}” is not a request type. Use one of: ${REQUEST_TYPES.join(', ')}.`
    });
  }

  if (!step) {
    errors.push({ field: 'step', message: 'A workflow rule needs a step.' });
  } else if (!STEPS.includes(step)) {
    errors.push({ field: 'step', message: `“${step}” is not a step. Use one of: ${STEPS.join(', ')}.` });
  }

  const approvers = parseValueList(rule.approvers);
  // A step with nobody on it is the one row that looks configured and stops a request dead: SBPA
  // would be handed a step it cannot assign.
  if (!approvers.length) {
    errors.push({ field: 'approvers', message: 'A workflow rule needs at least one approver — an e-mail address or a role.' });
  }
  for (const entry of approvers) {
    if (approverKind(entry) === 'user') continue;
    // Not an error: roles live in SBPA, not here, and a list of them kept in CAP would go stale.
    // But a mistyped address falls through to this branch, so it is worth saying out loud.
    if (entry.includes('@') || entry.includes(' ')) {
      warnings.push({
        field: 'approvers',
        message: `“${entry}” is passed on as a role, not as a user. An e-mail address needs the form name@example.com.`
      });
    }
  }

  // Each fixed slot validates the same way a lone condition row always has - half a condition (a
  // field with no value, or a value with no field) is the dangerous half either way.
  CONDITION_PAIRS.forEach((pair, index) => {
    const row = { field: rule[pair.field], operator: rule[pair.operator], values: rule[pair.values] };
    errors.push(...validateCondition(row, model, `condition ${index + 1}`));
    // Every Logic column, not only the first: a slot the page never revealed carries nothing and
    // reads as AND, so this only ever fires on a value a direct call invented.
    if (!pair.logic) return;
    const logicProblem = conditionLogicError(rule[pair.logic]);
    if (logicProblem) errors.push({ field: pair.logic, message: logicProblem });
  });

  return { errors, warnings };
}

const runnable = (rules, model) => (Array.isArray(rules) ? rules : [])
  .filter((rule) => rule.isActive !== false)
  .filter((rule) => !validateWorkflowRule(rule, model).errors.length);

/**
 * The `approvers` list for one request: every entry of every matching row, in table order, as
 * `{ step, kind, value }`. Deduplicated on step + value, so one person named by two rows is one
 * approver rather than two identical tasks. Rows are additive and carry no order of their own.
 *
 * Empty is a legitimate answer - no rule matched - and SBPA has to read it as "route it the way you
 * did before this table existed" rather than as a request nobody can approve.
 */
function resolveApprovers({ rules = [], requestType, payload = {}, model } = {}) {
  const type = trimmed(requestType);
  const matching = runnable(rules, model)
    // `*` matches every request type - a rule naming it applies whichever type the request actually is.
    .filter((rule) => { const ruleType = trimmed(rule.requestType); return ruleType === '*' || ruleType === type; })
    .filter((rule) => conditionsHold(readConditions(rule, model), payload, model, rule.conditionLogic));

  const approvers = [];
  const seen = new Set();
  for (const rule of matching) {
    for (const entry of parseValueList(rule.approvers)) {
      const key = `${trimmed(rule.step)}|${entry.toLocaleLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      approvers.push({
        step: trimmed(rule.step),
        kind: approverKind(entry),
        value: entry
      });
    }
  }
  return approvers;
}

module.exports = {
  REQUEST_TYPES,
  REQUEST_TYPE_TEXT,
  STEPS,
  STEP_TEXT,
  CONDITION_PAIRS,
  MAX_CONDITIONS,
  DEFAULT_CONDITION_OPERATOR,
  symbolOnly,
  operatorOf,
  legacyConditionPairs,
  approverKind,
  readConditions,
  conditionHolds,
  conditionsHold,
  validateCondition,
  validateWorkflowRule,
  runnableWorkflowRules: runnable,
  resolveApprovers
};
