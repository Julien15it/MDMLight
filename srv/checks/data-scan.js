'use strict';

const { resolvePayloadField, PAYLOAD_NODES, ROOT_SECTION } = require('./payload-fields');
const {
  CONDITION_PAIRS, COMPARISONS, symbolOnly, operatorOf,
  runValidationRule, validateValidationRule
} = require('./rule-engine');

/**
 * Runs a validation ruleset over the business partners that already exist, so a steward can see how
 * much of the current data a rule they just wrote would flag - the "Check Current Data" button on
 * the Validation Rules page (2026-09-02, asked for; the duplicate page's "Test Against Current BPs"
 * is the same idea over a different check).
 *
 * Transport-free on purpose, exactly like `srv/ai/name-index.js`: the readers are handed in, so
 * this module can be tested with plain objects and the S/4 connection stays with the service that
 * owns it. `readPartners()` returns the General rows; `readSection(section, partners)` returns a
 * `Map` of partner id -> that section's rows, because only the caller knows which key column a
 * section is filtered on (BusinessPartner, Customer or Supplier).
 */

// The scan is one payload per partner and every rule over every payload, which is linear rather
// than the duplicate test's pairwise O(n²) - but it is still a remote read per section per batch,
// so it is capped and says so rather than quietly reporting on a slice of the population.
const MAX_PARTNERS = 2000;

const DEFAULT_SAMPLES_PER_RULE = 5;

const trimmed = (value) => String(value === null || value === undefined ? '' : value).trim();

/** Every section a ruleset reads - its validated fields and its condition fields alike. */
function sectionsUsedBy(rules = [], model) {
  const sections = new Set();
  for (const rule of rules) {
    const names = [rule.field, ...CONDITION_PAIRS.map((pair) => rule[pair.field])];
    for (const name of names) {
      const resolved = resolvePayloadField(name, model);
      if (resolved && resolved.section !== ROOT_SECTION) sections.add(resolved.section);
    }
  }
  return [...sections];
}

/** The rules that would actually run: active, and complete enough to evaluate. */
function runnableRules(rules = [], model) {
  return rules
    .filter((rule) => rule.isActive !== false)
    .filter((rule) => !validateValidationRule(rule, model).errors.length);
}

// What the report names a rule by. There is no name column on a validation rule, so the sentence it
// reads as on screen is the only label a steward would recognise it by.
function describeRule(rule) {
  const conditions = CONDITION_PAIRS
    .filter((pair) => trimmed(rule[pair.field]))
    .map((pair) => {
      // The condition's own comparator since 2026-09-02, not a hardcoded `=`: a report that said
      // "where Country = BE" about a `!=` rule would be naming a rule nobody wrote.
      const comparison = COMPARISONS[operatorOf(rule[pair.operator])];
      return comparison.needsValue === false
        ? `${trimmed(rule[pair.field])} ${comparison.text}`
        : `${trimmed(rule[pair.field])} ${symbolOnly(comparison.text)} ${trimmed(rule[pair.value])}`;
    });
  const rest = `${trimmed(rule.field)} ${trimmed(rule.comparison)}${rule.value ? ` ${trimmed(rule.value)}` : ''}`;
  return conditions.length ? `where ${conditions.join(' / ')}: ${rest}` : rest;
}

/**
 * One payload per partner, then every rule over every payload. Counts are of FINDINGS, and
 * `partners` per rule is how many distinct partners it fired on - a rule that flags five addresses
 * of one partner is not the same news as one that flags five partners.
 */
async function scanValidationRules({
  rules = [],
  model,
  readPartners,
  readSection,
  samplesPerRule = DEFAULT_SAMPLES_PER_RULE,
  maxPartners = MAX_PARTNERS
} = {}) {
  const usable = runnableRules(rules, model);
  const skipped = rules.length - usable.length;
  if (!usable.length) {
    return { partners: 0, scanned: 0, rules: [], counts: { error: 0, warning: 0, info: 0 }, skipped, sections: [] };
  }

  const partners = await readPartners({ limit: maxPartners + 1 }) || [];
  if (partners.length > maxPartners) {
    return { partners: partners.length, limit: maxPartners, tooLarge: true, skipped, counts: {}, rules: [] };
  }

  // Only the sections the ruleset actually reads: a rule about the country of an address is no
  // reason to fetch every bank detail in the system.
  const wanted = sectionsUsedBy(usable, model).filter((section) => PAYLOAD_NODES[section]);
  const rows = new Map();
  const unavailable = [];
  for (const section of wanted) {
    try {
      rows.set(section, await readSection(section, partners) || new Map());
    } catch (error) {
      // A section that could not be read is NAMED, never treated as empty: a rule reporting nothing
      // because its data never arrived would read as a clean bill of health, which is the one wrong
      // answer this whole scan exists to avoid giving.
      unavailable.push({ section, reason: error.message });
    }
  }

  const counts = { error: 0, warning: 0, info: 0 };
  const perRule = usable.map((rule) => ({
    field: trimmed(rule.field),
    severity: trimmed(rule.severity) || 'error',
    rule: describeRule(rule),
    findings: 0,
    partners: 0,
    samples: []
  }));
  const flagged = new Set();

  for (const partner of partners) {
    const id = String(partner?.BusinessPartner ?? '');
    const sections = {};
    for (const [section, byPartner] of rows) sections[section] = byPartner.get(id) || [];
    const payload = { root: partner, sections };

    usable.forEach((rule, index) => {
      const found = runValidationRule(rule, payload, model);
      if (!found.length) return;
      const report = perRule[index];
      report.findings += found.length;
      report.partners += 1;
      flagged.add(id);
      for (const finding of found) {
        counts[finding.severity] = (counts[finding.severity] || 0) + 1;
        if (report.samples.length < samplesPerRule) {
          report.samples.push({ businessPartner: id, message: finding.message });
        }
      }
    });
  }

  return {
    partners: partners.length,
    scanned: partners.length,
    flaggedPartners: flagged.size,
    counts,
    // Loudest first: a steward switching a rule on wants to know which one flags half the estate.
    rules: perRule.slice().sort((left, right) => right.findings - left.findings),
    skipped,
    sections: wanted,
    unavailable
  };
}

module.exports = {
  MAX_PARTNERS,
  DEFAULT_SAMPLES_PER_RULE,
  sectionsUsedBy,
  runnableRules,
  describeRule,
  scanValidationRules
};
