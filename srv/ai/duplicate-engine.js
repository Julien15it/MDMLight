'use strict';

const { DUPLICATE_THRESHOLD, scoreFingerprint, diceSimilarity } = require('./name-match');
const { CONDITION_FIELDS, buildCandidate, resolveField } = require('./duplicate-fields');
const {
  parseValueList, hasWildcard, normalisePattern, wildcardMatches, foldConditions
} = require('../checks/value-lists');
// The CONDITION comparators, not this file's own `COMPARISONS` (which is how two RECORDS are
// matched - exact, fuzzy, raw_dice). One vocabulary for every rule table's condition column, so a
// steward reading `!=` on one page cannot get a different answer on another.
const {
  COMPARISONS: CONDITION_COMPARISONS, EMPTINESS_COMPARISONS, DEFAULT_CONDITION_OPERATOR, operatorOf
} = require('../checks/rule-engine');

// `disqualifying` is negative evidence and never competes for strongest-per-field, so it has no
// rank. Without it, escalating a name-only match would rate a sparse candidate above a rich one.
const DISQUALIFYING = 'disqualifying';
const INDICATORS = Object.freeze(['weak', 'strong', 'definitive', DISQUALIFYING]);
const INDICATOR_RANK = Object.freeze({ weak: 1, strong: 2, definitive: 3 });

const VERDICTS = Object.freeze({
  DUPLICATE: 'duplicate',
  STRONG: 'strong',
  SMALL: 'small',
  NONE: 'none'
});
const VERDICT_RANK = Object.freeze({ none: 0, small: 1, strong: 2, duplicate: 3 });

// Rows 5 and 6 are what make a name-only candidate safe to escalate: a differing identifier or
// country rules the pair out before any name score gets to vote.
const DEFAULT_RULES = Object.freeze([
  Object.freeze({ sequence: 5, field: 'TaxNumber', comparison: 'exact', indicator: DISQUALIFYING }),
  Object.freeze({ sequence: 6, field: 'Country', comparison: 'exact', indicator: DISQUALIFYING }),
  Object.freeze({ sequence: 10, field: 'TaxNumber', comparison: 'exact', indicator: 'definitive' }),
  Object.freeze({ sequence: 20, field: 'Name', comparison: 'exact', indicator: 'definitive' }),
  Object.freeze({ sequence: 25, field: 'Name', comparison: 'fuzzy', threshold: 0.92, indicator: 'definitive' }),
  Object.freeze({
    sequence: 30,
    field: 'Name',
    comparison: 'fuzzy',
    threshold: DUPLICATE_THRESHOLD,
    indicator: 'strong'
  })
]);

const CONDITION_COLUMNS = Object.freeze({
  Country: 'condCountry',
  Category: 'condCategory',
  Grouping: 'condGrouping',
  Role: 'condRole'
});

// Five independent condition slots (two until 2026-09-01), joined by the Logic column sitting
// between each pair: "Role = Vendor AND Country = BE". Any may be left empty, which means "any" -
// an empty slot never narrows. `logic` names the column joining a slot to the one BEFORE it, null
// on the first; the fold is left to right, see foldConditions in srv/checks/value-lists.js.
const CONDITION_PAIRS = Object.freeze([
  Object.freeze({ field: 'conditionField', operator: 'conditionOperator', value: 'conditionValue', logic: null }),
  Object.freeze({ field: 'conditionField2', operator: 'conditionOperator2', value: 'conditionValue2', logic: 'conditionLogic' }),
  Object.freeze({ field: 'conditionField3', operator: 'conditionOperator3', value: 'conditionValue3', logic: 'conditionLogic2' }),
  Object.freeze({ field: 'conditionField4', operator: 'conditionOperator4', value: 'conditionValue4', logic: 'conditionLogic3' }),
  Object.freeze({ field: 'conditionField5', operator: 'conditionOperator5', value: 'conditionValue5', logic: 'conditionLogic4' })
]);

