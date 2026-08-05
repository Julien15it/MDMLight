'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');

const BusinessPartnerService = require('../srv/business-partner-service');
const {
  MAINTENANCE_ENTITIES,
  SEARCHABLE_FIELDS,
  answerBusinessPartnerQuestion,
  assistantAddressFilter,
  readAllPages,
  readAssistantAddresses,
  addDefaultAddressUsage,
  businessPartnerCreationSuggestion,
  businessPartnerNavigationPath,
  createBusinessPartnerChild,
  createBusinessPartnerAddress,
  contextualCompanyName,
  findPotentialDuplicates,
  applyBusinessPartnerSearch,
  normalizeRemoteResult,
  parseConversationHistory,
  parseJsonObject,
  pickDefined,
  remoteErrorMessage,
  sanitizeEntityKeys,
  sanitizeEntityPayload,
  validateMaintenanceCreate,
  validateBusinessPartnerCreate
} = BusinessPartnerService._internals;

test('converts Fiori free-text search to S/4-compatible contains filters', () => {
  const query = {
    SELECT: {
      from: { ref: ['BusinessPartnerService.BusinessPartners'] },
      search: [{ val: 'Acme Brussels' }],
      where: [{ ref: ['BusinessPartnerCategory'] }, '=', { val: '2' }]
    }
  };

  applyBusinessPartnerSearch(query);

  assert.equal(query.SELECT.search, undefined);
  assert.deepEqual(query.SELECT.where.slice(0, 3), [
    { xpr: [{ ref: ['BusinessPartnerCategory'] }, '=', { val: '2' }] },
    'and',
    { xpr: query.SELECT.where[2].xpr }
  ]);

  const serialized = JSON.stringify(query.SELECT.where[2]);
  assert.match(serialized, /Acme/);
  assert.match(serialized, /Brussels/);
  for (const field of SEARCHABLE_FIELDS) assert.match(serialized, new RegExp(field));
});

test('serializes the rewritten search as an OData V2 substring filter', async () => {
  const model = await cds.load('srv/external/API_BUSINESS_PARTNER');
  const query = cds.ql.SELECT
    .from('API_BUSINESS_PARTNER.A_BusinessPartner')
    .columns('BusinessPartner')
    .limit(20);

  query.SELECT.search = [{ val: "O'Hara" }];
  applyBusinessPartnerSearch(query);

  const request = cds.odata.urlify(query, {
    kind: 'odata-v2',
    model,
    method: 'GET'
  });

  assert.equal(request.method, 'GET');
  assert.match(request.path, /^A_BusinessPartner\?/);
  assert.match(request.path, /\$filter=/);
  assert.match(request.path, /substringof\('O''Hara',BusinessPartner\)/);
});

test('accepts a valid organization create payload', () => {
  assert.deepEqual(validateBusinessPartnerCreate({
    BusinessPartnerCategory: '2',
    BusinessPartnerGrouping: '0001',
    OrganizationBPName1: 'Alluvion Test'
  }), []);
});

test('reports missing create fields with UI targets', () => {
  assert.deepEqual(validateBusinessPartnerCreate({
    BusinessPartnerCategory: '1'
  }), [
    {
      target: 'BusinessPartnerGrouping',
      message: 'Enter a business partner grouping.'
    },
    {
      target: 'LastName',
      message: 'Enter the last name for a person.'
    }
  ]);
});

test('only forwards supported, defined fields to S/4 maintenance operations', () => {
  assert.deepEqual(
    pickDefined(
      {
        SearchTerm1: 'NEW',
        BusinessPartnerIsBlocked: false,
        BusinessPartnerGrouping: undefined,
        UnexpectedField: 'must not be forwarded'
      },
      ['SearchTerm1', 'BusinessPartnerIsBlocked', 'BusinessPartnerGrouping']
    ),
    {
      SearchTerm1: 'NEW',
      BusinessPartnerIsBlocked: false
    }
  );
});

test('full-screen maintenance only forwards scalar model fields', () => {
  const entity = {
    elements: {
      BusinessPartner: { key: true, type: 'cds.String' },
      SearchTerm1: { type: 'cds.String' },
      IsBlocked: { type: 'cds.Boolean' },
      to_Address: { target: 'Some.Address' }
    }
  };

  assert.deepEqual(
    sanitizeEntityPayload(
      {
        BusinessPartner: '1000',
        SearchTerm1: 'TEST',
        IsBlocked: false,
        to_Address: [{ Street: 'must not pass' }],
        Unexpected: 'must not pass'
      },
      entity,
      { isCreate: false }
    ),
    { SearchTerm1: 'TEST', IsBlocked: false }
  );
});

