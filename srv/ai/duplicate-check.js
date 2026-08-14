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

/**
 * Pending creates as candidates to match against. Without these, two requests to create the same
 * company — submitted before either is approved — are invisible to one another: neither is in S/4
 * yet, so both pass, both post, and the control creates the duplicate it exists to prevent.
 *
 * Deliberately creates only. A change request against an existing partner is already represented
 * in the index by that partner; adding its staged copy would report one company twice.
 */
function stagedEntries(requests = [], { exclude } = {}) {
  return requests
    .filter((entry) => entry?.request?.requestType === 'create')
    // A request must never be reported as its own duplicate.
    .filter((entry) => !exclude || String(entry.request.ID) !== String(exclude))
    .map((entry) => {
      const partner = candidateFromStagedRequest(entry.general, entry.nodes);
      partner.ChangeRequest = entry.request.ID;
      partner.ChangeRequestStatus = entry.request.status;
      return { partner, fingerprints: partnerFingerprints(partner) };
    });
}

function checkAgainstPartners(candidate, partners = [], { extra = [], ...options } = {}) {
  return evaluate(candidate, [...toEntries(partners), ...extra], { rules: activeRules(), ...options });
}

// Shared so the message an approver reads and the reasons SPA receives can never drift apart.
const reasonsOf = (result) => (result.indicators || []).map((found) => `${found.field} (${found.comparison})`);

// First name that is fit to show a human; the catalog's normalised values are for matching only.
const displayName = (partner = {}) => String(
  partner.BusinessPartnerFullName
  || partner.BusinessPartnerName
  || partner.OrganizationBPName1
  || partner.GroupBusinessPartnerName1
  || partner.Name
  || ''
).trim();

function describe(result) {
  const label = VERDICT_LABELS[result.verdict] || result.verdict;
  const reasons = reasonsOf(result).join(', ');
  // A pending create has no partner number yet, so it is named by its request.
  const subject = result.partner?.ChangeRequest
    ? `pending change request ${result.partner.ChangeRequest}`
    : `Business Partner ${result.partner?.BusinessPartner}`;
  return `${label}: ${subject} matches on ${reasons}.`;
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
    // One or the other: a match is either a live partner or a request that has not posted yet.
    candidateBP: String(result.partner?.BusinessPartner || '').slice(0, 10) || null,
    candidateRequest: result.partner?.ChangeRequest || null,
    score: Number(result.score.toFixed(4)),
    // Not CheckFindings columns - they travel in memory to the SPA payload. See FINDING_COLUMNS.
    candidateName: displayName(result.partner),
    reasons: reasonsOf(result)
  }));
}

// One line per matched partner, not per matched field: the engine already folds every indicator for
// a pair into one result, so `reasons` is the full list of why this BP was flagged.
const SUMMARY_LIMIT = 20;

function duplicateSummary(findings = []) {
  const flagged = findings.filter((finding) => finding.verdict);
  const lines = flagged.slice(0, SUMMARY_LIMIT).map((finding) => [
    finding.candidateBP || `CR ${finding.candidateRequest}`,
    finding.candidateName || '(no name)',
    `${VERDICT_LABELS[finding.verdict] || finding.verdict}: ${(finding.reasons || []).join(', ')}`
  ].join('; '));
  // Never truncate in silence: a short list reads as the whole answer.
  if (flagged.length > lines.length) lines.push(`…and ${flagged.length - lines.length} more`);
  return lines;
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
  stagedEntries,
  candidateFromStagedRequest,
  toEntries,
  checkAgainstPartners,
  describe,
  displayName,
  reasonsOf,
  duplicateFindings,
  duplicateSummary,
  SUMMARY_LIMIT
};