/** How many slots the schema carries - the page's own Add Condition ceiling. */
const MAX_CONDITIONS = CONDITION_PAIRS.length;

const COMPARISONS = Object.freeze({
  exact: (left, right) => (left === right ? 1 : 0),
  contains: (left, right) => (left.includes(right) || right.includes(left) ? 1 : 0),
  // The name matcher's own scorer, so a name rule keeps behaving exactly as it does today.
  fuzzy: (left, right) => (left === right ? 1 : scoreFingerprint(left, right)),
  raw_dice: (left, right) => diceSimilarity(left, right)
});

// `semantic` is deliberately absent: it needs a vector store we do not have, so a rule using it
// falls out as unevaluated rather than as a silent non-match.

/**
 * The bag has to be built over the fields the rules name, not over the catalog keys: a dynamic
 * `TaxNumber.<type>` field has no catalog key, so a bag built from the catalog would leave the rule
 * comparing against nothing and scoring zero in silence.
 */
function requiredFields(rules = []) {
  const fields = new Set(CONDITION_FIELDS);
  for (const rule of rules) {
    if (rule?.field) fields.add(rule.field);
    // The condition fields are free-form, so the bag has to carry them too.
    for (const pair of CONDITION_PAIRS) {
      if (rule?.[pair.field]) fields.add(rule[pair.field]);
    }
  }
  return [...fields];
}

function bagOf(record, fields) {
  if (!record) return {};
  const built = buildCandidate(record.partner || record, fields);
  // An index entry already carries name fingerprints; reuse them rather than re-normalising.
  if (!built.Name && Array.isArray(record.fingerprints) && record.fingerprints.length) {
    built.Name = [...record.fingerprints];
  }
  return built;
}

/**
 * One condition, against the candidate's bag of normalised values. The wanted value is a LIST
 * (2026-08-21) and the entries are OR: "Country is BE, NL, FR or DE" is one rule. A single stored
 * value parses as a one-entry list, so rows written before that change behave exactly as they did.
 */
function holds(field, wanted, bag, operator = DEFAULT_CONDITION_OPERATOR) {
  const values = parseValueList(wanted);
  const comparison = CONDITION_COMPARISONS[operator] || CONDITION_COMPARISONS[DEFAULT_CONDITION_OPERATOR];
  // The comparator (2026-09-02, asked for): a condition here is field/comparator/values, the same
  // as one on the Workflow Agent Determination page. The bag holds NORMALISED values, so
  // "is empty" is "this partner has no value for that field at all" - it is answered on the bag
  // rather than on any one value, and needs no listed value to compare against.
  if (EMPTINESS_COMPARISONS.includes(operator)) {
    const held = (bag[field] || []).filter((entry) => entry !== '' && entry !== null && entry !== undefined);
    return operator === 'empty' ? !held.length : held.length > 0;
  }
  // An empty pair means "any", which is the whole reason both halves are optional.
  if (!values.length) return true;
  const resolved = resolveField(field);
  // An unresolvable condition field cannot be satisfied, so the rule stays out rather than
  // matching everything. Saving one is rejected up front; this is the backstop.
  if (!resolved) return false;
  // A pattern is normalised segment by segment, or `alnumUpper` would strip the `*` out of
  // `FLVN*` and the rule would look for a role literally called FLVN.
  const normalised = values
    .map((value) => (hasWildcard(value)
      ? normalisePattern(value, (segment) => resolved.entry.normalise(segment, {}))
      : resolved.entry.normalise(value, {})))
    .filter(Boolean);
  // Nothing left to compare: the same case a single unnormalisable value was, and it narrows
  // nothing rather than ruling the rule out.
  if (!normalised.length) return true;
  const held = bag[field] || [];
  // `eq` keeps the wildcard matching every condition column in this app has - `*` only ever meant
  // "equal to, loosely", so it stays scoped to the operator that means equality.
  if (operator === DEFAULT_CONDITION_OPERATOR) {
    return normalised.some((value) => (hasWildcard(value)
      ? held.some((entry) => wildcardMatches(value, entry))
      : held.includes(value)));
  }
  // Any other comparator compares the NORMALISED values, because normalised is all the bag holds:
  // comparing a raw `BE 0123` against a bag entry of `BE0123` would answer about a value the index
  // does not carry. OR across the listed values, and any held value satisfying it is enough - the
  // same "any value, any listed value" shape a condition on this table has always had.
  return held.some((entry) => normalised.some((value) => comparison.apply(entry, value)));
}

