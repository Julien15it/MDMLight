'use strict';

const {
  resolvePayloadField, sectionRows, targetFor, isEmptyValue, humanise, ROOT_TARGET
} = require('./payload-fields');
const {
  parseValueList, listMatches, foldConditions, conditionLogicOf, conditionLogicError, CONDITION_LOGIC
} = require('./value-lists');

/**
 * Evaluates the configured validation and derivation tables against the request payload, through the
 * qualified catalog in payload-fields.js. Deterministic and offline on purpose: these are gating
 * checks, so no rule may depend on a network call - the registries stay in registry-checks.js.
 */

/**
 * Mirrors CONDITION_PAIRS in srv/ai/duplicate-engine.js, over the same column names. Five slots
 * since 2026-09-01, the same rollout WorkflowRules got - `logic` names the column joining a slot to
 * the one BEFORE it, null on the first, which has nothing to its left. A rule saved with two
 * conditions reads exactly as it did: the extra slots are empty and get dropped.
 *
 * `operator` since 2026-09-02, asked for so a condition here is built exactly as one on the
 * Workflow Agent Determination page is - field, comparator, values. Null reads as `eq`, which is
 * what every condition on these tables meant when there was no comparator to choose.
 */
const CONDITION_PAIRS = Object.freeze([
  Object.freeze({ field: 'conditionField', operator: 'conditionOperator', value: 'conditionValue', logic: null }),
  Object.freeze({ field: 'conditionField2', operator: 'conditionOperator2', value: 'conditionValue2', logic: 'conditionLogic' }),
  Object.freeze({ field: 'conditionField3', operator: 'conditionOperator3', value: 'conditionValue3', logic: 'conditionLogic2' }),
  Object.freeze({ field: 'conditionField4', operator: 'conditionOperator4', value: 'conditionValue4', logic: 'conditionLogic3' }),
  Object.freeze({ field: 'conditionField5', operator: 'conditionOperator5', value: 'conditionValue5', logic: 'conditionLogic4' })
]);

/** How many slots the schema carries - the pages' own Add Condition ceiling. */
const MAX_CONDITIONS = CONDITION_PAIRS.length;

const SEVERITIES = Object.freeze(['error', 'warning', 'info']);

// `needsValue: false` lets the grid disable the Value cell rather than ignore what is typed in it.
// Text compares trimmed and case-insensitively; numbers compare numerically, or 9 would exceed 10.
const COMPARISONS = Object.freeze({
  eq:       { text: '=  equal to',                 needsValue: true,  apply: (a, b) => compare(a, b) === 0 },
  ne:       { text: '!=  not equal to',            needsValue: true,  apply: (a, b) => compare(a, b) !== 0 },
  lt:       { text: '<  less than',                needsValue: true,  apply: (a, b) => compare(a, b) < 0 },
  le:       { text: '<=  at most',                 needsValue: true,  apply: (a, b) => compare(a, b) <= 0 },
  gt:       { text: '>  greater than',             needsValue: true,  apply: (a, b) => compare(a, b) > 0 },
  ge:       { text: '>=  at least',                needsValue: true,  apply: (a, b) => compare(a, b) >= 0 },
  contains: { text: 'contains',                    needsValue: true,  apply: (a, b) => text(a).includes(text(b)) },
  empty:    { text: 'is empty',                    needsValue: false, apply: (a) => isEmptyValue(a) },
  notEmpty: { text: 'is not empty',                needsValue: false, apply: (a) => !isEmptyValue(a) }
});

/**
 * The operator label every rule page shows: "=  equal to" -> "=" (2026-09-01, asked for on the
 * Workflow Agent Determination page, then on the other three). The symbol already says it and the
 * cell is narrow; `contains`, `is empty` and `is not empty` carry no symbol and no double space, so
 * they come back whole. It lives here because this is where COMPARISONS itself lives - the text is
 * still defined once, and this only chooses which half of it a picker shows.
 */
function symbolOnly(text) {
  return String(text === null || text === undefined ? '' : text).trim().split('  ')[0].trim();
}

/** The two that answer a question *about* emptiness, so they still fire on an empty field. */
const EMPTINESS_COMPARISONS = Object.freeze(['empty', 'notEmpty']);

/**
 * A condition slot with no operator chosen. "Field is one of these values" is exactly what `eq`
 * means, and it is what every condition on these two tables meant before the column existed
 * (2026-09-02) - so no stored rule changed meaning and none had to be migrated.
 */
const DEFAULT_CONDITION_OPERATOR = 'eq';

