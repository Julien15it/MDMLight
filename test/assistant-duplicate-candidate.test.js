'use strict';

/**
 * Reported 2026-09-08: the assistant called a company clean and the Duplicate Check button then
 * found it. Both run the same index, rules and engine - the assistant simply asked a different
 * question, `{ Name: companyName }`, which loses a duplicate three silent ways: a rule on any
 * other field cannot fire (a blank side scores 0), a rule carrying a condition is not even
 * applicable (both bags must satisfy it), and one name indicator can never reach `strong`.
 *
 * So the assistant now asks about the record it would CREATE, built after the VIES/GLEIF chain has
 * answered, through the same `candidateFromStagedRequest` the button uses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { assistantDuplicateCandidate } = require('../srv/business-partner-service')._internals;
const { checkAgainstPartners, toEntries } = require('../srv/ai/duplicate-check');
const { evaluate, DEFAULT_RULES, VERDICTS } = require('../srv/ai/duplicate-engine');
// Exported as STATUS; the service aliases it the same way.
const { STATUS: VIES_STATUS } = require('../srv/ai/vies');

const VIES_CONFIRMED = Object.freeze({
  name: 'ALLUVION CONSULTING NV',
  taxNumber: { BPTaxType: 'BE0', BPTaxNumber: 'BE0448207405' },
  address: { StreetName: 'Kortrijksesteenweg', PostalCode: '9000', CityName: 'Gent', Country: 'BE' },
  source: 'VIES'
});

// What the assistant hands back for "prepare a business partner for Alluvion" - the shape
// businessPartnerCreationSuggestion returns, not a hand-made one.
const suggestionFor = (registry) => ({
  SuggestedAction: 'CREATE_BUSINESS_PARTNER',
  SuggestedData: JSON.stringify({
    root: {
      BusinessPartnerCategory: '2',
      OrganizationBPName1: registry.name,
      SearchTerm1: 'Alluvion'
    },
    sections: {
      Addresses: [registry.address],
      TaxNumbers: [registry.taxNumber]
    }
  })
});

// The partner already in S/4: a different spelling of the name, the same VAT number.
const EXISTING = Object.freeze({
  BusinessPartner: '4711',
  OrganizationBPName1: 'Aluvion Consult',
  BusinessPartnerCategory: '2',
  addresses: [{ PostalCode: '9000', CityName: 'Gent', Country: 'BE' }],
  taxNumbers: [{ BPTaxType: 'BE0', BPTaxNumber: 'BE0448207405' }],
  roles: [{ BusinessPartnerRole: 'FLVN01' }]
});

test('the candidate carries the tax number, country and city the registry confirmed', () => {
  const candidate = assistantDuplicateCandidate({
    companyName: 'Alluvion',
    suggestion: suggestionFor(VIES_CONFIRMED),
    registry: VIES_CONFIRMED
  });

  assert.deepEqual(candidate.taxNumbers, [VIES_CONFIRMED.taxNumber]);
  assert.deepEqual(candidate.addresses, [VIES_CONFIRMED.address]);
  assert.equal(candidate.OrganizationBPName1, VIES_CONFIRMED.name);
  // The typed name AND the register's own, because a register answers under the legal name.
  assert.equal(candidate.Name, 'Alluvion');
  assert.deepEqual(candidate.additionalNames, [VIES_CONFIRMED.name]);
});

test('the enriched candidate finds the duplicate a name-only question missed', () => {
  const partners = [EXISTING];

  // What the assistant used to ask: the bare name. The spelling is too far off to score, and
  // nothing else is in the bag to vote.
  const nameOnly = checkAgainstPartners({ Name: 'Alluvion' }, partners, { rules: DEFAULT_RULES });
  assert.ok(
    nameOnly.every((result) => result.verdict !== VERDICTS.DUPLICATE),
    'a name-only bag cannot reach a definitive verdict: the identifier rule has nothing to compare'
  );

  // What it asks now.
  const candidate = assistantDuplicateCandidate({
    companyName: 'Alluvion',
    suggestion: suggestionFor(VIES_CONFIRMED),
    registry: VIES_CONFIRMED
  });
  const enriched = evaluate(candidate, toEntries(partners), { rules: DEFAULT_RULES });
  assert.equal(enriched.length, 1, 'the same pair, now with a matching identifier');
  assert.equal(enriched[0].verdict, VERDICTS.DUPLICATE);
  assert.ok(
    enriched[0].indicators.some((found) => found.field === 'TaxNumber'),
    'the VAT number VIES confirmed is what makes it definitive'
  );
});

/**
 * `applicableRules` needs BOTH bags to satisfy a rule's conditions, and a name-only bag has no
 * Country, Category or Role at all - so a conditioned rule was not merely scoring zero, it was
 * never run.
 */
