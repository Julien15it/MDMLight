'use strict';

// Raised from 0.82: a full-index scan produces far more candidates than a prefiltered read did.
const DUPLICATE_THRESHOLD = 0.86;
// Unbounded: a silently truncated list hides exactly the record the user is looking for.
const DUPLICATE_LIMIT = Infinity;
// Dice is noisy on very short strings, so those must match exactly.
const MIN_FUZZY_LENGTH = 5;

const NAME_FIELDS = Object.freeze([
  'BusinessPartnerFullName',
  'BusinessPartnerName',
  'OrganizationBPName1'
]);

const LEGAL_FORMS = new Set([
  'ag', 'bv', 'bvba', 'co', 'company', 'corp', 'corporation', 'gmbh', 'inc',
  'limited', 'llc', 'ltd', 'nv', 'plc', 'sa', 'se', 'srl'
]);

function normalizedCompanyName(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function companyFingerprint(value) {
  return normalizedCompanyName(value)
    .split(/\s+/u)
    .filter((token) => token && !LEGAL_FORMS.has(token))
    .join('');
}

function diceSimilarity(left, right) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const pairs = new Map();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const available = pairs.get(pair) || 0;
    if (available > 0) {
      overlap += 1;
      pairs.set(pair, available - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

// Precomputed once per partner at index time so matching never re-normalises the whole index.
function partnerFingerprints(partner = {}) {
  const seen = new Set();
  for (const field of NAME_FIELDS) {
    const fingerprint = companyFingerprint(partner[field]);
    if (fingerprint) seen.add(fingerprint);
  }
  return [...seen];
}

function scoreFingerprint(requested, fingerprint) {
  if (fingerprint === requested) return 1;
  if (fingerprint.length < MIN_FUZZY_LENGTH || requested.length < MIN_FUZZY_LENGTH) return 0;
  const ratio = Math.min(fingerprint.length, requested.length)
    / Math.max(fingerprint.length, requested.length);
  if (requested.length >= 6 && ratio >= 0.75
    && (fingerprint.includes(requested) || requested.includes(fingerprint))) return 0.92;
  return diceSimilarity(requested, fingerprint);
}

function scorePartner(requested, fingerprints = []) {
  return Math.max(0, ...fingerprints.map((fingerprint) => scoreFingerprint(requested, fingerprint)));
}

// Entries carry their fingerprints so both the live read and the name index share one ranking path.
function rankDuplicates(name, entries = [], { threshold = DUPLICATE_THRESHOLD, limit = DUPLICATE_LIMIT } = {}) {
  const requested = companyFingerprint(name);
  if (!requested) return [];

  const ranked = [];
  for (const entry of entries) {
    const score = scorePartner(requested, entry.fingerprints);
    if (score >= threshold) ranked.push({ partner: entry.partner, score });
  }
  return ranked.sort((left, right) => right.score - left.score).slice(0, limit);
}

module.exports = {
  DUPLICATE_THRESHOLD,
  DUPLICATE_LIMIT,
  MIN_FUZZY_LENGTH,
  NAME_FIELDS,
  normalizedCompanyName,
  companyFingerprint,
  diceSimilarity,
  partnerFingerprints,
  scoreFingerprint,
  scorePartner,
  rankDuplicates
};
