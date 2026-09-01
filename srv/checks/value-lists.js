'use strict';

/**
 * What every rule table's CONDITION cells mean, in one place: the stored multi-value encoding, the
 * `*` wildcard, and how two conditions are joined. Shared by rule-engine.js, duplicate-engine.js
 * and workflow-rules.js so the four MDM Configuration Panel tables cannot disagree about any of it.
 *
 * The rest of this comment is about the multi-value encoding, which is a READ path only.
 *
 * Multiple values per condition were built on 2026-08-21 and withdrawn the same day: no grid could
 * be made to save a token cell reliably (see "Multiple values per condition" in CLAUDE.md). Every
 * page offers one value per field again.
 *
 * This stays because rows written while the feature was live may hold `BE|NL`, and a stored rule
 * that silently stops matching is the failure this codebase refuses everywhere else - "no
 * duplicates found" from a check that never ran. A single value parses as a one-entry list, so the
 * tolerance costs nothing and no row had to be migrated in either direction.
 *
 * `|` was chosen over a comma or a semicolon because company names carry commas ("Acme, Inc") and
 * addresses carry semicolons, while neither appears in an e-mail address, a country code or a role.
 */

const DELIMITER = '|';

/** The entries of a stored cell, trimmed, empties dropped, duplicates kept in first-seen order. */
function parseValueList(raw) {
  if (Array.isArray(raw)) return dedupe(raw.map(trimmed).filter(Boolean));
  return dedupe(String(raw === null || raw === undefined ? '' : raw)
    .split(DELIMITER)
    .map(trimmed)
    .filter(Boolean));
}

/** How a list is stored. Round-trips with `parseValueList`, so neither side has to know the shape. */
function formatValueList(values) {
  return parseValueList(values).join(DELIMITER);
}

/**
 * `*` in a condition value means "any characters" — `FLVN*` matches FLVN00 and FLVN01, `*01` and
 * `FL*N01` work too (2026-08-27). Anywhere and any number of them, because a steward who types
 * `*01` and gets a silent non-match is the failure this codebase refuses everywhere else.
 */
const WILDCARD = '*';

const hasWildcard = (entry) => String(entry === null || entry === undefined ? '' : entry).includes(WILDCARD);

// Escape the whole pattern FIRST, then turn the escaped `\*` back into `.*`. Escaping afterwards
// would re-escape the `.` and `*` this just inserted, and the pattern would match itself literally.
function wildcardRegExp(pattern) {
  const escaped = trimmed(pattern)
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\\\*/gu, '.*');
  return new RegExp(`^${escaped}$`, 'iu');
}

/** Anchored and case-insensitive, matching how the rule tables' own text comparison behaves. */
function wildcardMatches(pattern, value) {
  return wildcardRegExp(pattern).test(trimmed(value));
}

/**
 * A pattern normalised around its wildcards, for the duplicate engine, whose bags hold normalised
 * values. Normalising `FLVN*` whole would strip the `*` — `alnumUpper` drops everything that is
 * not a letter or a number — so each literal segment is normalised on its own and the wildcards
 * are put back between them.
 */
function normalisePattern(pattern, normalise) {
  return trimmed(pattern)
    .split(WILDCARD)
    .map((segment) => (segment ? normalise(segment) : ''))
    .join(WILDCARD);
}

/** True when any entry equals `value` under the comparison the rule tables use, or matches it as a pattern. */
function listMatches(values, value, compare) {
  return parseValueList(values).some((entry) => (hasWildcard(entry)
    ? wildcardMatches(entry, value)
    : compare(value, entry) === 0));
}

/**
 * How the condition pairs are joined (2026-08-27, generalised to any number of conditions
 * 2026-08-28 for WorkflowRules' dynamic `conditions` column). One definition for every rule table,
 * so a steward reading AND on one page cannot get a different answer on another.
 *
 * `AND` is the default and is what every stored row means: `conditionsHold` was `.every()` before
 * this column existed, so a null reads as AND and no row had to be migrated. It only ever applies
 * when TWO OR MORE conditions are filled — one condition has nothing to be joined to, and NOR on a
 * single condition would silently invert it.
 */
const CONDITION_LOGIC = Object.freeze({
  AND: { text: 'AND' },
  OR: { text: 'OR' },
  NOR: { text: 'NOR' }
});

const DEFAULT_CONDITION_LOGIC = 'AND';

/**
 * Blank is fine — it means AND. Anything else unrecognised is refused at the keyboard rather than
 * quietly read as AND: the dropdown cannot produce one, so it can only arrive from a direct call,
 * and a rule silently joined the wrong way is worse than one that would not save.
 */
function conditionLogicError(raw) {
  const key = trimmed(raw);
  if (!key || CONDITION_LOGIC[key.toLocaleUpperCase('en-US')]) return null;
  return `“${key}” is not a condition operator. Use one of: ${Object.keys(CONDITION_LOGIC).join(', ')}.`;
}

/** Unknown or blank falls back to AND rather than refusing: the column is additive to stored rows. */
function conditionLogicOf(raw) {
  const key = trimmed(raw).toLocaleUpperCase('en-US');
  return CONDITION_LOGIC[key] ? key : DEFAULT_CONDITION_LOGIC;
}

/**
 * `results` is one boolean per FILLED condition, in the order they were written. Zero is "no
 * conditions", which holds; one is itself, whatever the column says, logic bypassed entirely (see
 * the comment on CONDITION_LOGIC - this is what keeps NOR from inverting a lone condition); two or
 * more FOLD across the whole list under one logic, which is what makes this work for however many
 * conditions a rule has, not just two.
 */
function joinConditions(results, logic) {
  if (!results.length) return true;
  if (results.length === 1) return results[0];
  const key = conditionLogicOf(logic);
  if (key === 'OR') return results.some(Boolean);
  if (key === 'NOR') return !results.some(Boolean);
  return results.every(Boolean);
}

/**
 * The same join with ONE LOGIC PER GAP, for a table that draws a Logic column between every pair of
 * conditions (WorkflowRules since 2026-09-01). `logics[i]` is the logic written BEFORE condition
 * `i`, so `logics[0]` is never read - the first condition has nothing to its left.
 *
 * It folds LEFT TO RIGHT with no precedence: `A OR B AND C` is `(A OR B) AND C`, which is how the
 * row reads on screen. Zero and one condition behave exactly as `joinConditions` - one condition is
 * itself, logic bypassed, which is what keeps NOR from silently inverting a lone condition - and
 * two conditions under one logic give the identical answer, so nothing that used the pairwise
 * version had to change.
 */
function foldConditions(results, logics = []) {
  if (!results.length) return true;
  let held = Boolean(results[0]);
  for (let index = 1; index < results.length; index += 1) {
    const key = conditionLogicOf(logics[index]);
    if (key === 'OR') held = held || Boolean(results[index]);
    else if (key === 'NOR') held = !(held || Boolean(results[index]));
    else held = held && Boolean(results[index]);
  }
  return held;
}

const trimmed = (value) => String(value === null || value === undefined ? '' : value).trim();

const dedupe = (values) => [...new Set(values)];

module.exports = {
  DELIMITER,
  CONDITION_LOGIC,
  DEFAULT_CONDITION_LOGIC,
  conditionLogicOf,
  conditionLogicError,
  joinConditions,
  foldConditions,
  WILDCARD,
  hasWildcard,
  normalisePattern,
  wildcardMatches,
  parseValueList,
  formatValueList,
  listMatches
};