/** A known operator, defaulting a blank or unusable one to `eq`, exactly as `conditionLogicOf`
 *  never leaves the AND/OR/NOR column unresolved. The read side always has one to apply. */
function operatorOf(raw) {
  const key = trimmed(raw);
  return COMPARISONS[key] ? key : DEFAULT_CONDITION_OPERATOR;
}

const text = (value) => String(value === null || value === undefined ? '' : value).trim().toLocaleUpperCase();

const numeric = (value) => {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (raw === '' || !Number.isFinite(Number(raw))) return null;
  return Number(raw);
};

/** -1 / 0 / 1, numerically when both sides are numbers and as trimmed upper-case text otherwise. */
function compare(left, right) {
  // A boolean compared against the text 'true' is the one non-string case worth naming: staging
  // holds real Booleans and the grid can only ever offer a steward a string.
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    const asBoolean = (value) => (typeof value === 'boolean' ? value : text(value) === 'TRUE' || text(value) === 'X');
    return Number(asBoolean(left)) - Number(asBoolean(right));
  }
  const a = numeric(left);
  const b = numeric(right);
  if (a !== null && b !== null) return Math.sign(a - b);
  const x = text(left);
  const y = text(right);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

const trimmed = (value) => String(value === null || value === undefined ? '' : value).trim();

// Where the Value column's two meanings are decided: a value resolving to a catalog field is a
// reference, anything else a literal. Catalog names are always dotted, so a literal cannot collide.
function readValueSpec(raw, model) {
  const value = trimmed(raw);
  if (!value) return { kind: 'literal', literal: '' };
  const reference = resolvePayloadField(value, model);
  return reference ? { kind: 'reference', reference } : { kind: 'literal', literal: value };
}

// A same-section reference reads the same row - one address, not the first one. Anywhere else takes
// that section's first value, and `undefined` when it has none: nothing to copy is not a blank.
function resolveValue(spec, payload, ownSection, model) {
  if (spec.kind === 'literal') return spec.literal;
  const { section, element } = spec.reference;
  if (section === ownSection) return undefined; // handled per row by resolveValueForRow
  const [first] = sectionRows(payload, section)
    .map(({ record }) => record[element])
    .filter((value) => !isEmptyValue(value));
  return first;
}

function resolveValueForRow(spec, payload, ownSection, row, model) {
  if (spec.kind === 'literal') return spec.literal;
  if (spec.reference.section === ownSection) {
    const value = row.record[spec.reference.element];
    return isEmptyValue(value) ? undefined : value;
  }
  return resolveValue(spec, payload, ownSection, model);
}

/**
 * The rule's conditions as specs, dropping the halves that carry no field.
 *
 * A condition value is a LIST (2026-08-21), so "Country is BE, NL, FR or DE" is one rule rather
 * than four. `value` is kept alongside it for the message text; the matching reads `values`. A
 * single stored value parses as a one-entry list, which is why no stored row had to change.
 */
function readConditions(rule, model) {
  return CONDITION_PAIRS
    .map((pair) => ({
      names: pair,
      field: trimmed(rule[pair.field]),
      operator: operatorOf(rule[pair.operator]),
      value: trimmed(rule[pair.value]),
      values: parseValueList(rule[pair.value]),
      logic: pair.logic ? trimmed(rule[pair.logic]) : null
    }))
    .filter((condition) => condition.field)
    .map((condition) => ({
      ...condition,
      resolved: resolvePayloadField(condition.field, model)
    }));
}

/**
 * One value against one condition, under the condition's own operator (2026-09-02 - "Condition 1
 * contains the field, the comparator, the values"). The same shape workflow-rules.js already had:
 *
 * - `empty`/`notEmpty` are read on the RAW value, because an empty value is exactly the thing they
 *   exist to notice - filtering it out first would make them answer about nothing.
 * - `eq` keeps the wildcard and multi-value matching every condition column in this app has. `*`
 *   only ever meant "equal to, loosely", so it stays scoped to the operator that means equality.
 * - Every other operator is OR across the listed values, so `Country != BE, NL` holds on a value
 *   that differs from either.
 */
function conditionMatches(condition, value) {
  const comparison = COMPARISONS[condition.operator] || COMPARISONS[DEFAULT_CONDITION_OPERATOR];
  if (EMPTINESS_COMPARISONS.includes(condition.operator)) return comparison.apply(value);
  if (isEmptyValue(value)) return false;
  // A condition with nothing to compare against narrows nothing and must not match everything:
  // saving one is refused up front, so this is the backstop for a rule that arrived some other way.
  if (!condition.values.length) return false;
  if (condition.operator === 'eq') return listMatches(condition.values, value, compare);
  return condition.values.some((expected) => comparison.apply(value, expected));
}

