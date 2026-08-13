'use strict';

const { DUPLICATE_THRESHOLD, scoreFingerprint, diceSimilarity } = require('./name-match');
const { CONDITION_FIELDS, buildCandidate, resolveField } = require('./duplicate-fields');

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

// Two independent condition pairs, ANDed when both are filled: "Role = Vendor and Country = BE".
// Either may be left empty, which means "any" — an empty pair never narrows the rule.
const CONDITION_PAIRS = Object.freeze([
  Object.freeze({ field: 'conditionField', value: 'conditionValue' }),
  Object.freeze({ field: 'conditionField2', value: 'conditionValue2' })
]);

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

function holds(field, wanted, bag) {
  if (wanted === undefined || wanted === null || String(wanted).trim() === '') return true;
  const resolved = resolveField(field);
  // An unresolvable condition field cannot be satisfied, so the rule stays out rather than
  // matching everything. Saving one is rejected up front; this is the backstop.
  if (!resolved) return false;
  const normalised = resolved.entry.normalise(wanted, {});
  if (!normalised) return true;
  return (bag[field] || []).includes(normalised);
}

/**
 * A rule carries up to two conditions as field/value pairs — conditionField = Role, conditionValue
 * = Vendor, conditionField2 = Country, conditionValue2 = BE. Filled pairs are ANDed and an empty
 * pair means "any". The four fixed cond* columns are still honoured for rows written before that
 * change.
 */
function conditionsMatch(rule, bag) {
  for (const pair of CONDITION_PAIRS) {
    if (!holds(rule[pair.field], rule[pair.value], bag)) return false;
  }
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
