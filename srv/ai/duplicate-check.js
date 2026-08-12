'use strict';

const { partnerFingerprints } = require('./name-match');
const { evaluate, DEFAULT_RULES, VERDICTS } = require('./duplicate-engine');

/**
 * The one seam a database-backed ruleset replaces. Everything else in the app asks for rules here,
 * so switching from the code defaults to `DuplicateRules` rows is a change to this function alone.
 */
function activeRules() {
  return DEFAULT_RULES;
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

module.exports = {
  DUPLICATE_CHECK_NAME,
  VERDICT_LABELS,
  VERDICT_SEVERITY,
  activeRules,
  candidateFromStagedRequest,
  toEntries,
  checkAgainstPartners,
  describe,
  duplicateFindings
};
