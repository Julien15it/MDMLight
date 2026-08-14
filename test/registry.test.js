'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toEntity, recordsFrom, leisFromCompletions, searchByName } = require('../srv/ai/gleif');
const {
  STATUS, viesCountryCode, nationalNumber, statusFrom, parseAddress, checkVatNumber,
  clearVatCache, RETRY_DELAY_MS
} = require('../srv/ai/vies');
const {
  acceptedEntities, vatFindings, enrichCandidate, differingAddressFields
} = require('../srv/ai/registry');
const { evaluate, DEFAULT_RULES, VERDICTS } = require('../srv/ai/duplicate-engine');

const LEI = '549300ABCDEFGHIJKL01';

const gleifRecord = (overrides = {}) => ({
  type: 'lei-records',
  id: overrides.lei || LEI,
  attributes: {
    lei: overrides.lei || LEI,
    entity: {
      legalName: { name: overrides.legalName || 'NV ACKERMANS & VAN HAAREN', language: 'nl' },
      otherNames: overrides.otherNames || [{ name: 'AvH', type: 'TRADING_OR_OPERATING_NAME' }],
      legalAddress: {
        language: 'nl',
        addressLines: ['Begijnenvest 113'],
        city: 'Antwerpen',
        region: 'BE-VAN',
        country: 'BE',
        postalCode: '2000'
      },
      registeredAt: { id: 'RA000045', other: '' },
      registeredAs: overrides.registeredAs === undefined ? '0404616494' : overrides.registeredAs,
      status: 'ACTIVE'
    }
  }
});

// Captured live from VIES on 2026-08-12. The fake must emit what the real transport emits.
const VIES_VALID = {
  isValid: true,
  requestDate: '2026-08-12T08:52:11.145Z',
  userError: 'VALID',
  name: 'NV ACKERMANS & VAN HAAREN',
  address: 'Begijnenvest 113\n2000 Antwerpen',
  originalVatNumber: '0404616494',
  vatNumber: '0404616494'
};
const VIES_INVALID = {
  isValid: false, requestDate: '', userError: 'INVALID', name: '---', address: '---', vatNumber: '0123456789'
};
const VIES_THROTTLED = {
  isValid: false,
  requestDate: '',
  userError: 'MS_MAX_CONCURRENT_REQ',
  name: '---',
  address: '---',
  vatNumber: '0417497106'
};

const fetchReturning = (...bodies) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return { ok: true, json: async () => body };
  };
  impl.calls = calls;
  return impl;
};

// The VAT cache is module state, so every VIES test starts empty and never really sleeps.
const vies = (fetchImpl, options = {}) => {
  clearVatCache();
  return { fetchImpl, sleep: async () => {}, ...options };
};

test('maps the GLEIF record onto the paths the live API actually uses', () => {
  const entity = toEntity(gleifRecord());
  assert.equal(entity.lei, LEI);
  assert.equal(entity.legalName, 'NV ACKERMANS & VAN HAAREN');
  assert.deepEqual(entity.otherNames, ['AvH']);
  assert.equal(entity.registeredAs, '0404616494');
  assert.equal(entity.registeredAt, 'RA000045');
  assert.equal(entity.status, 'ACTIVE');
  // GLEIF sends addressLines, so no house number is split out here — only VIES needs that.
  assert.deepEqual(entity.address, {
    StreetName: 'Begijnenvest 113', PostalCode: '2000', CityName: 'Antwerpen', Country: 'BE'
  });
});

test('drops a record with no legal name rather than yielding a nameless entity', () => {
  assert.deepEqual(recordsFrom({ data: [{ attributes: { entity: {} } }] }), []);
  assert.deepEqual(recordsFrom({}), []);
});

test('reads the LEI out of the fuzzycompletions relationship and dedupes', () => {
  const body = {
    data: [
      { attributes: { value: 'A' }, relationships: { 'lei-records': { data: { id: LEI } } } },
      { attributes: { value: 'B' }, relationships: { 'lei-records': { data: { id: LEI } } } },
      { attributes: { value: 'C' }, relationships: {} }
    ]
  };
  assert.deepEqual(leisFromCompletions(body), [LEI]);
});

test('falls back to the fuzzy pass only when the name filter found nothing', async () => {
  const hit = fetchReturning({ data: [gleifRecord()] });
  assert.equal((await searchByName('Ackermans', { fetchImpl: hit })).length, 1);
  assert.equal(hit.calls.length, 1, 'a direct hit costs one call');

  const miss = fetchReturning(
    { data: [] },
    { data: [{ relationships: { 'lei-records': { data: { id: LEI } } } }] },
    { data: [gleifRecord()] }
  );
  const found = await searchByName('Ackermans', { fetchImpl: miss });
  assert.equal(found.length, 1);
  assert.equal(miss.calls.length, 3);
  assert.match(miss.calls[1], /fuzzycompletions/u);
  assert.match(miss.calls[2], /filter%5Blei%5D=549300ABCDEFGHIJKL01|filter\[lei\]=549300ABCDEFGHIJKL01/u);
});

