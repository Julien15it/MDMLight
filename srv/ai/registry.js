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

function vatFindings(check, typedName) {
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
  if (check.status !== STATUS.VALID || !check.name || !typedName) return [];
  if (scoreAgainst(typedName, check.name) >= ACCEPT_SCORE) return [];
  return [{
    check: 'vat_name_matches',
    severity: 'warning',
    message: `VIES registers ${check.countryCode}${check.vatNumber} as “${check.name}”, not “${typedName}”.`
  }];
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
      findings.push(...vatFindings(check, typedName));
      if (check.status !== STATUS.VALID) continue;
      if (check.name) {
        additionalNames.push(check.name);
        provenance.push({ field: 'Name', value: check.name, source: 'VIES' });
      }
      if (check.address) addresses.push(check.address);
    }
  }

  if (useGleif && typedName) {
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
  namesOf,
  acceptedEntities,
  vatFindings,
  enrichCandidate
};