test('full-screen maintenance validates JSON objects and complete keys', () => {
  assert.deepEqual(parseJsonObject('{"SearchTerm1":"TEST"}', 'DataJson'), {
    SearchTerm1: 'TEST'
  });
  assert.throws(() => parseJsonObject('[1,2]', 'DataJson'), /JSON object/);

  const entity = {
    elements: {
      BusinessPartner: { key: true, type: 'cds.String' },
      AddressID: { key: true, type: 'cds.String' },
      CityName: { type: 'cds.String' }
    }
  };
  assert.deepEqual(
    sanitizeEntityKeys({ BusinessPartner: '1000', AddressID: '1' }, entity),
    { BusinessPartner: '1000', AddressID: '1' }
  );
  assert.throws(
    () => sanitizeEntityKeys({ BusinessPartner: '1000' }, entity),
    /AddressID/
  );
});

test('normalizes the common OData V2 create response shapes', () => {
  const partner = { BusinessPartner: '1000' };
  assert.deepEqual(normalizeRemoteResult(partner), partner);
  assert.deepEqual(normalizeRemoteResult([partner]), partner);
  assert.deepEqual(normalizeRemoteResult({ value: [partner] }), partner);
  assert.deepEqual(normalizeRemoteResult({ d: partner }), partner);
  assert.deepEqual(normalizeRemoteResult({ d: { results: [partner] } }), partner);
  assert.equal(normalizeRemoteResult(1), null);
});

test('extracts the original S/4 error instead of hiding it behind a generic error', () => {
  assert.equal(
    remoteErrorMessage({
      response: {
        data: {
          error: { message: { value: 'Grouping BP99 is not permitted.' } }
        }
      }
    }, 'fallback'),
    'Grouping BP99 is not permitted.'
  );
  assert.equal(remoteErrorMessage({}, 'fallback'), 'fallback');
});

test('Business Partner Assistant answers grounded overview and search questions', () => {
  const partners = [
    {
      BusinessPartner: '1',
      BusinessPartnerFullName: 'Brussels Pharmaceuticals SA/NV',
      BusinessPartnerCategory: '2',
      BusinessPartnerGrouping: '0001',
      BusinessPartnerIsBlocked: false
    },
    {
      BusinessPartner: '2',
      BusinessPartnerFullName: 'Blocked Example',
      BusinessPartnerCategory: '1',
      BusinessPartnerGrouping: 'BP02',
      BusinessPartnerIsBlocked: true
    }
  ];

  assert.equal(
    answerBusinessPartnerQuestion('How many Business Partners are there?', partners),
    'There are 2 Business Partners available in S/4HANA.'
  );
  assert.match(
    answerBusinessPartnerQuestion('Which Business Partners are blocked?', partners),
    /2 — Blocked Example/
  );
  assert.match(
    answerBusinessPartnerQuestion('Find Brussels', partners),
    /1 — Brussels Pharmaceuticals SA\/NV/
  );
  assert.match(answerBusinessPartnerQuestion('Hallo', partners), /Hallo!/);
  assert.equal(
    answerBusinessPartnerQuestion('How many Business Partners are there with the name Brussels?', partners),
    '1 Business Partner match “brussels”.'
  );
});

test('Business Partner Assistant can return address details for one partner', () => {
  const partners = [{
    BusinessPartner: '1',
    BusinessPartnerFullName: 'Brussels Pharmaceuticals SA/NV',
    BusinessPartnerCategory: '2',
    BusinessPartnerGrouping: '0001'
  }];
  const addresses = [{
    StreetName: 'Dorpstraat',
    HouseNumber: '5',
    PostalCode: '1000',
    CityName: 'Brussel',
    Country: 'BE'
  }];

  assert.match(
    answerBusinessPartnerQuestion('What is the address of BP 1?', partners, addresses),
    /Dorpstraat 5 1000 Brussel BE/
  );
});

