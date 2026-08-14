'use strict';

const { enrichCandidate } = require('../ai/registry');
const { candidateFromStagedRequest } = require('../ai/duplicate-check');

/**
 * VIES and GLEIF as a validation and a derivation, sharing one lookup.
 *
 * They were already in the codebase, but only feeding the duplicate engine extra names and
 * identifiers. Here they answer the two questions a steward actually asks of a registry: does what
 * was typed agree with the official record, and can the gaps be filled from it.
 *
 * The pair is created **per check**, and the derivation reuses what the validation looked up —
 * VIES throttles per member state and GLEIF is a public API, so asking twice for one press of the
 * Check button would be both slower and ruder.
 */

const ADDRESS_FIELDS = Object.freeze(['StreetName', 'HouseNumber', 'PostalCode', 'CityName', 'Country']);

/**
 * A name that does not match the registry **blocks**, on Maarten's instruction (2026-08-13): a
 * partner whose VAT number belongs to a differently-named company is wrong data, not a hint.
 *
 * Worth knowing before this bites: `registry.js` already treats a legal-name/trading-name
 * difference as a legitimate case, and VIES returns the legal name. If real data turns out to
 * trip this constantly, lowering it to 'warning' here is the one-line change — a warning still
 * shows at the top of the screen, it just no longer stops the duplicate check from running.
 */
const NAME_MISMATCH_SEVERITY = 'error';

/**
 * Only the name mismatch is re-graded. Everything else keeps the severity `registry.js` gave it,
 * and that is load-bearing: `vat_registered` carries **both** "not registered in VIES" (error) and
 * "VIES could not confirm it" (info, because VIES answers `isValid: false` when a member state is
 * merely throttled). Re-grading by check name alone would block on an outage — the one thing that
 * would teach people to ignore these findings.
 */
function severityOf(finding) {
  if (finding.check === 'vat_name_matches') return NAME_MISMATCH_SEVERITY;
  return finding.severity || 'info';
}

function candidateOf(payload) {
  return candidateFromStagedRequest(payload.root || {}, payload.sections || {});
}

// The registry answers a postal address; the screen holds it on an address row. Only rows that
// already exist are filled — see the pipeline, which refuses to invent one.
function addressDerivations(addresses, rows, source) {
  const entries = [];
  const [official] = addresses;
  if (!official || !rows.length) return entries;
  rows.forEach((row, index) => {
    // Only the first address gets registry data: a partner's second address is deliberately a
    // different place, and filling it from the registered seat would be wrong, not incomplete.
    if (index > 0) return;
    for (const field of ADDRESS_FIELDS) {
      if (!official[field]) continue;
      entries.push({
        target: 'Addresses',
        index,
        field,
        value: official[field],
        message: `${field} was filled in as “${official[field]}” from ${source}.`
      });
    }
  });
  return entries;
}

// Same value, differently written, is the model's business - proposing "Koedreef" over "koedreef"
// from the register would collide with the casing proposal for the same field.
const sameValue = (left, right) => String(left).replace(/[^\p{L}\p{N}]+/gu, '').toLocaleLowerCase()
  === String(right).replace(/[^\p{L}\p{N}]+/gu, '').toLocaleLowerCase();

/**
 * A register value that **differs** from what was typed. Not a derivation — those only fill gaps and
 * never overwrite — and not a formatting fix either, so it is neither of the existing stages: it is a
 * correction from an authoritative source, offered through the same accept-or-decline dialog because
 * the decision has the same shape. Only the first address row, like the derivation.
 */
function correctionsFrom(official, rows, source) {
  const [row] = rows;
  if (!official || !row) return [];
  return ADDRESS_FIELDS.filter((field) => {
    const current = String(row[field] ?? '').trim();
    // An empty field is the derivation's job, and an identical one is nobody's.
    return current && official[field] && !sameValue(current, official[field]);
  }).map((field) => ({
    target: 'Addresses',
    index: 0,
    field,
    current: String(row[field]).trim(),
    proposed: official[field],
    source,
    reason: `${source} registers this as “${official[field]}”`
  }));
}

// Optional chaining, not a default: GLEIF sends `address: null` for an entity with no legal
// address, and a default only fires on undefined.
const addressLine = (address) => [
  [address?.StreetName, address?.HouseNumber].filter(Boolean).join(' '),
  [address?.PostalCode, address?.CityName].filter(Boolean).join(' '),
  address?.Country
].filter(Boolean).join(', ');

/**
 * What GLEIF says the company is, in the order a steward cares: the registered name, then where,
 * then the identifiers. The company number led before and told nobody anything - the name is what
 * says whether GLEIF found the right company at all.
 */
function describeEntity(entity = {}) {
  const where = addressLine(entity.address);
  const ids = [
    entity.registeredAs ? `company number ${entity.registeredAs}` : '',
    entity.lei ? `LEI ${entity.lei}` : ''
  ].filter(Boolean).join(', ');
  return [
    `GLEIF found “${entity.legalName || 'this company'}”`,
    where ? ` at ${where}` : '',
    ids ? ` (${ids})` : '',
    '. Check it is the same company before using it.'
  ].join('');
}

function createRegistryStages({ enrich = enrichCandidate, ...options } = {}) {
  let lookup = null;

  async function enriched(payload) {
    if (!lookup) lookup = enrich(candidateOf(payload), options);
    return lookup;
  }

  const validation = {
    name: 'registry',
    run: async (payload) => {
      const { findings } = await enriched(payload);
      return findings.map((finding) => ({
        severity: severityOf(finding),
        message: finding.message,
        field: String(finding.check || '').startsWith('vat') ? 'BPTaxNumber' : null
      }));
    }
  };

  const derivation = {
    name: 'registry',
    run: async (payload) => {
      const { facts } = await enriched(payload);
      const entries = [];
      const rows = payload.sections?.Addresses || [];

      // VIES first: a member state's own register outranks a self-reported GLEIF address.
      const viesAddresses = (facts.vies || [])
        .filter((check) => check.address)
        .map((check) => check.address);
      entries.push(...addressDerivations(viesAddresses, rows, 'VIES'));

      const gleifAddresses = (facts.gleif || [])
        .filter((entity) => entity.address)
        .map((entity) => entity.address);
      entries.push(...addressDerivations(gleifAddresses, rows, 'GLEIF'));

      // Ambiguity is not a reason to guess: registry.js only exposes an identifier when exactly
      // one entity matched closely, so this inherits that discipline rather than restating it.
      const [only] = facts.gleif || [];
      if ((facts.gleif || []).length === 1) entries.push({ message: describeEntity(only) });
      return entries;
    }
  };

  // Shares the one lookup with the validation and the derivation, so this costs no extra call.
  const propose = async (payload) => {
    const { facts } = await enriched(payload);
    const rows = payload.sections?.Addresses || [];
    // VIES only: GLEIF is the fallback source and never outranks what a requester typed.
    const [official] = (facts.vies || []).filter((check) => check.address).map((check) => check.address);
    return correctionsFrom(official, rows, 'VIES');
  };

  return { validations: [validation], derivations: [derivation], propose };
}

module.exports = {
  ADDRESS_FIELDS,
  addressLine,
  correctionsFrom,
  describeEntity,
  sameValue,
  NAME_MISMATCH_SEVERITY,
  severityOf,
  addressDerivations,
  createRegistryStages
};
