'use strict';

const { companyFingerprint, scoreFingerprint } = require('./name-match');
const { primaryCountry } = require('./duplicate-fields');
const { searchByName } = require('./gleif');
const { checkVatNumber, STATUS } = require('./vies');

// Registry facts are only accepted at the same bar a name match needs to be definitive. Below it,
// adding another company's identifiers to the candidate would manufacture duplicates outright.
const ACCEPT_SCORE = 0.92;

function namesOf(record = {}) {
  return [
    record.BusinessPartnerFullName,
    record.BusinessPartnerName,
    record.OrganizationBPName1,
    record.Name
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function scoreAgainst(name, candidateName) {
  return scoreFingerprint(companyFingerprint(name), companyFingerprint(candidateName));
}

/**
 * A GLEIF name search returns loosely related entities. Keeping only those that match the candidate
 * closely — and taking identifiers only when exactly one does — is what stops a stray hit from
 * injecting an unrelated company's enterprise number into the candidate.
 */
function acceptedEntities(name, entities = [], country = '') {
  const wanted = String(country || '').toLocaleUpperCase();
  return entities.filter((entity) => {
    if (wanted && entity.address?.Country && entity.address.Country !== wanted) return false;
    const best = Math.max(
      scoreAgainst(name, entity.legalName),
      ...entity.otherNames.map((other) => scoreAgainst(name, other))
    );
    return best >= ACCEPT_SCORE;
  });
}

const ADDRESS_PARTS = Object.freeze(['StreetName', 'HouseNumber', 'PostalCode', 'CityName']);

// Comparison only, so casing and punctuation differences are the model's business, not a warning.
const sameText = (left, right) => String(left ?? '').replace(/[^\p{L}\p{N}]+/gu, '').toLocaleLowerCase()
  === String(right ?? '').replace(/[^\p{L}\p{N}]+/gu, '').toLocaleLowerCase();

const addressText = (address) => ADDRESS_PARTS
  .map((part) => address?.[part]).filter(Boolean).join(' ');

// Only fields both sides filled in: an empty one is a gap for the derivation, not a disagreement.
function differingAddressFields(official, typed) {
  if (!official || !typed) return [];
  return ADDRESS_PARTS.filter((part) => official[part] && typed[part]
    && !sameText(official[part], typed[part]));
}

function vatFindings(check, typedName, typedAddress) {
  if (check.status === STATUS.INVALID) {
    return [{
      check: 'vat_registered',
      severity: 'error',
      message: `VAT number ${check.countryCode}${check.vatNumber} is not registered in VIES.`
    }];
  }
  // An unreachable member state is not a data-quality problem; saying so would train people to
  // ignore the finding entirely.
  if (check.status === STATUS.UNKNOWN) {
    return [{
      check: 'vat_registered',
      severity: 'info',
      message: `VIES could not confirm ${check.countryCode}${check.vatNumber} (${check.reason || 'no response'}).`
    }];
  }
  if (check.status !== STATUS.VALID) return [];

  const findings = [];
  if (check.name && typedName && scoreAgainst(typedName, check.name) < ACCEPT_SCORE) {
    findings.push({
      check: 'vat_name_matches',
      severity: 'warning',
      message: `VIES registers ${check.countryCode}${check.vatNumber} as “${check.name}”, not “${typedName}”.`
    });
  }
  // Said, not proposed: filling a gap is the derivation's job and rewriting a value is the model's,
  // so a register address that disagrees is reported for the requester to judge.
  const differing = differingAddressFields(check.address, typedAddress);
  if (differing.length) {
    findings.push({
      check: 'vat_address_matches',
      severity: 'warning',
      message: `VIES registers ${check.countryCode}${check.vatNumber} at “${addressText(check.address)}”`
        + `, not “${addressText(typedAddress)}” (${differing.join(', ')}).`
    });
  }
  return findings;
}

/**
 * Adds registry-derived names, identifiers and addresses to a candidate record so the one duplicate
 * engine can use them, and returns the data-quality findings the submit path reports. Every added
 * value carries its source: an indicator that depends on a third party being up that day has to be
 * explainable months later.
 */
async function enrichCandidate(record = {}, {
  lookupName = searchByName,
  checkVat = checkVatNumber,
  useGleif = true,
  useVies = true,
  requireCountry = true,
  ...options
} = {}) {
  const [typedName = ''] = namesOf(record);
  const country = primaryCountry(record);
  const additionalNames = [];
  const taxNumbers = [];
  const addresses = [];
  const provenance = [];
  const findings = [];
  const facts = { gleif: [], vies: [] };

  if (useVies) {
    for (const tax of record.taxNumbers || []) {
      if (!tax?.BPTaxNumber) continue;
      // With no country on the record, the number's own prefix is the only country hint there is.
      const check = await checkVat(country || tax.BPTaxNumber, tax.BPTaxNumber, options);
      facts.vies.push(check);
      findings.push(...vatFindings(check, typedName, (record.addresses || [])[0]));
      if (check.status !== STATUS.VALID) continue;
      if (check.name) {
        additionalNames.push(check.name);
        provenance.push({ field: 'Name', value: check.name, source: 'VIES' });
      }
      if (check.address) addresses.push(check.address);
    }
  }

  /**
   * GLEIF is a LAST RESORT, not a second opinion. Its data quality is visibly below VIES's -- a
   * member state's own register against self-reported LEI reference data -- so it only runs when
   * VIES has produced nothing to go on, and only when there is enough to identify a company with.
   *
   * **Name AND country are both required** (tightened 2026-08-27, Maarten). A name alone is how a
   * Belgian company ended up under a Dutch entity's number: "Delta" matches somewhere in every
   * jurisdiction, and `acceptedEntities` can only use the country to rule a match out if the record
   * actually carries one. Without a country this is a guess dressed as an enrichment.
   *
   * `requireCountry: false` exists for the assistant's "who is this company?" prefill, which has a
   * typed name and nothing else. That answer is a suggestion in chat the requester reads and can
   * ignore, not a value proposed into a field - see registryEnrichment in business-partner-service.
   */
  const confirmedByVies = facts.vies.some((check) => check.status === STATUS.VALID);
  const identified = Boolean(typedName) && (Boolean(country) || !requireCountry);

  if (useGleif && identified && !confirmedByVies) {
    const entities = await lookupName(typedName, options);
    const accepted = acceptedEntities(typedName, entities, country);
    facts.gleif = accepted;
    for (const entity of accepted) {
      for (const name of [entity.legalName, ...entity.otherNames]) {
        additionalNames.push(name);
        provenance.push({ field: 'Name', value: name, source: 'GLEIF', lei: entity.lei });
      }
      if (entity.address?.CityName) addresses.push(entity.address);
    }
    // Ambiguity is not a reason to guess: two plausible entities means neither identifier is safe.
    if (accepted.length === 1 && accepted[0].registeredAs) {
      const entity = accepted[0];
      taxNumbers.push({
        BPTaxType: entity.registeredAt || 'GLEIF',
        BPTaxNumber: entity.registeredAs
      });
      provenance.push({
        field: 'TaxNumber', value: entity.registeredAs, source: 'GLEIF', lei: entity.lei
      });
    }
  }

  return {
    record: {
      ...record,
      additionalNames: [...(record.additionalNames || []), ...additionalNames],
      taxNumbers: [...(record.taxNumbers || []), ...taxNumbers],
      addresses: [...(record.addresses || []), ...addresses]
    },
    facts,
    provenance,
    findings
  };
}

module.exports = {
  ACCEPT_SCORE,
  addressText,
  differingAddressFields,
  namesOf,
  acceptedEntities,
  vatFindings,
  enrichCandidate
};
