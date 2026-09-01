'use strict';

const { resolveField, isIndexedField, catalogFields } = require('./duplicate-fields');
const { parseValueList, conditionLogicError } = require('../checks/value-lists');
const { COMPARISONS, INDICATORS, DEFAULT_RULES, CONDITION_PAIRS } = require('./duplicate-engine');
// The CONDITION comparators, told apart from the record-matching COMPARISONS above by their name -
// one vocabulary for every rule table's condition column. See srv/checks/rule-engine.js.
const {
  COMPARISONS: CONDITION_COMPARISONS, EMPTINESS_COMPARISONS, operatorOf
} = require('../checks/rule-engine');
const { DUPLICATE_THRESHOLD } = require('./name-match');

const FUZZY_COMPARISONS = Object.freeze(['fuzzy', 'raw_dice']);
const RULE_CACHE_TTL_MS = 60000;

const CONDITION_COLUMNS = Object.freeze(['condCountry', 'condCategory', 'condGrouping', 'condRole']);

function trimmed(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

// One condition pair off a stored row, with the column names kept so a message can point at the
// cell the steward has to fix. `value` is what is stored and what travels to the engine - a
// delimited LIST since 2026-08-21 - and `values` is that list, for anything counting entries.
function readCondition(row, pair) {
  const value = trimmed(row[pair.value]);
  return {
    field: trimmed(row[pair.field]),
    // The comparator (2026-09-02): blank reads as `eq`, which is what every condition on this
    // table meant before there was one to choose.
    operator: operatorOf(row[pair.operator]),
    value,
    values: parseValueList(value),
    names: pair
  };
}

/**
 * Validated on save rather than at match time. The engine already reports a rule it cannot run,
 * but by then the check has run and reported nothing — and "no duplicates found" from a rule that
 * never fired is the one answer this must not give. Catching it at the keyboard is the guard.
 */
function validateRule(row = {}) {
  const errors = [];
  const warnings = [];
  const field = String(row.field || '').trim();
  const comparison = String(row.comparison || '').trim();
  const indicator = String(row.indicator || '').trim();

  if (!resolveField(field)) {
    errors.push({ field: 'field', message: `“${field || '(empty)'}” is not a field in the catalog.` });
  } else if (!isIndexedField(field)) {
    warnings.push({
      field: 'field',
      message: `The duplicate index does not carry ${field}, so this rule cannot match an existing partner.`
    });
  }

  if (!COMPARISONS[comparison]) {
    errors.push({
      field: 'comparison',
      message: `“${comparison || '(empty)'}” is not an available comparison (${Object.keys(COMPARISONS).join(', ')}).`
    });
  }

  if (!INDICATORS.includes(indicator)) {
    errors.push({
      field: 'indicator',
      message: `“${indicator || '(empty)'}” is not an indicator (${INDICATORS.join(', ')}).`
    });
  }

  // Conditions are field/value pairs from the same catalog, e.g. Role = Vendor and Country = BE.
  // Each pair stands on its own: neither, either or both may be filled.
  const conditions = CONDITION_PAIRS.map((pair) => readCondition(row, pair));
  for (const { field: conditionField, operator, values: conditionValues, names } of conditions) {
    const stored = trimmed(row[names.operator]);
    // Blank is fine - it reads as `eq`. Anything else unrecognised is refused rather than quietly
    // read as equality: the dropdown cannot produce one, so it can only arrive from a direct call.
    if (stored && !CONDITION_COMPARISONS[stored]) {
      errors.push({
        field: names.operator,
        message: `“${stored}” is not a comparison (${Object.keys(CONDITION_COMPARISONS).join(', ')}).`
      });
    }
    if (conditionField && !resolveField(conditionField)) {
      errors.push({ field: names.field, message: `“${conditionField}” is not a field in the catalog.` });
    }
    // Half a condition is the dangerous half: a field with no value would match everything - except
    // under `is empty`/`is not empty`, which are a whole condition with no value by definition.
    if (conditionField && !conditionValues.length && !EMPTINESS_COMPARISONS.includes(operator)) {
      errors.push({ field: names.value, message: 'A condition field needs a value. Leave both empty for “any”.' });
    }
    if (conditionValues.length && !conditionField) {
      errors.push({ field: names.field, message: 'A condition value needs a field.' });
    }
  }
  // The same field twice is deliberately allowed: a bag holds every value a partner has, so
  // Role = Vendor and Role = Customer selects partners that are both, which is a real rule.

  // Absent is fine — a fuzzy rule takes the default threshold. Present but unusable is not.
  const threshold = row.threshold === null || row.threshold === undefined || row.threshold === ''
    ? null
    : Number(row.threshold);
  if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) {
    errors.push({ field: 'threshold', message: 'A threshold must be above 0 and at most 1.' });
  } else if (threshold !== null && !FUZZY_COMPARISONS.includes(comparison)) {
    warnings.push({ field: 'threshold', message: `A ${comparison || 'non-fuzzy'} comparison ignores its threshold.` });
  }

  // Every Logic column, not only the first: a slot the page never revealed carries nothing and reads
  // as AND, so this only ever fires on a value a direct call invented.
  for (const pair of CONDITION_PAIRS) {
    if (!pair.logic) continue;
    const logicProblem = conditionLogicError(row[pair.logic]);
    if (logicProblem) errors.push({ field: pair.logic, message: logicProblem });
  }

  return { errors, warnings };
}