test('a rule conditioned on country now applies to the assistant candidate too', () => {
  const rules = [{
    sequence: 10,
    field: 'Name',
    comparison: 'fuzzy',
    threshold: 0.6,
    indicator: 'definitive',
    conditionField: 'Country',
    conditionValue: 'BE'
  }];

  assert.deepEqual(
    checkAgainstPartners({ Name: 'Aluvion Consult' }, [EXISTING], { rules }),
    [],
    'the condition cannot hold for a candidate with no country'
  );

  const candidate = assistantDuplicateCandidate({
    companyName: 'Aluvion Consult',
    registry: VIES_CONFIRMED
  });
  assert.equal(evaluate(candidate, toEntries([EXISTING]), { rules }).length, 1);
});

test('a question that is nothing but a VAT number is still checked', () => {
  const candidate = assistantDuplicateCandidate({
    companyName: '',
    directVat: {
      status: VIES_STATUS.VALID,
      name: VIES_CONFIRMED.name,
      taxNumber: VIES_CONFIRMED.taxNumber,
      address: VIES_CONFIRMED.address
    }
  });

  assert.ok(candidate, 'no company name is no longer no check');
  assert.deepEqual(candidate.taxNumbers, [VIES_CONFIRMED.taxNumber]);
  assert.equal(evaluate(candidate, toEntries([EXISTING]), { rules: DEFAULT_RULES })[0].verdict, VERDICTS.DUPLICATE);
});

test('an unconfirmed VAT number is not put in the bag as if it were', () => {
  const candidate = assistantDuplicateCandidate({
    companyName: 'Alluvion',
    directVat: { status: VIES_STATUS.INVALID, taxNumber: VIES_CONFIRMED.taxNumber }
  });
  assert.deepEqual(candidate.taxNumbers, [], 'only VIES_STATUS.VALID counts as confirmed');
});

test('nothing to ask about answers null rather than matching everything', () => {
  assert.equal(assistantDuplicateCandidate(), null);
  assert.equal(assistantDuplicateCandidate({ companyName: '', registry: null }), null);
});

test('a malformed suggestion degrades to the name, it does not throw', () => {
  const candidate = assistantDuplicateCandidate({
    companyName: 'Alluvion',
    suggestion: { SuggestedAction: 'CREATE_BUSINESS_PARTNER', SuggestedData: '{not json' }
  });
  assert.equal(candidate.Name, 'Alluvion');
  assert.deepEqual(candidate.taxNumbers, []);
});

/** The order is the fix: asking before the registry answered is asking about a name. */
test('the assistant asks only after the registry chain has settled', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'business-partner-service.js'), 'utf8'
  );
  const registryAt = source.indexOf('registryEnrichment(companyName)');
  // The CALL, not the definition - the builder itself lives beside findIndexedDuplicates,
  // hundreds of lines ABOVE the handler, so matching the bare name asserts the wrong thing.
  const askAt = source.indexOf('const duplicateCandidate = assistantDuplicateCandidate(');
  assert.ok(registryAt > 0 && askAt > registryAt, 'the duplicate question moved back before the enrichment');
  assert.ok(
    !/findIndexedDuplicates\(s4, companyName/u.test(source),
    'nothing asks the engine about a bare company name any more'
  );
});