test('a throttled member state is unknown, not invalid', () => {
  assert.equal(statusFrom(VIES_VALID), STATUS.VALID);
  assert.equal(statusFrom(VIES_INVALID), STATUS.INVALID);
  assert.equal(statusFrom(VIES_THROTTLED), STATUS.UNKNOWN);
  assert.equal(statusFrom({ isValid: false, userError: 'MS_UNAVAILABLE' }), STATUS.UNKNOWN);
  assert.equal(statusFrom({}), STATUS.UNKNOWN);
});

test('VIES country codes are not ISO codes', () => {
  assert.equal(viesCountryCode('GR'), 'EL');
  assert.equal(viesCountryCode('be'), 'BE');
  assert.equal(nationalNumber('BE 0404.616.494', 'BE'), '0404616494');
  assert.equal(nationalNumber('0404616494', 'BE'), '0404616494');
});

test('parses the address a member state returns, and never mistakes --- for data', () => {
  // S/4 keeps the number in its own field, so the street line is split.
  assert.deepEqual(parseAddress('Begijnenvest 113\n2000 Antwerpen', 'BE'), {
    StreetName: 'Begijnenvest', HouseNumber: '113', PostalCode: '2000', CityName: 'Antwerpen', Country: 'BE'
  });
  assert.equal(parseAddress('---', 'BE'), null);
  assert.equal(parseAddress('', 'BE'), null);
  // Germany returns no address at all; a single unparseable line must not vanish.
  assert.deepEqual(parseAddress('Musterstrasse 1', 'DE'), {
    StreetName: 'Musterstrasse', HouseNumber: '1', PostalCode: '', CityName: '', Country: 'DE'
  });
});

// Conservative on purpose: a number it cannot read cleanly stays part of the street rather than
// being guessed at, which is what the old behaviour did for every address.
test('only a plain trailing house number is split off', () => {
  const street = (line, country = 'BE') => {
    const parsed = parseAddress(line, country);
    return [parsed.StreetName, parsed.HouseNumber];
  };
  assert.deepEqual(street('Rue de la Loi 16A'), ['Rue de la Loi', '16A']);
  assert.deepEqual(street('Kerkstraat 12 bus 3'), ['Kerkstraat 12 bus 3', '']);
  assert.deepEqual(street('Avenue Louise 149 boite 24'), ['Avenue Louise 149 boite 24', '']);
  assert.deepEqual(street('16 Rue de la Loi'), ['16 Rue de la Loi', '']);
  assert.deepEqual(street('Koedreef'), ['Koedreef', '']);
});

test('a non-EU country is not checked at all', async () => {
  const fetchImpl = fetchReturning(VIES_VALID);
  const check = await checkVatNumber('US', '12-3456789', vies(fetchImpl));
  assert.equal(check.status, STATUS.NOT_APPLICABLE);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a valid check returns the registered name and address', async () => {
  const check = await checkVatNumber('BE', '0404.616.494', vies(fetchReturning(VIES_VALID)));
  assert.equal(check.status, STATUS.VALID);
  assert.equal(check.name, 'NV ACKERMANS & VAN HAAREN');
  assert.equal(check.address.CityName, 'Antwerpen');
  assert.equal(check.vatNumber, '0404616494');
});

// Pressing Check twice used to be two requests, the second arriving while the first still counted.
test('a settled answer is given from the cache rather than asked again', async () => {
  const fetchImpl = fetchReturning(VIES_VALID);
  const options = vies(fetchImpl);
  await checkVatNumber('BE', '0404.616.494', options);
  const again = await checkVatNumber('BE', '0404616494', options);
  assert.equal(fetchImpl.calls.length, 1, 'the same number is asked once');
  assert.equal(again.status, STATUS.VALID);
});

// MS_MAX_CONCURRENT_REQ means "ask again in a moment", not "no".
test('a throttled answer is retried before it is reported', async () => {
  const fetchImpl = fetchReturning(VIES_THROTTLED, VIES_VALID);
  const waits = [];
  const check = await checkVatNumber('BE', '0404.616.494', vies(fetchImpl, {
    sleep: async (ms) => { waits.push(ms); }
  }));
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(waits, [RETRY_DELAY_MS], 'it waits before asking again');
  assert.equal(check.status, STATUS.VALID);
});

