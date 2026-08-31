'use strict';

const { compare, COMPARISONS, EMPTINESS_COMPARISONS } = require('./rule-engine');
const { sectionRows, isEmptyValue, resolvePayloadField } = require('./payload-fields');
const {
  parseValueList, listMatches, joinConditions, conditionLogicError
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
const REQUEST_TYPES = Object.freeze(['create', 'change', 'block', 'delete']);

const REQUEST_TYPE_TEXT = Object.freeze({
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

/** The default operator for a condition row and for the legacy two-column shape below, which never
 *  had an operator concept at all - "field is one of these values" is exactly what `eq` means here. */
const DEFAULT_CONDITION_OPERATOR = 'eq';

/**
 * The legacy two-pair shape (superseded by the `conditions` composition, see db/workflow-rules.cds)
 * - kept only so `legacyConditionPairs` can still read a rule saved before 2026-08-28.
 */
const CONDITION_PAIRS = Object.freeze([
  Object.freeze({ field: 'conditionField', values: 'conditionValues' }),
  Object.freeze({ field: 'conditionField2', values: 'conditionValues2' })
]);

/** The two-column shape as a plain array, operator implied `eq`, for a rule with no `conditions` rows. */
function legacyConditionPairs(rule) {
  return CONDITION_PAIRS.map((pair) => ({
    field: trimmed(rule[pair.field]),
    operator: DEFAULT_CONDITION_OPERATOR,
    values: parseValueList(rule[pair.values])
  }));
}

// Deliberately loose: SBPA resolves both a user and a role, so an entry only has to be readable.
// A stricter address check here would reject the technical users a real installation ends up using.
const looksLikeEmail = (entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(entry);

/** `user` for an e-mail address, `role` for anything else - the one thing SBPA needs told apart. */
const approverKind = (entry) => (looksLikeEmail(entry) ? 'user' : 'role');

const trimmed = (value) => String(value === null || value === undefined ? '' : value).trim();

/** A known operator, defaulting a blank or unusable one to `eq` - the read side always has one to
 *  apply, exactly like `conditionLogicOf` never leaves the AND/OR/NOR column unresolved. */
function operatorOf(raw) {
  const key = trimmed(raw);
  return COMPARISONS[key] ? key : DEFAULT_CONDITION_OPERATOR;
}

/**
 * The rule's conditions as `{ field, operator, values, resolved }`, dropping entries with no field.
 * As many as the `conditions` composition holds (each its own row, `WorkflowRuleConditions`); a rule
 * with none there yet falls back to the two legacy columns, so a row saved before 2026-08-28 keeps
 * matching exactly as it did, with no migration.
 */
function readConditions(rule, model) {
  const rows = Array.isArray(rule.conditions) && rule.conditions.length
    ? rule.conditions.map((row) => ({
      field: trimmed(row.field),
      operator: operatorOf(row.operator),
      values: parseValueList(row.values)
    }))
    : legacyConditionPairs(rule);
  return rows
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

// Joined by `conditionLogic` across however many conditions the rule has; zero still means "any". A
// stored row has no logic column and reads as AND, as before.
function conditionsHold(conditions, payload, model, logic) {
  return joinConditions(
    conditions.map((condition) => conditionHolds(condition, payload, model)),
    logic
  );
}

/**
 * One condition row's own problems - field/operator/values consistency - independent of the rule it
 * belongs to. Each `WorkflowRuleConditions` row is its own thing to validate now, not a slice of a
 * fixed pair, so this runs once per row rather than looping a hard-coded `CONDITION_PAIRS.entries()`.
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

  // Only when conditions were sent alongside the rule (a deep read/update, or the courtesy check
  // that already has them in hand) - the service's own guard on WorkflowRuleConditions validates a
  // row on its own write regardless, so a rule PATCH that carries no conditions is not penalised for
  // rows it never touched.
  if (Array.isArray(rule.conditions)) {
    rule.conditions.forEach((row, index) => {
      errors.push(...validateCondition(row, model, `condition ${index + 1}`));
    });
  }

  const logicProblem = conditionLogicError(rule.conditionLogic);
  if (logicProblem) errors.push({ field: 'conditionLogic', message: logicProblem });

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
    .filter((rule) => trimmed(rule.requestType) === type)
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
  DEFAULT_CONDITION_OPERATOR,
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
