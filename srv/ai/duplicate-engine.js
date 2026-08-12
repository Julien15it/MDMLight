'use strict';

const { DUPLICATE_THRESHOLD, scoreFingerprint, diceSimilarity } = require('./name-match');
const { CONDITION_FIELDS, buildCandidate, resolveField } = require('./duplicate-fields');

const INDICATORS = Object.freeze(['weak', 'strong', 'definitive']);
const INDICATOR_RANK = Object.freeze({ weak: 1, strong: 2, definitive: 3 });

const VERDICTS = Object.freeze({
  DUPLICATE: 'duplicate',
  STRONG: 'strong',
  SMALL: 'small',
  NONE: 'none'
});
const VERDICT_RANK = Object.freeze({ none: 0, small: 1, strong: 2, duplicate: 3 });

// Config lives in rows, so today's hard-coded check is expressible as a single row.
const DEFAULT_RULES = Object.freeze([
  Object.freeze({
    sequence: 10,
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

const COMPARISONS = Object.freeze({
  exact: (left, right) => (left === right ? 1 : 0),
  contains: (left, right) => (left.includes(right) || right.includes(left) ? 1 : 0),
  // The name matcher's own scorer, so a name rule keeps behaving exactly as it does today.
  fuzzy: (left, right) => (left === right ? 1 : scoreFingerprint(left, right)),
  raw_dice: (left, right) => diceSimilarity(left, right)
});

// `semantic` is deliberately absent: it needs a vector store we do not have, so a rule using it
// falls out as unevaluated rather than as a silent non-match.

function bagOf(record) {
  if (!record) return {};
  // An index entry already carries name fingerprints; reuse them rather than re-normalising.
  if (record.bag) return record.bag;
  const built = buildCandidate(record.partner || record);
  if (!built.Name && Array.isArray(record.fingerprints) && record.fingerprints.length) {
    built.Name = [...record.fingerprints];
  }
  return built;
}

function conditionsMatch(rule, bag) {
  for (const field of CONDITION_FIELDS) {
    const wanted = rule[CONDITION_COLUMNS[field]];
    if (wanted === undefined || wanted === null || String(wanted).trim() === '') continue;
    const normalised = resolveField(field).entry.normalise(wanted, {});
    if (!normalised) continue;
    if (!(bag[field] || []).includes(normalised)) return false;
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
  const unevaluated = [];
  for (const rule of applicableRules(rules, candidateBag, otherBag)) {
    // An unknown field or comparison must not read as "no duplicate" — that is the dangerous answer.
    const reason = !resolveField(rule.field) ? 'unknown_field'
      : !COMPARISONS[rule.comparison] ? 'unsupported_comparison'
        : '';
    if (reason) {
      unevaluated.push({ field: rule.field, comparison: rule.comparison, reason });
      continue;
    }
    const score = compareValues(
      rule.comparison,
      candidateBag[rule.field],
      otherBag[rule.field],
      ruleThreshold(rule)
    );
    if (!score) continue;
    const found = { field: rule.field, comparison: rule.comparison, indicator: rule.indicator, score };
    const previous = strongest.get(rule.field);
    if (!previous
      || INDICATOR_RANK[found.indicator] > INDICATOR_RANK[previous.indicator]
      || (INDICATOR_RANK[found.indicator] === INDICATOR_RANK[previous.indicator] && found.score > previous.score)) {
      strongest.set(rule.field, found);
    }
  }
  return { indicators: [...strongest.values()], unevaluated };
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
  const candidateBag = bagOf(candidate);
  const active = rules.filter((rule) => rule.isActive !== false);
  const results = [];
  const unevaluatedRules = new Map();

  for (const entry of entries) {
    const partner = entry?.partner || entry;
    const id = partner?.BusinessPartner;
    if (excludeId !== undefined && id !== undefined && String(id) === String(excludeId)) continue;
    const { indicators, unevaluated } = indicatorsFor(candidateBag, bagOf(entry), active);
    for (const rule of unevaluated) unevaluatedRules.set(`${rule.field}:${rule.comparison}`, rule);
    const verdict = verdictFor(indicators);
    if (verdict === VERDICTS.NONE) continue;
    results.push({ partner, verdict, indicators, score: bestScore(indicators) });
  }

  results.sort((left, right) => VERDICT_RANK[right.verdict] - VERDICT_RANK[left.verdict]
    || right.score - left.score);
  const ranked = results.slice(0, limit);
  // Non-enumerable so callers can keep treating the result as a plain array of matches.
  Object.defineProperty(ranked, 'unevaluatedRules', { value: [...unevaluatedRules.values()] });
  return ranked;
}

module.exports = {
  INDICATORS,
  INDICATOR_RANK,
  VERDICTS,
  VERDICT_RANK,
  DEFAULT_RULES,
  COMPARISONS,
  bagOf,
  conditionsMatch,
  applicableRules,
  compareValues,
  ruleThreshold,
  indicatorsFor,
  verdictFor,
  evaluate
};
