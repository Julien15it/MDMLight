'use strict';

const {
  resolvePayloadField, sectionRows, targetFor, isEmptyValue, humanise
} = require('./payload-fields');

/**
 * The evaluator for the configured validation and derivation tables.
 *
 * Deliberately deterministic and offline: these are the gating checks, so no rule
 * here may depend on a network call. VIES and GLEIF stay in
 * `srv/checks/registry-checks.js`, where an outage can be graded down to a
 * warning; a decision table that cannot be evaluated is a broken rule, not a
 * degraded one.
 *
 * Both kinds share their condition columns, and both are evaluated against the
 * **request payload** (`{ root, sections }`) through the qualified field catalog
 * in payload-fields.js.
 */

/** Mirrors CONDITION_PAIRS in srv/ai/duplicate-engine.js, over the same column names. */
const CONDITION_PAIRS = Object.freeze([
  Object.freeze({ field: 'conditionField', value: 'conditionValue' }),
  Object.freeze({ field: 'conditionField2', value: 'conditionValue2' })
]);

const SEVERITIES = Object.freeze(['error', 'warning', 'info']);

/**
 * `needsValue: false` means the Value column is meaningless for it, which is what
 * lets the grid disable the cell instead of letting someone fill in a value that
 * is silently ignored.
 *
 * `=` and `!=` are compared case-insensitively after trimming, because master
 * data arrives with both, and a rule that fails on ` be` vs `BE` is a rule nobody
 * trusts. The ordering comparisons compare numbers as numbers when both sides are
 * numeric - otherwise `9` would be greater than `10`.
 */
const COMPARISONS = Object.freeze({
  eq:       { text: '=  equal to',                 needsValue: true,  apply: (a, b) => compare(a, b) === 0 },
  ne:       { text: '!=  not equal to',            needsValue: true,  apply: (a, b) => compare(a, b) !== 0 },
  lt:       { text: '<  less than',                needsValue: true,  apply: (a, b) => compare(a, b) < 0 },
  le:       { text: '<=  at most',                 needsValue: true,  apply: (a, b) => compare(a, b) <= 0 },
  gt:       { text: '>  greater than',             needsValue: true,  apply: (a, b) => compare(a, b) > 0 },
  ge:       { text: '>=  at least',                needsValue: true,  apply: (a, b) => compare(a, b) >= 0 },
  contains: { text: 'contains',                    needsValue: true,  apply: (a, b) => text(a).includes(text(b)) },
  empty:    { text: 'is empty',                    needsValue: false, apply: (a) => isEmptyValue(a) },
  notEmpty: { text: 'has a value (required)',      needsValue: false, apply: (a) => !isEmptyValue(a) }
});

/** The two that answer a question *about* emptiness, so they still fire on an empty field. */
const EMPTINESS_COMPARISONS = Object.freeze(['empty', 'notEmpty']);

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

/**
 * The Value column means one of two things and this is where that is decided: a
 * value that resolves to a qualified catalog field is a **reference** to that
 * field, anything else is a literal. Catalog names are always dotted, so a
 * literal can never be mistaken for one.
 */
function readValueSpec(raw, model) {
  const value = trimmed(raw);
  if (!value) return { kind: 'literal', literal: '' };
  const reference = resolvePayloadField(value, model);
  return reference ? { kind: 'reference', reference } : { kind: 'literal', literal: value };
}

/**
 * The value a spec resolves to for one row of the rule's own section.
 *
 * A reference into the **same section** reads the same row - "fill this address's
 * Region from this address's Country" is about one address, not about the first
 * one. A reference anywhere else takes the first value that section actually
 * holds, and `undefined` when it holds none: a reference to an empty field is
 * nothing to copy, which is different from copying an empty string over it.
 */
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

/** The rule's conditions as specs, dropping the halves that carry no field. */
function readConditions(rule, model) {
  return CONDITION_PAIRS
    .map((pair) => ({ names: pair, field: trimmed(rule[pair.field]), value: trimmed(rule[pair.value]) }))
    .filter((condition) => condition.field)
    .map((condition) => ({
      ...condition,
      resolved: resolvePayloadField(condition.field, model)
    }));
}

/**
 * Does a condition hold, for a rule whose own field lives in `ownSection` and, when
 * the condition is on that same section, for this particular row?
 *
 * Scoping is the part worth reading twice. A condition on the **same section** as
 * the rule's field is evaluated **per row**: "where Addresses.Country = BE,
 * Addresses.Region must have a value" is about the Belgian address rows, not about
 * every address of a partner that happens to have one Belgian address. A condition
 * on any other section (or on General) is a statement about the partner, so it holds
 * when **any** row of that section matches.
 */
function conditionHolds(condition, payload, ownSection, row, model) {
  if (!condition.resolved) return false;
  const { section, element } = condition.resolved;
  const matches = (value) => compare(value, condition.value) === 0;
  if (section === ownSection && row) return matches(row.record[element]);
  return sectionRows(payload, section).some(({ record }) => matches(record[element]));
}