// Briefly cached too, or three presses are three more requests to a state that just said it was busy.
test('an unresolved answer is held briefly and then re-asked', async () => {
  const fetchImpl = fetchReturning(VIES_THROTTLED);
  const options = vies(fetchImpl, { attempts: 1 });
  const first = await checkVatNumber('BE', '0404.616.494', options);
  await checkVatNumber('BE', '0404.616.494', options);
  assert.equal(first.status, STATUS.UNKNOWN);
  assert.equal(fetchImpl.calls.length, 1, 'the second press rides on the first unknown');

  // A minute later the same press asks again rather than repeating a stale outage forever.
  const later = Date.now() + 61 * 1000;
  await checkVatNumber('BE', '0404.616.494', { ...options, now: () => later });
  assert.equal(fetchImpl.calls.length, 2);
});

// The one that stopped the whole check: a throw reached runValidations, which blocks.
test('an unreachable VIES is an unknown answer, not a thrown error', async () => {
  const check = await checkVatNumber('BE', '0404.616.494', vies(async () => {
    throw new Error('Internet lookup returned HTTP 429.');
  }, { attempts: 1 }));
  assert.equal(check.status, STATUS.UNKNOWN);
  assert.equal(check.reason, 'UNREACHABLE');
  assert.match(check.detail, /429/u);
});

test('an aborted request is reported as a timeout so the retry knows to wait', async () => {
  const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  const check = await checkVatNumber('BE', '0404.616.494', vies(async () => {
    throw abort;
  }, { attempts: 1 }));
  assert.equal(check.reason, 'TIMEOUT');
});

test('findings distinguish not-registered from could-not-check', () => {
  const invalid = vatFindings({ status: STATUS.INVALID, countryCode: 'BE', vatNumber: '1' }, 'X');
  assert.equal(invalid[0].severity, 'error');
  const unknown = vatFindings(
    { status: STATUS.UNKNOWN, countryCode: 'BE', vatNumber: '1', reason: 'MS_UNAVAILABLE' }, 'X'
  );
  assert.equal(unknown[0].severity, 'info');
  const mismatch = vatFindings(
    { status: STATUS.VALID, countryCode: 'BE', vatNumber: '1', name: 'Totally Other' }, 'Alluvion'
  );
  assert.equal(mismatch[0].severity, 'warning');
  assert.deepEqual(
    vatFindings({ status: STATUS.VALID, countryCode: 'BE', vatNumber: '1', name: 'Alluvion NV' }, 'Alluvion'),
    []
  );
});

test('a loose GLEIF hit is rejected before it can contribute anything', () => {
  const entities = recordsFrom({ data: [gleifRecord({ legalName: 'Ackermans Bakery Ltd' })] });
  assert.deepEqual(acceptedEntities('Alluvion', entities, 'BE'), []);
  assert.equal(acceptedEntities('Ackermans Bakery', entities, 'BE').length, 1);
  assert.deepEqual(acceptedEntities('Ackermans Bakery', entities, 'NL'), [], 'country must agree');
});

test('an ambiguous GLEIF result contributes names but never an identifier', async () => {
  const two = [
    gleifRecord({ lei: 'A'.repeat(20), registeredAs: '0404616494' }),
    gleifRecord({ lei: 'B'.repeat(20), registeredAs: '0999999999' })
  ];
  const enriched = await enrichCandidate(
    { Name: 'Ackermans & van Haaren', Country: 'BE' },
    { useVies: false, lookupName: async () => recordsFrom({ data: two }) }
  );
  assert.equal(enriched.record.taxNumbers.length, 0);
  assert.ok(enriched.record.additionalNames.includes('NV ACKERMANS & VAN HAAREN'));
  assert.ok(enriched.provenance.every((entry) => entry.source === 'GLEIF'));
});

test('a single confident GLEIF hit contributes its local company number with provenance', async () => {
  const enriched = await enrichCandidate(
    { Name: 'Ackermans & van Haaren', Country: 'BE' },
    { useVies: false, lookupName: async () => recordsFrom({ data: [gleifRecord()] }) }
  );
  assert.deepEqual(enriched.record.taxNumbers, [{ BPTaxType: 'RA000045', BPTaxNumber: '0404616494' }]);
  assert.ok(enriched.provenance.some(
    (entry) => entry.field === 'TaxNumber' && entry.source === 'GLEIF' && entry.lei === LEI
  ));
});

test('a VIES outage enriches nothing and reports nothing as invalid', async () => {
  const enriched = await enrichCandidate(
    { Name: 'Ackermans', Country: 'BE', taxNumbers: [{ BPTaxNumber: '0417497106' }] },
    { useGleif: false, ...vies(fetchReturning(VIES_THROTTLED), { attempts: 1 }) }
  );
  assert.equal(enriched.record.additionalNames.length, 0);
  assert.equal(enriched.findings[0].severity, 'info');
  assert.equal(enriched.facts.vies[0].status, STATUS.UNKNOWN);
});