// Scoping, worth reading twice: a condition on the rule's OWN section is evaluated per row, so it
// narrows to the matching rows. On any other section it is about the partner, so any row satisfies it.
function conditionHolds(condition, payload, ownSection, row, model) {
  if (!condition.resolved) return false;
  const { section, element } = condition.resolved;
  // OR across the values: one of them matching is what makes the condition hold.
  const matches = (value) => conditionMatches(condition, value);
  if (section === ownSection && row) return matches(row.record[element]);
  return sectionRows(payload, section).some(({ record }) => matches(record[element]));
}

// Folded left to right under each condition's own preceding Logic column; one condition is itself
// and no condition holds. A slot with no logic stored falls back to the rule's first one, and an
// unset column reads as AND - which is what `.every()` did before any of this existed.
function conditionsHold(conditions, payload, ownSection, row, model, logic) {
  return foldConditions(
    conditions.map((condition) => conditionHolds(condition, payload, ownSection, row, model)),
    conditions.map((condition) => condition.logic || logic)
  );
}

const label = (resolved) => `${resolved.section} ${humanise(resolved.element)}`;

// A steward wrote `eq`, but the message a requester reads should say what they meant.
const OPERATOR_TEXT = Object.freeze({
  eq: 'must be', ne: 'must not be', lt: 'must be less than', le: 'must be at most',
  gt: 'must be greater than', ge: 'must be at least', contains: 'must contain'
});

// `logic` is in the sentence because it changes what the rule means: a requester told "where A and
// B" about an OR rule has been told something untrue about why it fired.
function describeCondition(conditions, logic) {
  if (!conditions.length) return '';
  const clauses = conditions
    // Every value, not the raw stored string: a requester reading why a rule fired should see the
    // list it matched against rather than the delimiter it happens to be stored with. The operator
    // is said too (2026-09-02): "Country = BE" and "Country != BE" are different reasons, and a
    // sentence that reported both as `=` would be telling a requester something untrue.
    .map((condition) => {
      const comparison = COMPARISONS[condition.operator] || COMPARISONS[DEFAULT_CONDITION_OPERATOR];
      return comparison.needsValue === false
        ? `${condition.field} ${comparison.text}`
        : `${condition.field} ${symbolOnly(comparison.text)} ${condition.values.join(', ')}`;
    });
  if (clauses.length === 1) return ` (rule applies where ${clauses[0]})`;
  // Each gap has its own Logic column since 2026-09-01; `logic` is the fallback for a slot that
  // stored none, exactly as it is in conditionsHold.
  const wordAt = (index) => conditionLogicOf(conditions[index].logic || logic);
  // NOR is the one that cannot be written as a join, so it is said as what it means. Only for the
  // two-clause case, which is what every row stored before there were five slots means.
  if (clauses.length === 2 && wordAt(1) === 'NOR') {
    return ` (rule applies where neither ${clauses[0]} nor ${clauses[1]})`;
  }
  // Left to right, the way the row reads and the way foldConditions evaluates it. Bracketed from
  // the third clause on: the fold has no precedence, and a flat "A or B and C" would read as if it
  // did.
  let sentence = clauses[0];
  for (let index = 1; index < clauses.length; index += 1) {
    const word = CONDITION_LOGIC[wordAt(index)].text.toLowerCase();
    sentence = index === 1
      ? `${sentence} ${word} ${clauses[index]}`
      : `(${sentence}) ${word} ${clauses[index]}`;
  }
  return ` (rule applies where ${sentence})`;
}

// --- Validation ------------------------------------------------------------