function conditionsHold(conditions, payload, ownSection, row, model) {
  return conditions.every((condition) => conditionHolds(condition, payload, ownSection, row, model));
}

const label = (resolved) => `${resolved.section} ${humanise(resolved.element)}`;

// A steward wrote `eq`, but the message a requester reads should say what they meant.
const OPERATOR_TEXT = Object.freeze({
  eq: 'must be', ne: 'must not be', lt: 'must be less than', le: 'must be at most',
  gt: 'must be greater than', ge: 'must be at least', contains: 'must contain'
});

function describeCondition(conditions) {
  if (!conditions.length) return '';
  return ` (rule applies where ${conditions
    .map((condition) => `${condition.field} = ${condition.value}`)
    .join(' and ')})`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * One stored row -> the findings it produces, over every row of its own section.
 *
 * A rule whose field is **empty produces nothing**, and that is load-bearing
 * rather than lenient: `pipeline.js` runs validations *before* derivations, so a
 * rule that failed on an empty field would block the derivation that was about to
 * fill it. `notEmpty` is how a steward says a field is required.
 */
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
    if (!conditionsHold(conditions, payload, resolved.section, row, model)) continue;
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
        + `${describeCondition(conditions)}.`
      : `${label(resolved)} ${wanted}, but it is “${actual}”${describeCondition(conditions)}.`;

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

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * One stored row -> the pipeline derivation entries it produces.
 *
 * Only the entries are produced here. **Not overwriting** is `pipeline.js`'s
 * rule and stays there, so the two kinds of derivation - these and the registry's
 * - cannot disagree about it. A row that does not exist is likewise not invented:
 * `sectionRows` simply yields nothing, and the pipeline says so for the registry
 * case where a value was found but has nowhere to go.
 */
function runDerivationRule(rule, payload, model) {
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

  for (const row of sectionRows(payload, resolved.section)) {
    if (!conditionsHold(conditions, payload, resolved.section, row, model)) continue;
    // Already filled: the pipeline would refuse to overwrite it anyway, and proposing a value for
    // a field that has one is a normalisation, which is a different stage and a different consent.
    if (!isEmptyValue(row.record[resolved.element])) continue;

    const value = resolveValueForRow(spec, payload, resolved.section, row, model);
    // A reference to an empty field is nothing to copy - not a reason to write a blank.
    if (isEmptyValue(value)) continue;

    entries.push({
      target: targetFor(resolved.section),
      index: row.index,
      field: resolved.element,
      value,
      message: spec.kind === 'reference'
        ? `${label(resolved)} was filled in as “${value}”, copied from ${spec.reference.field}`
          + `${describeCondition(conditions)}.`
        : `${label(resolved)} was filled in as “${value}”${describeCondition(conditions)}.`
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Save-time validation of the rows themselves
// ---------------------------------------------------------------------------

/** The condition halves both tables share. Half a condition is the dangerous half. */
function conditionProblems(rule, model) {
  const errors = [];
  for (const pair of CONDITION_PAIRS) {
    const field = trimmed(rule[pair.field]);
    const value = trimmed(rule[pair.value]);
    if (field && !resolvePayloadField(field, model)) {
      errors.push({ field: pair.field, message: `“${field}” is not a field in the catalog.` });
    }
    // A field with no value would match every record, which is the opposite of a condition.
    if (field && !value) {
      errors.push({ field: pair.value, message: 'A condition field needs a value. Leave both empty for “any”.' });
    }
    if (value && !field) {
      errors.push({ field: pair.field, message: 'A condition value needs a field.' });
    }
  }
  return errors;
}

/**
 * Caught at the keyboard rather than at check time, for the same reason
 * `validateRule` in srv/ai/rule-config.js is: by the time the engine reports a rule
 * it could not run, the check has already answered.
 */
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
  return { errors, warnings };
}

const usable = (rows, validate, model) =>
  (Array.isArray(rows) ? rows : [])
    .filter((row) => row.isActive !== false)
    .filter((row) => !validate(row, model).errors.length);

/**
 * The configured rows as pipeline stages.
 *
 * One stage per kind, not one per rule: the pipeline blocks on the first error a
 * validation stage reports, and a table of twenty rules should report all twenty
 * problems rather than the first one. Rows are ordered by `sequence` so two
 * derivations onto one field resolve predictably - the first to fill it wins,
 * because the pipeline never overwrites.
 *
 * Rules that fail their own save-time validation are dropped rather than run, and
 * an unusable table therefore contributes nothing instead of blocking every
 * request. The opposite choice for the duplicate check (falling back to built-in
 * defaults) does not apply here: there are no default validations, and inventing
 * one nobody configured would be worse than running none.
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
  if (derivationRows.length) {
    stages.derivations.push({
      name: 'configured_derivation',
      run: async (payload) => derivationRows.flatMap((rule) => runDerivationRule(rule, payload, model))
    });
  }
  return stages;
}

module.exports = {
  CONDITION_PAIRS,
  COMPARISONS,
  EMPTINESS_COMPARISONS,
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
