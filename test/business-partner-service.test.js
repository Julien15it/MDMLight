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
  requestingUserEmail,
  WORKFLOW_ENTITIES,
  WORKFLOW_INPUT_ENTITIES,
  lowerFirst,
  toWorkflowValue,
  toWorkflowShape,
  buildWorkflowInputFromRows,
  WORKFLOW_AUDIT_FIELDS,
  WORKFLOW_FIELD_EXCLUSIONS,
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
  assert.equal(MAINTENANCE_ENTITIES.BusinessPartnerRoles.deletable, true);
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

test('requesting user email prefers the XSUAA email claim over the logon name', () => {
  assert.equal(
    requestingUserEmail({ user: { id: 'jdoe', attr: { email: 'jane.doe@example.com' } } }),
    'jane.doe@example.com'
  );
  assert.equal(requestingUserEmail({ user: { id: 'jdoe', attr: {} } }), 'jdoe');
  assert.equal(requestingUserEmail({ user: {} }), '');
  assert.equal(requestingUserEmail({}), '');
});

test('lowerFirst only lower-cases the leading character', () => {
  assert.equal(lowerFirst('BusinessPartner'), 'businessPartner');
  assert.equal(lowerFirst('POBox'), 'pOBox');
  assert.equal(lowerFirst('BPTaxType'), 'bPTaxType');
  assert.equal(lowerFirst('VATRegistration'), 'vATRegistration');
});

test('toWorkflowValue applies BPA-friendly defaults and types per element', () => {
  // Date/time elements are handled separately by toWorkflowShape (they can
  // be omitted entirely) — toWorkflowValue only covers string/boolean/number.
  assert.equal(toWorkflowValue({ type: 'cds.String' }, undefined), '');
  assert.equal(toWorkflowValue({ type: 'cds.String' }, null), '');
  assert.equal(toWorkflowValue({ type: 'cds.String' }, ''), '');
  assert.equal(toWorkflowValue({ type: 'cds.String' }, 'BP01'), 'BP01');
  assert.equal(toWorkflowValue({ type: 'cds.Boolean' }, undefined), false);
  assert.equal(toWorkflowValue({ type: 'cds.Boolean' }, true), true);
  assert.equal(toWorkflowValue({ type: 'cds.Integer' }, undefined), 0);
  assert.equal(toWorkflowValue({ type: 'cds.Integer' }, '5'), 5);
});

test('toWorkflowShape lists every scalar field, blanked out when the row is missing one or absent entirely', () => {
  const entity = {
    elements: {
      BusinessPartner: { key: true, type: 'cds.String' },
      POBox: { type: 'cds.String' },
      POBoxIsWithoutNumber: { type: 'cds.Boolean' },
      CityName: { type: 'cds.String' },
      to_AddressUsage: { type: 'cds.Association', target: 'API_BUSINESS_PARTNER.A_BuPaAddressUsage' }
    }
  };

  const mapped = toWorkflowShape(entity, {
    BusinessPartner: '1000001', POBox: '123', POBoxIsWithoutNumber: false, CityName: 'Gent'
  });
  assert.equal(mapped.businessPartner, '1000001');
  assert.equal(mapped.pOBox, '123');
  assert.equal(mapped.pOBoxIsWithoutNumber, false);
  assert.equal(mapped.cityName, 'Gent');
  assert.equal('to_AddressUsage' in mapped, false);

  const blank = toWorkflowShape(entity, null);
  assert.equal(blank.businessPartner, '');
  assert.equal(blank.pOBoxIsWithoutNumber, false);
});

test('toWorkflowShape omits unset date/time fields instead of sending "" (SAP_IPA_12094)', () => {
  const entity = {
    elements: {
      BusinessPartner: { key: true, type: 'cds.String' },
      ValidityStartDate: { type: 'cds.DateTime' },
      ValidFrom: { type: 'cds.Date' },
      PickupTime: { type: 'cds.Time' }
    }
  };

  // BPA rejects "" as an invalid date/time — so unset date/time fields must
  // not appear in the payload at all, unlike every other field type.
  const blank = toWorkflowShape(entity, null);
  assert.equal(blank.businessPartner, '');
  assert.equal('validityStartDate' in blank, false);
  assert.equal('validFrom' in blank, false);
  assert.equal('pickupTime' in blank, false);

  const populated = toWorkflowShape(entity, {
    BusinessPartner: '1000001', ValidityStartDate: '2024-01-15', ValidFrom: '2024-01-15', PickupTime: '08:00:00'
  });
  assert.equal(populated.validityStartDate, new Date('2024-01-15').toISOString());
  assert.equal(populated.validFrom, new Date('2024-01-15').toISOString());
  // cds.Time isn't converted to a full datetime — it's passed through as-is.
  assert.equal(populated.pickupTime, '08:00:00');
});

