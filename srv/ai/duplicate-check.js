'use strict';

const { partnerFingerprints } = require('./name-match');
const { evaluate, VERDICTS } = require('./duplicate-engine');
const { createRuleStore } = require('./rule-config');

// One resident ruleset per instance. A rule changed on another instance is invisible here until
// the TTL lapses, the same trade already accepted for the query cache.
const ruleStore = createRuleStore();

/**
 * The one place anything in this app asks what the rules are. It stays synchronous on purpose —
 * `evaluate` and the creation-suggestion chain are synchronous, and making this async would turn
 * half the service async for a table that changes a few times a year.
 */
function activeRules() {
  return ruleStore.rules();
}

// Called where a read is already happening, so the ruleset refreshes without a call of its own.
function refreshRules(readRows, options) {
  return ruleStore.refresh(readRows, options);
}

const VERDICT_LABELS = Object.freeze({
  [VERDICTS.DUPLICATE]: 'Duplicate',
  [VERDICTS.STRONG]: 'Strong chance of duplicate',
  [VERDICTS.SMALL]: 'Small chance of duplicate'
});

// A definitive hit does not block the submit — it raises a finding the approver has to clear.
const VERDICT_SEVERITY = Object.freeze({
  [VERDICTS.DUPLICATE]: 'error',
  [VERDICTS.STRONG]: 'warning',
  [VERDICTS.SMALL]: 'info'
});

const DUPLICATE_CHECK_NAME = 'duplicate_check';

// The engine reads addresses/taxNumbers/roles off the record; staging keeps them in its own nodes.
function candidateFromStagedRequest(general = {}, nodes = {}) {
  const { ID, request_ID, action, ...root } = general;
  return {
    ...root,
    addresses: nodes.Addresses || [],
    taxNumbers: nodes.TaxNumbers || [],
    bankDetails: nodes.BankDetails || [],
    roles: nodes.BusinessPartnerRoles || []
  };
}

// Fingerprints rows on the fly; the name index precomputes the same thing once per partner.
function toEntries(partners = []) {
  return partners.map((partner) => ({ partner, fingerprints: partnerFingerprints(partner) }));
}

function checkAgainstPartners(candidate, partners = [], options = {}) {
  return evaluate(candidate, toEntries(partners), { rules: activeRules(), ...options });
}

function describe(result) {
  const label = VERDICT_LABELS[result.verdict] || result.verdict;
  const reasons = result.indicators
    .map((found) => `${found.field} (${found.comparison})`)
    .join(', ');
  return `${label}: Business Partner ${result.partner?.BusinessPartner} matches on ${reasons}.`;
}

/**
 * Turns verdicts into `CheckFindings` rows. Severity carries the block/no-block decision and
 * `verdict` carries the tier — they are not the same concept, so they get their own columns.
 */
function duplicateFindings(results = [], { checkName = DUPLICATE_CHECK_NAME } = {}) {
  return results.map((result) => ({
    checkName,
    severity: VERDICT_SEVERITY[result.verdict] || 'info',
    verdict: result.verdict,
    message: describe(result).slice(0, 500),
    candidateBP: String(result.partner?.BusinessPartner || '').slice(0, 10),
    score: Number(result.score.toFixed(4))
  }));
}

// Pairwise, so O(n²). 261 partners is ~34k comparisons and instant; 50k would be 1.2bn. Refuse
// rather than hang a CF instance, and say so — a truncated test reads as a clean bill of health.
const TEST_MAX_PARTNERS = 5000;
const TEST_SAMPLES_PER_VERDICT = 10;

/**
 * Runs a ruleset over the whole index without saving it, so a steward can see what a change does
 * before committing to it. This is what stops people tuning blind into a ruleset that flags
 * everything or nothing.
 */
function testRuleset(entries = [], { rules = activeRules(), samplesPerVerdict = TEST_SAMPLES_PER_VERDICT } = {}) {
  const list = [...entries];
  if (list.length > TEST_MAX_PARTNERS) {
    return { partners: list.length, limit: TEST_MAX_PARTNERS, tooLarge: true, counts: {}, samples: [] };
  }
  const counts = { duplicate: 0, strong: 0, small: 0 };
  const samples = [];
  const seenPairs = new Set();
  const sampled = { duplicate: 0, strong: 0, small: 0 };

  for (const entry of list) {
    const partner = entry?.partner || entry;
    const id = String(partner?.BusinessPartner ?? '');
    for (const result of evaluate(partner, list, { rules, excludeId: id })) {
      const other = String(result.partner?.BusinessPartner ?? '');
      // A pair is one finding, not two — otherwise every count is exactly doubled.
      const key = [id, other].sort().join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      counts[result.verdict] = (counts[result.verdict] || 0) + 1;
      if (sampled[result.verdict] < samplesPerVerdict) {
        sampled[result.verdict] += 1;
        samples.push({
          verdict: result.verdict,
          score: Number(result.score.toFixed(4)),
          businessPartner: id,
          candidateBP: other,
          indicators: result.indicators.map((found) => `${found.field} (${found.comparison})`)
        });
      }
    }
  }
  return { partners: list.length, pairs: seenPairs.size, counts, samples };
}

module.exports = {
  DUPLICATE_CHECK_NAME,
  TEST_MAX_PARTNERS,
  testRuleset,
  VERDICT_LABELS,
  VERDICT_SEVERITY,
  ruleStore,
  activeRules,
  refreshRules,
  candidateFromStagedRequest,
  toEntries,
  checkAgainstPartners,
  describe,
  duplicateFindings
};
