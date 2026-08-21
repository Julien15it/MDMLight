'use strict';

/**
 * The encoding a multi-value cell used, kept as a READ path only.
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

/** True when any entry equals `value` under the comparison the rule tables use. */
function listMatches(values, value, compare) {
  return parseValueList(values).some((entry) => compare(value, entry) === 0);
}

const trimmed = (value) => String(value === null || value === undefined ? '' : value).trim();

const dedupe = (values) => [...new Set(values)];

module.exports = {
  DELIMITER,
  parseValueList,
  formatValueList,
  listMatches
};
