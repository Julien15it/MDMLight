'use strict';

/**
 * The one encoding for a multi-value cell. A list is stored in a single column as its entries
 * separated by `|`, so a stored single value is already a valid one-entry list - which is what lets
 * the existing single-value condition columns become lists without touching a row.
 *
 * `|` rather than a comma or a semicolon on purpose: company names carry commas ("Acme, Inc"),
 * addresses carry semicolons, and neither appears in an e-mail address, a country code or a role.
 * Nobody types the delimiter either - the grid uses tokens.
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