/**
 * A rule carries up to two conditions as field/value pairs — conditionField = Role, conditionValue
 * = Vendor, conditionField2 = Country, conditionValue2 = BE. Filled pairs are ANDed and an empty
 * pair means "any". The four fixed cond* columns are still honoured for rows written before that
 * change.
 */
function conditionsMatch(rule, bag) {
  // Only the pairs that actually say something take part in the join. A pair with a field and no
  // value means "any" and would make NOR read as "neither, and also not anything", which is never.
  const filled = CONDITION_PAIRS
    .filter((pair) => rule[pair.field] && (parseValueList(rule[pair.value]).length
      // `is empty`/`is not empty` are a COMPLETE condition with no value (2026-09-02): they would
      // otherwise be dropped here as half-written and the rule would stop narrowing at all.
      || EMPTINESS_COMPARISONS.includes(operatorOf(rule[pair.operator]))));
  const results = filled.map((pair) => holds(
    rule[pair.field], rule[pair.value], bag, operatorOf(rule[pair.operator])
  ));
  // Each surviving slot brings its OWN preceding Logic column, so dropping an empty slot drops the
  // join that sat beside it rather than shifting the next one onto the wrong pair.
  const logics = filled.map((pair) => (pair.logic ? rule[pair.logic] : null) || rule.conditionLogic);
  if (!foldConditions(results, logics)) return false;
  // The four superseded cond* columns are always ANDed onto the result: they predate the pairs and
  // the logic column describes the pairs, not them.
  for (const field of CONDITION_FIELDS) {
    if (!holds(field, rule[CONDITION_COLUMNS[field]], bag)) return false;
  }
  return true;
}

// Both sides must satisfy the conditions: a rule written for Belgian partners says nothing about
// a Belgian record compared with a German one.
function applicableRules(rules, leftBag, rightBag) {
  return rules.filter((rule) => rule.isActive !== false
    && conditionsMatch(rule, leftBag)
    && conditionsMatch(rule, rightBag));
}

/**
 * Blank is never a match. Two partners that both lack a VAT number must not count as an exact
 * match on VAT — the criterion contributes nothing instead of contributing a match.
 */
function compareValues(comparison, leftValues = [], rightValues = [], threshold) {
  const compare = COMPARISONS[comparison];
  if (!compare || !leftValues.length || !rightValues.length) return 0;
  let best = 0;
  for (const left of leftValues) {
    for (const right of rightValues) {
      const score = compare(left, right);
      if (score > best) best = score;
    }
  }
  return best >= threshold ? best : 0;
}

function ruleThreshold(rule) {
  const configured = Number(rule.threshold);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return rule.comparison === 'fuzzy' || rule.comparison === 'raw_dice' ? DUPLICATE_THRESHOLD : 1;
}

/**
 * Rows are additive, but where more than one matching row targets the same field the strongest
 * indicator wins and the field contributes once — counting it twice would inflate the verdict.
 */