test('Business Partner Assistant searches safe address fields', () => {
  const partners = [{
    BusinessPartner: '1',
    BusinessPartnerFullName: 'Brussels Pharmaceuticals SA/NV',
    BusinessPartnerCategory: '2',
    BusinessPartnerGrouping: '0001'
  }];
  const addresses = [{
    BusinessPartner: '1',
    StreetName: 'Dorpstraat',
    HouseNumber: '5',
    PostalCode: '1000',
    CityName: 'Brussel',
    Country: 'BE'
  }];

  assert.match(
    answerBusinessPartnerQuestion('Find Business Partners in Dorpstraat', partners, addresses),
    /Brussels Pharmaceuticals SA\/NV/
  );
});

test('first address receives XXDEFAULT usage and later addresses do not', async () => {
  assert.deepEqual(addDefaultAddressUsage({
    BusinessPartner: '1000',
    AddressID: '',
    StreetName: 'Dorpstraat'
  }, false), {
    BusinessPartner: '1000',
    StreetName: 'Dorpstraat',
    to_AddressUsage: [{ AddressUsage: 'XXDEFAULT', StandardUsage: true }]
  });

  let sent;
  const firstAddressService = {
    run: async () => null,
    send: async (request) => {
      sent = request;
      return { BusinessPartner: '1000', AddressID: '1' };
    }
  };
  await createBusinessPartnerAddress(firstAddressService, {
    BusinessPartner: '1000',
    StreetName: 'Dorpstraat'
  });
  assert.equal(sent.path, "/A_BusinessPartner('1000')/to_BusinessPartnerAddress");
  assert.deepEqual(sent.data.to_AddressUsage, [{
    AddressUsage: 'XXDEFAULT',
    StandardUsage: true
  }]);

  const laterAddressService = {
    run: async () => ({ AddressID: '1' }),
    send: async (request) => request.data
  };
  const later = await createBusinessPartnerAddress(laterAddressService, {
    BusinessPartner: '1000',
    StreetName: 'Nieuwstraat'
  });
  assert.equal(later.to_AddressUsage, undefined);
});

test('all creatable maintenance entities use their Business Partner navigation', async () => {
  const expected = {
    Addresses: 'to_BusinessPartnerAddress',
    BusinessPartnerRoles: 'to_BusinessPartnerRole',
    TaxNumbers: 'to_BusinessPartnerTax',
    BankDetails: 'to_BusinessPartnerBank',
    Identifications: 'to_BuPaIdentification',
    Industries: 'to_BuPaIndustry'
  };

  for (const [entityName, navigation] of Object.entries(expected)) {
    const configuration = MAINTENANCE_ENTITIES[entityName];
    assert.equal(configuration.creatable, true);
    assert.equal(
      businessPartnerNavigationPath(configuration, { BusinessPartner: '1000' }),
      `/A_BusinessPartner('1000')/${navigation}`
    );
    let sent;
    await createBusinessPartnerChild({
      send: async (request) => {
        sent = request;
        return { BusinessPartner: '1000' };
      }
    }, configuration, { BusinessPartner: '1000' });
    assert.equal(sent.method, 'POST');
    assert.equal(sent.path, `/A_BusinessPartner('1000')/${navigation}`);
  }

  assert.equal(MAINTENANCE_ENTITIES.Customers.creatable, false);
  assert.equal(MAINTENANCE_ENTITIES.Customers.updatable, true);
  assert.equal(MAINTENANCE_ENTITIES.Suppliers.creatable, false);
  assert.equal(MAINTENANCE_ENTITIES.Suppliers.updatable, true);
  assert.equal(MAINTENANCE_ENTITIES.Addresses.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.TaxNumbers.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.BankDetails.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.Identifications.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.Industries.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.BusinessPartnerRoles.deletable, false);
});

test('maintenance create validation enforces entity keys and useful values', () => {
  assert.doesNotThrow(() => validateMaintenanceCreate('TaxNumbers', {
    BusinessPartner: '1000',
    BPTaxType: 'BE0',
    BPTaxNumber: 'BE0123456789'
  }, MAINTENANCE_ENTITIES.TaxNumbers));
  assert.throws(() => validateMaintenanceCreate('TaxNumbers', {
    BusinessPartner: '1000',
    BPTaxType: 'BE0'
  }, MAINTENANCE_ENTITIES.TaxNumbers), /BPTaxNumber or BPTaxLongNumber/);
  assert.throws(() => validateMaintenanceCreate('BankDetails', {
    BusinessPartner: '1000',
    IBAN: 'BE00000000000000'
  }, MAINTENANCE_ENTITIES.BankDetails), /BankIdentification/);
});