// One row -> its findings, over every row of its own section. An empty field produces nothing, and
// that is load-bearing: validations run before derivations, so it would block the one about to fill it.
function runValidationRule(rule, payload, model) {
  const resolved = resolvePayloadField(rule.field, model);
  const comparison = COMPARISONS[trimmed(rule.comparison)];
  // A rule that cannot be evaluated blocks, the same way a validation that throws does: silently
  // skipping it would let a request through on the strength of a check that never ran.
  if (!resolved || !comparison) {
    return [{
      severity: 'error',
      message: `The validation rule on “${trimmed(rule.field) || '(no field)'}” cannot be evaluated`
        + ` (${!resolved ? 'unknown field' : `unknown comparison “${trimmed(rule.comparison)}”`}).`
        + ' Correct it in the Validation Rules table.'
    }];
  }

  const severity = SEVERITIES.includes(trimmed(rule.severity)) ? trimmed(rule.severity) : 'error';
  const conditions = readConditions(rule, model);
  const spec = readValueSpec(rule.value, model);
  const checksEmptiness = EMPTINESS_COMPARISONS.includes(trimmed(rule.comparison));
  const findings = [];

  for (const row of sectionRows(payload, resolved.section)) {
    if (!conditionsHold(conditions, payload, resolved.section, row, model, rule.conditionLogic)) continue;
    const actual = row.record[resolved.element];
    if (isEmptyValue(actual) && !checksEmptiness) continue;

    const expected = resolveValueForRow(spec, payload, resolved.section, row, model);
    // Nothing to compare against: a rule pointed at an empty field cannot be a verdict on the
    // field it is validating, so it reports itself instead of failing quietly either way.
    if (comparison.needsValue && expected === undefined) {
      if (spec.kind === 'reference') {
        findings.push({
          severity: 'info',
          target: targetFor(resolved.section),
          index: row.index,
          field: resolved.element,
          message: `${label(resolved)} could not be checked: ${spec.reference.field} has no value to compare against.`
        });
      }
      continue;
    }

    if (comparison.apply(actual, expected)) continue;

    const wanted = spec.kind === 'reference'
      ? `${OPERATOR_TEXT[trimmed(rule.comparison)] || trimmed(rule.comparison)} ${spec.reference.field} (${expected})`
      : `${OPERATOR_TEXT[trimmed(rule.comparison)] || trimmed(rule.comparison)} ${expected}`;
    const message = checksEmptiness
      ? `${label(resolved)} ${trimmed(rule.comparison) === 'notEmpty' ? 'is required' : 'must be empty'}`
        + `${describeCondition(conditions, rule.conditionLogic)}.`
      : `${label(resolved)} ${wanted}, but it is “${actual}”${describeCondition(conditions, rule.conditionLogic)}.`;

    findings.push({
      severity,
      target: targetFor(resolved.section),
      index: row.index,
      field: resolved.element,
      message
    });
  }
  return findings;
}

// --- Derivation ------------------------------------------------------------

// One row -> its pipeline entries. Not-overwriting stays in pipeline.js so these and the registry's
// derivations cannot disagree about it, and a row that does not exist is never invented.
/**
 * A rule whose target section holds no rows proposes the row rather than filling one. There is no
 * flag on the rule: an empty section is the trigger, so conditions met are all it takes.
 *
 * Returns nothing when the section already holds a row carrying this value. That is what
 * makes pressing Check twice add one row rather than two, and what leaves a row the
 * requester added by hand alone.
 */
function createdRowEntry(rule, resolved, conditions, spec, payload, model) {
  // An EMPTY synthetic row, not null: a condition on the rule's own section is then evaluated
  // against a row where every field is empty, so it cannot hold. That is what stops a rule
  // inventing a row out of its own emptiness, and it is why no save-time refusal is needed for it.
  if (!conditionsHold(conditions, payload, resolved.section, { index: 0, record: {} }, model, rule.conditionLogic)) return [];

  const value = resolveValue(spec, payload, resolved.section, model);
  if (isEmptyValue(value)) return [];

  const already = sectionRows(payload, resolved.section)
    .some(({ record }) => compare(record[resolved.element], value) === 0);
  if (already) return [];

  return [{
    target: targetFor(resolved.section),
    // Always the first row: only an empty section gets here, and the pipeline restates it from
    // where the row actually landed.
    index: 0,
    createsRow: true,
    label: 'Derivation rule',
    field: resolved.element,
    value,
    message: `A ${resolved.section} row was added with ${humanise(resolved.element)} `
      + `“${value}”${describeCondition(conditions, rule.conditionLogic)}.`
  }];
}