// The stored row is already the engine's rule shape; this only drops the columns it has no use for.
function toEngineRule(row = {}) {
  const rule = {
    sequence: row.sequence,
    field: String(row.field || '').trim(),
    comparison: String(row.comparison || '').trim(),
    indicator: String(row.indicator || '').trim(),
    isActive: row.isActive !== false
  };
  if (row.threshold !== null && row.threshold !== undefined && row.threshold !== '') {
    rule.threshold = Number(row.threshold);
  } else if (FUZZY_COMPARISONS.includes(rule.comparison)) {
    // The grid no longer asks for a threshold, so a fuzzy rule takes the tuned default.
    rule.threshold = DUPLICATE_THRESHOLD;
  }
  // Only a complete pair travels: half a condition would match everything, which is the opposite
  // of what a condition is for.
  for (const pair of CONDITION_PAIRS) {
    const { field, operator, value, values } = readCondition(row, pair);
    // The delimited list travels as it is stored: `holds` in the engine parses it, so nothing here
    // has to know how many values a condition carries. `is empty`/`is not empty` travel with no
    // value at all - dropping them as half-written would leave the rule narrowing nothing.
    if (field && (values.length || EMPTINESS_COMPARISONS.includes(operator))) {
      rule[pair.field] = field;
      rule[pair.operator] = operator;
      rule[pair.value] = value;
      // The Logic column travels WITH its slot. It never did before (found 2026-09-01 while adding
      // the extra slots): `conditionsMatch` reads `rule.conditionLogic`, `toEngineRule` never
      // copied it, so every duplicate rule was ANDed however the grid was set.
      if (pair.logic && row[pair.logic]) rule[pair.logic] = String(row[pair.logic]).trim();
    }
  }
  for (const column of CONDITION_COLUMNS) {
    const value = row[column];
    if (value !== null && value !== undefined && String(value).trim() !== '') rule[column] = String(value).trim();
  }
  return rule;
}

function usableRules(rows = []) {
  return rows.filter((row) => !validateRule(row).errors.length).map(toEngineRule);
}

/**
 * Holds the ruleset in memory so `activeRules()` can stay synchronous. Making it async would turn
 * half the service async for a table that changes a few times a year — `evaluate`,
 * `checkAgainstPartners` and the creation-suggestion chain are all synchronous today.
 */
function createRuleStore({ fallback = DEFAULT_RULES, now = Date.now, ttlMs = RULE_CACHE_TTL_MS } = {}) {
  let current = fallback;
  let source = 'defaults';
  let loadedAt = 0;
  let stale = true;
  let inFlight = null;

  function due() {
    return stale || !loadedAt || (now() - loadedAt) >= ttlMs;
  }

  async function load(readRows) {
    const rows = await readRows();
    const usable = usableRules(Array.isArray(rows) ? rows : []);
    const active = usable.filter((rule) => rule.isActive !== false);
    // An empty ruleset does not mean "check nothing", it means every check silently answers "no
    // duplicates". A fresh tenant, a failed read or a steward deactivating the last row must all
    // fall back to the code defaults rather than switch the control off.
    if (!active.length) {
      if (source !== 'defaults') console.warn('[duplicates] No usable configured rules — falling back to the defaults');
      current = fallback;
      source = 'defaults';
    } else {
      current = usable;
      source = 'configured';
    }
    loadedAt = now();
    stale = false;
    return { source, count: current.length, read: Array.isArray(rows) ? rows.length : 0 };
  }

  function refresh(readRows, { force = false } = {}) {
    if (inFlight) return inFlight;
    if (!force && !due()) {
      return Promise.resolve({ source, count: current.length, skipped: true });
    }
    inFlight = load(readRows)
      .catch((error) => {
        // Keep serving the rules already loaded; an unreachable table must not empty the check.
        console.warn('[duplicates] Rule configuration unavailable, keeping the loaded rules:', error.message);
        return { source, count: current.length, failed: true };
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    rules: () => current,
    source: () => source,
    markStale: () => { stale = true; },
    refresh,
    reset: () => { current = fallback; source = 'defaults'; loadedAt = 0; stale = true; }
  };
}

module.exports = {
  FUZZY_COMPARISONS,
  RULE_CACHE_TTL_MS,
  CONDITION_COLUMNS,
  CONDITION_PAIRS,
  catalogFields,
  validateRule,
  toEngineRule,
  usableRules,
  createRuleStore
};