test('assistant duplicate check catches legal-form and spelling variants', () => {
  const partners = [{
    BusinessPartner: '1000',
    BusinessPartnerFullName: 'Coca-Cola European Partners NV'
  }];
  assert.equal(findPotentialDuplicates('Coca Cola European Partners', partners).length, 1);
  assert.equal(findPotentialDuplicates('Completely Different Company', partners).length, 0);
});

test('assistant proposes a prefilled Business Partner when a company is absent', () => {
  const partners = [{
    BusinessPartner: '1',
    BusinessPartnerFullName: 'Existing Company'
  }];

  const suggestion = businessPartnerCreationSuggestion(
    'Geef info over het bedrijf Coca-Cola',
    partners
  );
  assert.equal(suggestion.SuggestedAction, 'CREATE_BUSINESS_PARTNER');
  assert.deepEqual(JSON.parse(suggestion.SuggestedData), {
    BusinessPartnerCategory: '2',
    OrganizationBPName1: 'Coca-Cola',
    SearchTerm1: 'Coca Cola'
  });
  assert.equal(
    JSON.parse(businessPartnerCreationSuggestion(
      'Geef info over het bedrijf Coca-Cola',
      partners,
      { title: 'The Coca-Cola Company', source: 'Wikipedia' }
    ).SuggestedData).OrganizationBPName1,
    'The Coca-Cola Company'
  );
  assert.equal(
    businessPartnerCreationSuggestion('Geef info over bedrijf Existing Company', partners),
    null
  );
  const publicSuggestion = JSON.parse(businessPartnerCreationSuggestion(
    'Geef info over het bedrijf SPAR Destelbergen',
    partners,
    {
      title: 'Contact - Spar Destelbergen',
      source: 'Public web search',
      suggestedAddress: {
        StreetName: 'Dendermondsesteenweg',
        HouseNumber: '468',
        PostalCode: '9070',
        CityName: 'Destelbergen',
        Country: 'BE'
      }
    }
  ).SuggestedData);
  assert.equal(publicSuggestion.OrganizationBPName1, 'SPAR Destelbergen');
  assert.equal(publicSuggestion.AddressStreetName, 'Dendermondsesteenweg');
});

test('assistant recognizes free-form Dutch and English company lookup requests', () => {
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Kan je SPAR Destelbergen opzoeken en indien die niet bestaat info opzoeken op internet en de nieuwe BP aanmaken?'
    ),
    'SPAR Destelbergen'
  );
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Could you look up Contoso Belgium and create a proposal if it does not exist?'
    ),
    'Contoso Belgium'
  );
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Is there a Business Partner called Spar Destelbergen?'
    ),
    'Spar Destelbergen'
  );
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Bestaat er een business partner met de naam Spar Destelbergen?'
    ),
    'Spar Destelbergen'
  );
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Kan je een business partner met de naam Spar Destelbergen vinden?'
    ),
    'Spar Destelbergen'
  );
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Ik wil kijken als SPAR destelbergen al bestaat?'
    ),
    'SPAR destelbergen'
  );
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Does Spar Destelbergen exist?'
    ),
    'Spar Destelbergen'
  );
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Does Intellus exist in the system?'
    ),
    'Intellus'
  );
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Bestaat SPAR Destelbergen al in het systeem?'
    ),
    'SPAR Destelbergen'
  );
  assert.equal(
    BusinessPartnerService._internals.requestedCompanyName(
      'Is Intellus a Business Partner? In case not, can you make it?'
    ),
    'Intellus'
  );
});

// The generic "company <rest>" pattern used to win over these and capture the rest of the sentence,
// so the duplicate check ran against "Alluvion already exist in our system" and found nothing.
test('an existence question yields the bare company name, whatever the phrasing', () => {
  const phrasings = [
    'does the company Alluvion already exist in our system?',
    'does the company Alluvion exist in the system?',
    'does the company Alluvion exist?',
    'Does Alluvion already exist in our system?',
    'Does Alluvion exist?',
    'Is there a company called Alluvion?',
    'Any companies called Alluvion?',
    'Is Alluvion a business partner?',
    '"Alluvion"',
    // Trailing words used to be captured as part of the name, typo and all.
    'Are there any companies called Alluvion availebe in our system already?',
    'Is there a company called Alluvion in our system?',
    'Does Alluvion already exist in our system?'
  ];
  for (const phrasing of phrasings) {
    assert.equal(
      BusinessPartnerService._internals.requestedCompanyName(phrasing),
      'Alluvion',
      `extracted the wrong name from “${phrasing}”`
    );
  }
});

