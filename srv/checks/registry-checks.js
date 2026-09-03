'use strict';

const {
  enrichCandidate, sameText, scoreAgainst, ACCEPT_SCORE, namesOf
} = require('../ai/registry');
const { candidateFromStagedRequest } = require('../ai/duplicate-check');
const { STATUS } = require('../ai/vies');
const { CATEGORY_FIELDS } = require('../partner-name');

/**
 * VIES and GLEIF as one validation and one derivation: does what was typed agree with the official
 * record, and can the gaps be filled from it. The pair is created per check and shares a single
 * lookup — VIES throttles per member state, so asking twice for one press would be slower and ruder.
 */

const ADDRESS_FIELDS = Object.freeze(['StreetName', 'HouseNumber', 'PostalCode', 'CityName', 'Country']);

// Where an organisation's name lives, in the order S/4 reads it. `db/staging.cds` types both String(40).
const ORGANISATION_NAME_FIELDS = Object.freeze(['OrganizationBPName1', 'OrganizationBPName2']);
const NAME_FIELD_LENGTH = 40;

// A warning since 2026-08-14: VIES returns the legal name and partners are often stored under a
// trading one, and blocking here stopped the derivations and the proposals as well. 'error' restores it.
const NAME_MISMATCH_SEVERITY = 'warning';

// Only the name mismatch is re-graded; everything else keeps registry.js's severity. Load-bearing:
// `vat_registered` means both "not registered" and "could not confirm", so grade by severity, not name.
function severityOf(finding) {
  if (finding.check === 'vat_name_matches') return NAME_MISMATCH_SEVERITY;
  return finding.severity || 'info';
}

// An address disagreement is about the address, not about the tax number that found it.
function fieldFor(finding) {
  const check = String(finding.check || '');
  if (check === 'vat_address_matches') return 'StreetName';
  return check.startsWith('vat') ? 'BPTaxNumber' : null;
}

function candidateOf(payload) {
  return candidateFromStagedRequest(payload.root || {}, payload.sections || {});
}

// The registry answers a postal address; the screen holds it on an address row. With no address
// row yet, the FIRST one is proposed rather than the answer being reported as homeless - the
// pipeline creates it and the requester still has to tick it (2026-08-20).
function addressDerivations(addresses, rows, source) {
  const entries = [];
  const [official] = addresses;
  if (!official) return entries;
  const createsRow = !rows.length || undefined;
  (rows.length ? rows : [{}]).forEach((row, index) => {
    // Only the first address gets registry data: a partner's second address is deliberately a
    // different place, and filling it from the registered seat would be wrong, not incomplete.
    if (index > 0) return;
    for (const field of ADDRESS_FIELDS) {
      if (!official[field]) continue;
      const typed = row[field];
      // A filled field is proposed over as of 2026-09-03 (the pipeline decides, not this) - but
      // only where the register genuinely disagrees. `sameText` is the same bar
      // `differingAddressFields` grades the warning by, so the dialog cannot offer a "correction"
      // the finding does not consider a disagreement; reformatting is the model's job, not a
      // register's.
      const replaces = typed && String(typed).trim();
      if (replaces && sameText(typed, official[field])) continue;
      entries.push({
        target: 'Addresses',
        index,
        createsRow,
        field,
        value: official[field],
        // Names the source, not the action: a requester needs to know which register to argue with.
        label: `${source} check`,
        message: replaces
          ? `${source} registers this partner at “${official[field]}”, not “${replaces}”.`
            + ' Keep what you typed by unticking this row.'
          : `${field} was filled in as “${official[field]}” from ${source}`
            + `${createsRow ? ' (a new address)' : ''}.`
      });
    }
  });
  return entries;
}

// `OrganizationBPName1` is 40 characters; a legal name longer than that is why S/4 has four of
// them. Split on the last space that fits rather than truncating - a proposal nobody could accept
// without losing half the name is not a proposal.
function splitOrganisationName(name) {
  const text = String(name || '').trim();
  if (text.length <= NAME_FIELD_LENGTH) return [text];
  const head = text.slice(0, NAME_FIELD_LENGTH + 1);
  const cut = head.lastIndexOf(' ');
  const at = cut > 0 ? cut : NAME_FIELD_LENGTH;
  return [text.slice(0, at).trim(), text.slice(at).trim().slice(0, NAME_FIELD_LENGTH)];
}

/**
 * The name VIES registers, proposed over the one that was typed (2026-09-03, asked for). Until now
 * the disagreement was a warning and nothing else: `vat_name_matches` said the register calls this
 * company something else and left the requester to retype it by hand from the message.
 *
 * Only when the names actually disagree, at the SAME bar the warning uses (`scoreAgainst` below
 * `ACCEPT_SCORE`, so casing and punctuation are not a mismatch) - otherwise every check would offer
 * to rewrite a name it agrees with. Only for an ORGANISATION: VIES answers with a legal entity name,
 * which has nowhere to go on a person or a group. GLEIF is deliberately absent - `acceptedEntities`
 * only keeps entities that already match the typed name closely, so it has no disagreement to
 * report.
 */
function nameDerivations(vies, root) {
  const [typed] = namesOf(root);
  if (!typed) return [];
  // The category decides which fields S/4 keeps, and only the organisation ones can hold this.
  const category = String(root.BusinessPartnerCategory || '').trim();
  if (category && !CATEGORY_FIELDS[category]?.includes(ORGANISATION_NAME_FIELDS[0])) return [];

  const official = (vies || [])
    .filter((check) => check.status === STATUS.VALID && check.name)
    .map((check) => check.name)
    .find((name) => scoreAgainst(typed, name) < ACCEPT_SCORE);
  if (!official) return [];

  const parts = splitOrganisationName(official);
  return parts.map((value, index) => ({
    target: 'root',
    field: ORGANISATION_NAME_FIELDS[index],
    value,
    label: 'VIES check',
    message: `VIES registers this VAT number as “${official}”, not “${typed}”.`
      + (parts.length > 1 ? ' The name is longer than one name field, so it is proposed across two.' : '')
      + ' Keep what you typed by unticking this row.'
  }));
}

// Optional chaining, not a default: GLEIF sends `address: null`, and a default only fires on undefined.
const addressLine = (address) => [
  [address?.StreetName, address?.HouseNumber].filter(Boolean).join(' '),
  [address?.PostalCode, address?.CityName].filter(Boolean).join(' '),
  address?.Country
].filter(Boolean).join(', ');

// Name first, then where, then the identifiers: the name is what says whether GLEIF found the
// right company at all.
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
        field: fieldFor(finding)
      }));
    }
  };

  const derivation = {
    name: 'registry',
    run: async (payload) => {
      const { facts } = await enriched(payload);
      const entries = [];
      const rows = payload.sections?.Addresses || [];

      // The name before the address: it is the fact that says whether the register found the right
      // company at all, and the pipeline claims a field for the first stage that speaks for it.
      entries.push(...nameDerivations(facts.vies, payload.root || {}));

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

  return { validations: [validation], derivations: [derivation] };
}

module.exports = {
  ADDRESS_FIELDS,
  addressLine,
  fieldFor,
  describeEntity,
  NAME_MISMATCH_SEVERITY,
  ORGANISATION_NAME_FIELDS,
  NAME_FIELD_LENGTH,
  severityOf,
  splitOrganisationName,
  nameDerivations,
  addressDerivations,
  createRegistryStages
};