test('toWorkflowShape omits ABAP-initial date/time sentinels (SAP_IPA_12094)', () => {
  const entity = {
    elements: {
      BusinessPartner: { key: true, type: 'cds.String' },
      ValidFrom: { type: 'cds.Date' },
      PickupTime: { type: 'cds.Time' },
      ValidityEndDate: { type: 'cds.DateTime' }
    }
  };

  // @sap/cds's odata-v2 remote client turns ABAP's initial date (00000000)
  // into "0001-01-01" and its initial time (000000) into "00:00:00" — both
  // look like real values but BPA rejects them just like a blank string, so
  // they must be dropped from the payload the same way.
  const shaped = toWorkflowShape(entity, {
    BusinessPartner: '1000001', ValidFrom: '0001-01-01', PickupTime: '00:00:00', ValidityEndDate: '0001-01-01T00:00:00Z'
  });
  assert.equal(shaped.businessPartner, '1000001');
  assert.equal('validFrom' in shaped, false);
  assert.equal('pickupTime' in shaped, false);
  assert.equal('validityEndDate' in shaped, false);

  // A real "high date" (9999-12-31, SAP's "no end date" convention) is not
  // an initial value and must still come through.
  const highDate = toWorkflowShape(entity, { ValidityEndDate: '9999-12-31T23:59:59Z' });
  assert.equal(highDate.validityEndDate, new Date('9999-12-31T23:59:59Z').toISOString());
});

test('toWorkflowShape drops audit-trail fields unconditionally, even with a real value (SAP_IPA_12094)', () => {
  const entity = {
    elements: {
      BusinessPartner: { key: true, type: 'cds.String' },
      CreationDate: { type: 'cds.Date' },
      CreationTime: { type: 'cds.Time' },
      CreatedByUser: { type: 'cds.String' },
      LastChangeDate: { type: 'cds.Date' },
      LastChangeTime: { type: 'cds.Time' },
      LastChangedByUser: { type: 'cds.String' }
    }
  };

  // BPA rejects creationDate/creationTime as "not a valid date"/"not a valid
  // time" even for a genuinely valid, current value — not just ABAP-initial
  // ones — so audit fields are excluded unconditionally, regardless of value.
  const shaped = toWorkflowShape(entity, {
    BusinessPartner: '1000001',
    CreationDate: '2026-08-06',
    CreationTime: '13:07:00',
    CreatedByUser: 'JDOE',
    LastChangeDate: '2026-08-06',
    LastChangeTime: '13:08:00',
    LastChangedByUser: 'JDOE'
  });
  assert.equal(shaped.businessPartner, '1000001');
  for (const field of WORKFLOW_AUDIT_FIELDS) {
    assert.equal(lowerFirst(field) in shaped, false, `${field} should have been dropped`);
  }
});

test('toWorkflowShape drops per-entity excluded fields but keeps the identical value elsewhere (SAP_IPA_12094)', () => {
  // Confirmed against BPA: the exact same ISO datetime string is accepted
  // for A_BusinessPartnerAddress.validityStartDate but rejected for
  // A_BuPaAddressUsage.validityStartDate — proving it's not a formatting
  // bug, but that specific field being typed differently in BPA's schema.
  const entity = {
    elements: {
      BusinessPartner: { key: true, type: 'cds.String' },
      ValidityStartDate: { type: 'cds.DateTime' },
      ValidityEndDate: { type: 'cds.DateTime' }
    }
  };
  const row = { BusinessPartner: '515', ValidityStartDate: '2026-08-06T00:00:00.000Z', ValidityEndDate: '9999-12-31T23:59:59.000Z' };

  const excluded = toWorkflowShape(entity, row, 'A_BuPaAddressUsage');
  assert.equal('validityStartDate' in excluded, false);
  assert.equal('validityEndDate' in excluded, false);

  const notExcluded = toWorkflowShape(entity, row, 'A_BusinessPartnerAddress');
  assert.equal(notExcluded.validityStartDate, '2026-08-06T00:00:00.000Z');
  assert.equal(notExcluded.validityEndDate, '9999-12-31T23:59:59.000Z');

  assert.ok(WORKFLOW_FIELD_EXCLUSIONS.A_BuPaAddressUsage.has('ValidityStartDate'));
  assert.ok(WORKFLOW_FIELD_EXCLUSIONS.A_BuPaAddressUsage.has('ValidityEndDate'));
});