test('assistant resolves a company from prior turns for a follow-up create request', () => {
  const history = parseConversationHistory(JSON.stringify([
    { role: 'user', content: 'Kan je een business partner met de naam Spar Destelbergen vinden?' },
    { role: 'assistant', content: 'No matching Business Partner was found.' }
  ]));
  assert.equal(
    contextualCompanyName('Kan je informatie vergaren en er een BP van maken?', history),
    'Spar Destelbergen'
  );
  assert.equal(contextualCompanyName('Yes', history), 'Spar Destelbergen');
  assert.equal(contextualCompanyName('Ja graag', history), 'Spar Destelbergen');
  assert.equal(contextualCompanyName('Intellus', []), 'Intellus');
  assert.equal(contextualCompanyName('Hallo', []), '');
  const confirmedSuggestion = JSON.parse(businessPartnerCreationSuggestion(
    'Yes',
    [],
    {
      source: 'Public web search',
      suggestedAddress: {
        StreetName: 'Dendermondsesteenweg',
        HouseNumber: '468',
        PostalCode: '9070',
        CityName: 'Destelbergen',
        Country: 'BE'
      }
    },
    contextualCompanyName('Yes', history)
  ).SuggestedData);
  assert.equal(confirmedSuggestion.OrganizationBPName1, 'Spar Destelbergen');
  assert.equal(confirmedSuggestion.AddressCityName, 'Destelbergen');
  assert.equal(contextualCompanyName('SPAR destelbergen', history), 'SPAR destelbergen');
  assert.throws(
    () => parseConversationHistory('{broken'),
    /ConversationJson must contain valid JSON/
  );
});

test('scopes the address filter to the partners in context', () => {
  const filter = assistantAddressFilter([
    { BusinessPartner: '1' },
    { BusinessPartner: '2' }
  ]);

  assert.deepEqual(filter, [
    { xpr: [{ ref: ['BusinessPartner'] }, '=', { val: '1' }] },
    'or',
    { xpr: [{ ref: ['BusinessPartner'] }, '=', { val: '2' }] }
  ]);
  assert.deepEqual(assistantAddressFilter([]), []);
});

test('pages through every row instead of truncating at the first page', async () => {
  const pageSize = 2;
  const rows = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }];
  const requested = [];
  const s4 = {
    run: async ({ top, skip }) => {
      requested.push({ top, skip });
      return rows.slice(skip, skip + top);
    }
  };

  const read = await readAllPages(s4, (top, skip) => ({ top, skip }), pageSize);

  assert.deepEqual(read, rows);
  assert.deepEqual(requested, [
    { top: 2, skip: 0 },
    { top: 2, skip: 2 },
    { top: 2, skip: 4 }
  ]);
});

test('performs one confirming read when the final page is exactly full', async () => {
  const rows = [{ n: 1 }, { n: 2 }];
  let calls = 0;
  const s4 = {
    run: async ({ top, skip }) => {
      calls += 1;
      return rows.slice(skip, skip + top);
    }
  };

  assert.deepEqual(await readAllPages(s4, (top, skip) => ({ top, skip }), 2), rows);
  assert.equal(calls, 2);
});

test('reads addresses in chunks so the generated filter stays short', async () => {
  const partners = Array.from({ length: 120 }, (_, index) => ({
    BusinessPartner: String(index + 1)
  }));
  const filterSizes = [];
  const s4 = {
    entities: {},
    run: async (query) => {
      const serialized = JSON.stringify(query.SELECT.where || []);
      filterSizes.push((serialized.match(/"BusinessPartner"/gu) || []).length);
      return [];
    }
  };

  await readAssistantAddresses(s4, partners);

  assert.equal(filterSizes.length, 3);
  assert.deepEqual(filterSizes, [50, 50, 20]);
  assert.deepEqual(await readAssistantAddresses(s4, []), []);
});
