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
      if ((facts.gleif || []).length === 1 && only.registeredAs && !(payload.sections?.TaxNumbers || []).length) {
        // No row to fill and none invented — reported so the steward can add it deliberately.
        entries.push({
          target: 'TaxNumbers',
          index: 0,
          field: 'BPTaxNumber',
          value: only.registeredAs,
          message: `GLEIF registers this company as ${only.registeredAs}.`
        });
      }
      return entries;
    }
  };

  return { validations: [validation], derivations: [derivation] };
}

module.exports = {
  ADDRESS_FIELDS,
  NAME_MISMATCH_SEVERITY,
  severityOf,
  addressDerivations,
  createRegistryStages
};