test('toWorkflowShape drops A_BusinessPartnerRole.validFrom/validTo (SAP_IPA_12094)', () => {
  const entity = {
    elements: {
      BusinessPartner: { key: true, type: 'cds.String' },
      BusinessPartnerRole: { key: true, type: 'cds.String' },
      ValidFrom: { type: 'cds.DateTime' },
      ValidTo: { type: 'cds.DateTime' }
    }
  };
  const shaped = toWorkflowShape(entity, {
    BusinessPartner: '516', BusinessPartnerRole: 'FLVN00',
    ValidFrom: '2026-08-06T00:00:00.000Z', ValidTo: '9999-12-31T23:59:59.000Z'
  }, 'A_BusinessPartnerRole');
  assert.equal(shaped.businessPartnerRole, 'FLVN00');
  assert.equal('validFrom' in shaped, false);
  assert.equal('validTo' in shaped, false);
  assert.ok(WORKFLOW_FIELD_EXCLUSIONS.A_BusinessPartnerRole.has('ValidFrom'));
  assert.ok(WORKFLOW_FIELD_EXCLUSIONS.A_BusinessPartnerRole.has('ValidTo'));
});

test('every entity the approval workflow needs has a valid filter strategy', () => {
  const validFilters = new Set(['businessPartner', 'businessPartner1', 'businessPartnerCompany', 'customer', 'supplier', 'address']);
  assert.ok(WORKFLOW_ENTITIES.length > 0);
  for (const config of WORKFLOW_ENTITIES) {
    assert.ok(['one', 'many'].includes(config.cardinality), `${config.name} has an invalid cardinality`);
    assert.ok(validFilters.has(config.filterBy), `${config.name} has an invalid filterBy`);
  }
});

test('buildWorkflowInputFromRows shapes given rows and blanks every other entity', () => {
  const s4 = {
    entities: {
      A_BusinessPartner: {
        elements: {
          BusinessPartner: { type: 'cds.String' },
          OrganizationBPName1: { type: 'cds.String' }
        }
      },
      A_BusinessPartnerAddress: {
        elements: {
          BusinessPartner: { type: 'cds.String' },
          AddressID: { type: 'cds.String' }
        }
      }
    }
  };

  const result = buildWorkflowInputFromRows(s4, {
    A_BusinessPartner: { BusinessPartner: '561', OrganizationBPName1: 'Test 0608' },
    A_BusinessPartnerAddress: [{ BusinessPartner: '561', AddressID: '1' }]
  });

  // Given data comes through shaped exactly like a live S/4 read would.
  assert.equal(result.A_BusinessPartner.businessPartner, '561');
  assert.equal(result.A_BusinessPartner.organizationBPName1, 'Test 0608');
  assert.equal(result.A_BusinessPartnerAddress.length, 1);
  assert.equal(result.A_BusinessPartnerAddress[0].addressID, '1');

  // Every entity this app never stages/supplies rows for still comes back
  // with the right shape for its cardinality, never missing or undefined.
  assert.deepEqual(result.A_Customer, {});
  assert.deepEqual(result.A_BusinessPartnerRole, []);
  assert.equal(Object.keys(result).length, WORKFLOW_INPUT_ENTITIES.length);
  for (const config of WORKFLOW_INPUT_ENTITIES) {
    assert.ok(config.name in result, `${config.name} missing from businesspartnerinput`);
    assert.equal(Array.isArray(result[config.name]), config.cardinality === 'many');
  }
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