test('enrichment lets a trading name find the partner stored under its legal name', async () => {
  const partners = [{ partner: { BusinessPartner: '99', BusinessPartnerFullName: 'Ackermans & van Haaren NV' } }];
  const typed = { Name: 'AvH', Country: 'BE' };

  assert.deepEqual(evaluate(typed, partners, { rules: DEFAULT_RULES }), [], 'no match on the short name alone');

  const enriched = await enrichCandidate(typed, {
    useVies: false,
    lookupName: async () => recordsFrom({ data: [gleifRecord({ otherNames: [{ name: 'AvH' }] })] })
  });
  const [found] = evaluate(enriched.record, partners, { rules: DEFAULT_RULES });
  assert.equal(found.partner.BusinessPartner, '99');
  assert.equal(found.verdict, VERDICTS.DUPLICATE);
});

// GLEIF is the fallback, not a second opinion. Matching on a name alone put a Belgian company under
// a Dutch entity's number on 2026-08-14; once VIES confirms the VAT number, GLEIF cannot improve it.
test('GLEIF is not consulted once VIES has confirmed the VAT number', async () => {
  let asked = 0;
  const enriched = await enrichCandidate(
    { Name: 'Ackermans & van Haaren', Country: 'BE', taxNumbers: [{ BPTaxNumber: '0404616494' }] },
    {
      ...vies(fetchReturning(VIES_VALID)),
      lookupName: async () => { asked += 1; return []; }
    }
  );
  assert.equal(asked, 0, 'no GLEIF call at all');
  assert.deepEqual(enriched.facts.gleif, []);
  // VIES still enriches: its registered name is the one worth having.
  assert.ok(enriched.record.additionalNames.includes('NV ACKERMANS & VAN HAAREN'));
});

test('GLEIF still runs when VIES cannot confirm the number', async () => {
  let asked = 0;
  const enriched = await enrichCandidate(
    { Name: 'Ackermans & van Haaren', Country: 'BE', taxNumbers: [{ BPTaxNumber: '0417497106' }] },
    {
      ...vies(fetchReturning(VIES_THROTTLED), { attempts: 1 }),
      lookupName: async () => { asked += 1; return recordsFrom({ data: [gleifRecord()] }); }
    }
  );
  assert.equal(asked, 1);
  assert.equal(enriched.facts.gleif.length, 1);
});

test('GLEIF still runs when no VAT number was given at all', async () => {
  let asked = 0;
  await enrichCandidate({ Name: 'Ackermans & van Haaren', Country: 'BE' }, {
    ...vies(fetchReturning(VIES_VALID)),
    lookupName: async () => { asked += 1; return []; }
  });
  assert.equal(asked, 1, 'nothing confirmed anything, so the fallback applies');
});

// Maarten 2026-08-14: VIES fills gaps and validates, the model normalises. So a register address
// that disagrees with a filled-in one is reported rather than proposed as a change.
test('a VIES address that disagrees with the typed one is a warning naming both', () => {
  const [name, address] = vatFindings(
    {
      status: STATUS.VALID, countryCode: 'BE', vatNumber: '0404616494', name: 'ALLUVION BV',
      address: { StreetName: 'Koedreef', HouseNumber: '12', PostalCode: '2000', CityName: 'Antwerpen' }
    },
    'ALLUVION BV',
    { StreetName: 'Kerkstraat', HouseNumber: '12', PostalCode: '9000', CityName: 'Gent' }
  );
  assert.equal(name, undefined, 'the name agrees, so only the address is reported');
  assert.equal(address.check, 'vat_address_matches');
  assert.equal(address.severity, 'warning');
  assert.match(address.message, /Koedreef 12 2000 Antwerpen/u);
  assert.match(address.message, /Kerkstraat 12 9000 Gent/u);
  assert.match(address.message, /StreetName, PostalCode, CityName/u, 'HouseNumber agrees');
});

// A gap is the derivation's job, and casing is the model's, so neither is a disagreement.
test('an empty or differently written address field is not a disagreement', () => {
  const official = { StreetName: 'Koedreef', HouseNumber: '12', CityName: 'Antwerpen' };
  assert.deepEqual(differingAddressFields(official, { StreetName: 'koedreef', CityName: '' }), []);
  assert.deepEqual(differingAddressFields(official, { StreetName: '  KOEDREEF ' }), []);
  assert.deepEqual(differingAddressFields(official, {}), []);
  assert.deepEqual(differingAddressFields(null, official), []);
  assert.deepEqual(differingAddressFields(official, { CityName: 'Gent' }), ['CityName']);
});

test('a name and an address can both disagree at once', () => {
  const findings = vatFindings(
    {
      status: STATUS.VALID, countryCode: 'BE', vatNumber: '1', name: 'ALLUVION BV',
      address: { CityName: 'Antwerpen' }
    },
    'Totally Other',
    { CityName: 'Gent' }
  );
  assert.deepEqual(findings.map((finding) => finding.check), ['vat_name_matches', 'vat_address_matches']);
});