function runDerivationRule(rule, payload, model, mode = 'both') {
  const resolved = resolvePayloadField(rule.field, model);
  if (!resolved) {
    return [{
      message: `The derivation rule on “${trimmed(rule.field) || '(no field)'}” names a field that is not in`
        + ' the catalog, so nothing was filled in. Correct it in the Derivation Rules table.'
    }];
  }

  const conditions = readConditions(rule, model);
  const spec = readValueSpec(rule.value, model);
  const entries = [];

  // Whether this rule adds the row or fills one is decided by the PAYLOAD, not by a flag on the
  // rule: a section with no rows gets the row proposed, a section with rows gets its gaps filled
  // (2026-08-20). Conditions met are enough - the requester should not have to press Add first, and
  // should not have to tick a second box either.
  //
  // `mode` is how the two stages are kept apart: the adders all run before the fillers, so a filler
  // finds the row another rule just proposed. See createConfiguredStages.
  const rows = sectionRows(payload, resolved.section);
  const addsRow = !rows.length && targetFor(resolved.section) !== ROOT_TARGET;
  if (addsRow) {
    return mode === 'fill' ? [] : createdRowEntry(rule, resolved, conditions, spec, payload, model);
  }
  if (mode === 'create') return [];

  for (const row of rows) {
    if (!conditionsHold(conditions, payload, resolved.section, row, model, rule.conditionLogic)) continue;
    // Already filled: the pipeline would refuse to overwrite it anyway, and proposing a value for
    // a field that has one is a normalisation, which is a different stage and a different consent.
    if (!isEmptyValue(row.record[resolved.element])) continue;

    const value = resolveValueForRow(spec, payload, resolved.section, row, model);
    // A reference to an empty field is nothing to copy - not a reason to write a blank.
    if (isEmptyValue(value)) continue;

    entries.push({
      target: targetFor(resolved.section),
      index: row.index,
      createRow: row.createRow || undefined,
      label: 'Derivation rule',
      field: resolved.element,
      value,
      message: spec.kind === 'reference'
        ? `${label(resolved)} was filled in as “${value}”, copied from ${spec.reference.field}`
          + `${describeCondition(conditions, rule.conditionLogic)}.`
        : `${label(resolved)} was filled in as “${value}”${describeCondition(conditions, rule.conditionLogic)}.`
    });
  }
  return entries;
}

// --- Save-time validation of the rows themselves ---------------------------

/** The condition halves both tables share. Half a condition is the dangerous half. */
function conditionProblems(rule, model) {
  const errors = [];
  for (const pair of CONDITION_PAIRS) {
    const field = trimmed(rule[pair.field]);
    const operator = trimmed(rule[pair.operator]);
    const values = parseValueList(rule[pair.value]);
    // Blank is fine - it reads as `eq`, which is what every row stored before the column existed
    // means. Anything else unrecognised is refused rather than quietly read as equality.
    if (operator && !COMPARISONS[operator]) {
      errors.push({
        field: pair.operator,
        message: `“${operator}” is not a comparison (${Object.keys(COMPARISONS).join(', ')}).`
      });
    }
    const needsValue = COMPARISONS[operatorOf(operator)].needsValue !== false;
    if (field && !resolvePayloadField(field, model)) {
      errors.push({ field: pair.field, message: `“${field}” is not a field in the catalog.` });
    }
    // A field with no value would match every record, which is the opposite of a condition - except
    // under `is empty`/`is not empty`, which are a complete condition with no value by definition.
    if (field && needsValue && !values.length) {
      errors.push({ field: pair.value, message: 'A condition field needs a value. Leave both empty for “any”.' });
    }
    if (values.length && !field) {
      errors.push({ field: pair.field, message: 'A condition value needs a field.' });
    }
    // Every Logic column, not only the first: a slot the page never revealed carries nothing and
    // reads as AND, so this only ever fires on a value a direct call invented.
    if (!pair.logic) continue;
    const logicProblem = conditionLogicError(rule[pair.logic]);
    if (logicProblem) errors.push({ field: pair.logic, message: logicProblem });
  }
  return errors;
}

// Caught at the keyboard, like `validateRule`: by the time the engine reports an unrunnable rule,
// the check has already answered.
function validateValidationRule(rule = {}, model) {
  const errors = conditionProblems(rule, model);
  const warnings = [];
  const field = trimmed(rule.field);
  const comparison = trimmed(rule.comparison);
  const severity = trimmed(rule.severity);

  if (!resolvePayloadField(field, model)) {
    errors.push({ field: 'field', message: `“${field || '(empty)'}” is not a field in the catalog.` });
  }
  if (!COMPARISONS[comparison]) {
    errors.push({
      field: 'comparison',
      message: `“${comparison || '(empty)'}” is not an available comparison (${Object.keys(COMPARISONS).join(', ')}).`
    });
  }
  if (severity && !SEVERITIES.includes(severity)) {
    errors.push({ field: 'severity', message: `“${severity}” is not a severity (${SEVERITIES.join(', ')}).` });
  }

  const value = trimmed(rule.value);
  if (COMPARISONS[comparison]?.needsValue && !value) {
    errors.push({ field: 'value', message: `A “${COMPARISONS[comparison].text.trim()}” rule needs a value.` });
  }
  if (COMPARISONS[comparison] && !COMPARISONS[comparison].needsValue && value) {
    warnings.push({ field: 'value', message: `A “${comparison}” rule ignores its value.` });
  }
  return { errors, warnings };
}