function indicatorsFor(candidateBag, otherBag, rules) {
  const strongest = new Map();
  const unrunnable = [];
  let disqualifiedBy = null;
  for (const rule of applicableRules(rules, candidateBag, otherBag)) {
    // An unrunnable rule must not read as "no duplicate" — that is the dangerous answer.
    const reason = !resolveField(rule.field) ? 'unknown_field'
      : !COMPARISONS[rule.comparison] ? 'unsupported_comparison'
        : !INDICATORS.includes(rule.indicator) ? 'unknown_indicator'
          : '';
    if (reason) {
      unrunnable.push({ field: rule.field, comparison: rule.comparison, reason });
      continue;
    }
    const left = candidateBag[rule.field] || [];
    const right = otherBag[rule.field] || [];
    const score = compareValues(rule.comparison, left, right, ruleThreshold(rule));
    if (rule.indicator === DISQUALIFYING) {
      // Present-and-different rules the pair out; blank on either side still says nothing.
      if (left.length && right.length && !score) {
        disqualifiedBy = { field: rule.field, comparison: rule.comparison };
      }
      continue;
    }
    if (!score) continue;
    const found = { field: rule.field, comparison: rule.comparison, indicator: rule.indicator, score };
    const previous = strongest.get(rule.field);
    if (!previous
      || INDICATOR_RANK[found.indicator] > INDICATOR_RANK[previous.indicator]
      || (INDICATOR_RANK[found.indicator] === INDICATOR_RANK[previous.indicator] && found.score > previous.score)) {
      strongest.set(rule.field, found);
    }
  }
  return {
    indicators: disqualifiedBy ? [] : [...strongest.values()],
    unrunnable,
    disqualifiedBy
  };
}

// Fixed in code, not configurable: a configurable ladder makes every result impossible to explain.
function verdictFor(indicators = []) {
  if (indicators.some((found) => found.indicator === 'definitive')) return VERDICTS.DUPLICATE;
  const strong = indicators.filter((found) => found.indicator === 'strong').length;
  const weak = indicators.filter((found) => found.indicator === 'weak').length;
  if (indicators.length >= 2 && strong >= 1) return VERDICTS.STRONG;
  if (strong === 1 || weak >= 2) return VERDICTS.SMALL;
  return VERDICTS.NONE;
}

function bestScore(indicators = []) {
  return Math.max(0, ...indicators.map((found) => found.score));
}

/**
 * The one duplicate check. Every caller builds a candidate field bag and calls this, so the
 * assistant, the change-request submit and the admin test button cannot drift apart.
 */
function evaluate(candidate, entries = [], { rules = DEFAULT_RULES, limit = Infinity, excludeId } = {}) {
  const active = rules.filter((rule) => rule.isActive !== false);
  const fields = requiredFields(active);
  const candidateBag = bagOf(candidate, fields);
  const results = [];
  const unrunnableRules = new Map();

  for (const entry of entries) {
    const partner = entry?.partner || entry;
    const id = partner?.BusinessPartner;
    if (excludeId !== undefined && id !== undefined && String(id) === String(excludeId)) continue;
    const { indicators, unrunnable } = indicatorsFor(candidateBag, bagOf(entry, fields), active);
    for (const rule of unrunnable) unrunnableRules.set(`${rule.field}:${rule.comparison}`, rule);
    const verdict = verdictFor(indicators);
    if (verdict === VERDICTS.NONE) continue;
    results.push({ partner, verdict, indicators, score: bestScore(indicators) });
  }

  results.sort((left, right) => VERDICT_RANK[right.verdict] - VERDICT_RANK[left.verdict]
    || right.score - left.score);
  const ranked = results.slice(0, limit);
  // Non-enumerable so callers can keep treating the result as a plain array of matches. This is a
  // config-health signal for the admin page and the log, never something to show an end user.
  Object.defineProperty(ranked, 'unrunnableRules', { value: [...unrunnableRules.values()] });
  return ranked;
}

module.exports = {
  DISQUALIFYING,
  INDICATORS,
  INDICATOR_RANK,
  VERDICTS,
  VERDICT_RANK,
  DEFAULT_RULES,
  COMPARISONS,
  CONDITION_PAIRS,
  MAX_CONDITIONS,
  requiredFields,
  bagOf,
  conditionsMatch,
  applicableRules,
  compareValues,
  ruleThreshold,
  indicatorsFor,
  verdictFor,
  evaluate
};