function validateDerivationRule(rule = {}, model) {
  const errors = conditionProblems(rule, model);
  const warnings = [];
  const field = trimmed(rule.field);
  const resolved = resolvePayloadField(field, model);
  const value = trimmed(rule.value);

  if (!resolved) {
    errors.push({ field: 'field', message: `“${field || '(empty)'}” is not a field in the catalog.` });
  }
  if (!value) {
    errors.push({ field: 'value', message: 'A derivation needs a value, or a field to copy it from.' });
  }

  const spec = readValueSpec(value, model);
  // Copying a field onto itself never fills anything: the target is empty exactly when the source is.
  if (spec.kind === 'reference' && resolved && spec.reference.field === resolved.field) {
    errors.push({ field: 'value', message: 'A derivation cannot copy a field onto itself.' });
  }
  // Worth saying out loud, because it is the one case where the Value column's two meanings could
  // surprise someone: they typed something dotted and got a reference.
  if (spec.kind === 'reference') {
    warnings.push({
      field: 'value',
      message: `This copies the value of ${spec.reference.field} rather than writing the text “${value}”.`
    });
  }
  // No refusals for the row-adding case: with no checkbox there is nothing to misconfigure. A
  // condition on the rule's own section cannot hold against the empty row, and a value copied out
  // of the section being added resolves empty and proposes nothing - both simply do not fire.
  return { errors, warnings };
}

const usable = (rows, validate, model) =>
  (Array.isArray(rows) ? rows : [])
    .filter((row) => row.isActive !== false)
    .filter((row) => !validate(row, model).errors.length);

/**
 * One stage per kind, not one per rule: the pipeline blocks on the first error, and twenty rules
 * should report twenty problems. Ordered by `sequence`, so competing derivations resolve predictably.
 * Unusable rows are dropped rather than run - unlike the duplicate check there are no defaults to
 * fall back to, and inventing a rule nobody configured would be worse than running none.
 */
function createConfiguredStages({ validations = [], derivations = [], model } = {}) {
  const bySequence = (a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
  const validationRows = usable(validations, validateValidationRule, model).sort(bySequence);
  const derivationRows = usable(derivations, validateDerivationRule, model).sort(bySequence);

  const stages = { validations: [], derivations: [] };
  if (validationRows.length) {
    stages.validations.push({
      name: 'configured_validation',
      run: async (payload) => validationRows.flatMap((rule) => runValidationRule(rule, payload, model))
    });
  }
  // Two stages, and the row-adding one first. Every rule in a single stage sees the same
  // payload - the pipeline applies a stage's entries only after it returns - so a gap-filler
  // sharing a stage with the rule that adds its row would run against a payload where that
  // row does not exist yet, and fill nothing. Splitting them is what lets "role FLVN01 in BE
  // means purchasing organisation 1710" be followed by "and its currency is EUR".
  //
  // So `sequence` orders rules within each kind, not across them: adding always precedes
  // filling. Ordering them the other way round would only ever fill rows nobody added.
  //
  // Which rule adds and which fills is not known until the payload is in hand, so both stages run
  // every rule and `mode` decides what each may emit.
  if (derivationRows.length) {
    stages.derivations.push({
      name: 'configured_derivation_rows',
      run: async (payload) => derivationRows.flatMap((rule) => runDerivationRule(rule, payload, model, 'create'))
    });
    stages.derivations.push({
      name: 'configured_derivation',
      run: async (payload) => derivationRows.flatMap((rule) => runDerivationRule(rule, payload, model, 'fill'))
    });
  }
  return stages;
}

module.exports = {
  CONDITION_PAIRS,
  MAX_CONDITIONS,
  COMPARISONS,
  symbolOnly,
  EMPTINESS_COMPARISONS,
  DEFAULT_CONDITION_OPERATOR,
  operatorOf,
  SEVERITIES,
  OPERATOR_TEXT,
  compare,
  readValueSpec,
  readConditions,
  conditionHolds,
  conditionsHold,
  runValidationRule,
  runDerivationRule,
  validateValidationRule,
  validateDerivationRule,
  createConfiguredStages
};
