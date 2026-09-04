'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');

const BusinessPartnerService = require('../srv/business-partner-service');
const {
  MAINTENANCE_ENTITIES,
  SEARCHABLE_FIELDS,
  searchableFieldsFor,
  answerBusinessPartnerQuestion,
  assistantAddressFilter,
  assistantSearchFilter,
  readAllPages,
  readAssistantAddresses,
  addDefaultAddressUsage,
  businessPartnerCreationSuggestion,
  registryEnrichment,
  extractVatNumber,
  directVatLookup,
  vatNumberFromWebSearch,
  detectRequestedRoles,
  externalResearchAnswer,
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
  UPDATE_FIELDS,
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
  // Anchored on the ref, or /BusinessPartner/ passes by matching BusinessPartnerFullName.
  for (const field of searchableFieldsFor('Acme')) {
    assert.match(serialized, new RegExp(`\["${field}"\]`));
  }
  assert.equal(/\["BusinessPartner"\]/u.test(serialized), false, 'the key is not searched by name');
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
  assert.match(request.path, /substringof\('O''Hara',BusinessPartnerFullName\)/);
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

// updateBusinessPartner is the direct write behind "Mark for Deletion" on the search page (no
// staging - marking an existing partner is not a create). false must survive pickDefined, since
// un-marking sends exactly that.
test('updateBusinessPartner accepts the central deletion flag, in both directions', () => {
  assert.ok(UPDATE_FIELDS.includes('IsMarkedForArchiving'));
  assert.deepEqual(
    pickDefined({ IsMarkedForArchiving: true }, UPDATE_FIELDS),
    { IsMarkedForArchiving: true }
  );
  assert.deepEqual(
    pickDefined({ IsMarkedForArchiving: false }, UPDATE_FIELDS),
    { IsMarkedForArchiving: false }
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
    Industries: 'to_BuPaIndustry',
    // Deliberately allowed to create directly via to_Customer/to_Supplier rather than
    // requiring the corresponding role first - a real S/4 system may still reject the
    // POST if CVI expects the role to exist, but that is a backend validation error for
    // the user to see, not something this app should block ahead of time.
    Customers: 'to_Customer',
    Suppliers: 'to_Supplier'
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

  assert.equal(MAINTENANCE_ENTITIES.Customers.updatable, true);
  assert.equal(MAINTENANCE_ENTITIES.Suppliers.updatable, true);
  assert.equal(MAINTENANCE_ENTITIES.Addresses.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.TaxNumbers.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.BankDetails.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.Identifications.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.Industries.deletable, true);
  assert.equal(MAINTENANCE_ENTITIES.BusinessPartnerRoles.deletable, true);
});

/**
 * Reported directly, with a screenshot: four duplicate "enter required field(s) PartnerCounter"
 * errors on the mandatory-function rows the derivation itself creates (srv/checks/derivation-checks.js,
 * "All of the mandatory functions" in CLAUDE.md). PartnerCounter is deliberately never proposed there -
 * S/4 assigns it at post time, a create has no number for S/4 to default the function to yet - but
 * requiredCreateFields still demanded it, a pre-existing inconsistency (added 2026-08-19, before that
 * derivation decision) that only surfaced once Check itself started enforcing requiredCreateFields
 * (srv/checks/node-required.js, 2026-08-28).
 */
test('PartnerCounter is never required on either partner-function node - S/4 assigns it, not the requester', () => {
  assert.equal(MAINTENANCE_ENTITIES.CustomerSalesPartnerFunctions.requiredCreateFields.includes('PartnerCounter'), false);
  assert.equal(MAINTENANCE_ENTITIES.SupplierPartnerFunctions.requiredCreateFields.includes('PartnerCounter'), false);
  // PartnerFunction itself stays required - only the S/4-assigned counter was ever wrong to demand.
  assert.ok(MAINTENANCE_ENTITIES.CustomerSalesPartnerFunctions.requiredCreateFields.includes('PartnerFunction'));
  assert.ok(MAINTENANCE_ENTITIES.SupplierPartnerFunctions.requiredCreateFields.includes('PartnerFunction'));
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
    root: {
      BusinessPartnerCategory: '2',
      OrganizationBPName1: 'Coca-Cola',
      SearchTerm1: 'Coca Cola'
    },
    sections: {}
  });
  assert.equal(
    JSON.parse(businessPartnerCreationSuggestion(
      'Geef info over het bedrijf Coca-Cola',
      partners,
      { title: 'The Coca-Cola Company', source: 'Wikipedia' }
    ).SuggestedData).root.OrganizationBPName1,
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
  assert.equal(publicSuggestion.root.OrganizationBPName1, 'SPAR Destelbergen');
  assert.equal(publicSuggestion.sections.Addresses[0].StreetName, 'Dendermondsesteenweg');
});

/**
 * registryEnrichment is the assistant's own use of the same GLEIF/VIES tools duplicate-check
 * enrichment already relies on (srv/ai/registry.js). It is deliberately narrow: GLEIF finds a company
 * by name, but its enterprise number is not proof of VAT registration and its registration-authority
 * id is not an SAP BPTaxType - so a tax number is only ever proposed once VIES has confirmed it, and
 * only for Belgium, the one country/number relationship this app already trusts elsewhere.
 */
test('registryEnrichment proposes a VIES-confirmed Belgian VAT number, and only then', async () => {
  const gleifEntity = {
    legalName: 'Spar Destelbergen NV',
    registeredAs: '0123456789',
    address: { StreetName: 'Dendermondsesteenweg', HouseNumber: '468', PostalCode: '9070', CityName: 'Destelbergen', Country: 'BE' }
  };
  const lookup = async () => ({
    record: { additionalNames: ['Spar Destelbergen NV'], addresses: [gleifEntity.address] },
    facts: { gleif: [gleifEntity] }
  });
  const checkVat = async (country, vatNumber) => {
    assert.equal(country, 'BE');
    assert.equal(vatNumber, '0123456789');
    return { status: 'valid', name: 'SPAR DESTELBERGEN', address: gleifEntity.address, vatNumber, countryCode: 'BE' };
  };
  const result = await registryEnrichment('Spar Destelbergen', { lookup, checkVat });
  assert.equal(result.source, 'VIES');
  assert.equal(result.name, 'SPAR DESTELBERGEN');
  assert.deepEqual(result.taxNumber, { BPTaxType: 'BE0', BPTaxNumber: 'BE0123456789' });
});

test('registryEnrichment falls back to the GLEIF name/address alone when VIES does not confirm it', async () => {
  const gleifEntity = {
    legalName: 'Spar Destelbergen NV',
    registeredAs: '0123456789',
    address: { StreetName: 'Dendermondsesteenweg', HouseNumber: '468', PostalCode: '9070', CityName: 'Destelbergen', Country: 'BE' }
  };
  const lookup = async () => ({
    record: { additionalNames: ['Spar Destelbergen NV'], addresses: [gleifEntity.address] },
    facts: { gleif: [gleifEntity] }
  });
  const checkVat = async () => ({ status: 'invalid' });
  const result = await registryEnrichment('Spar Destelbergen', { lookup, checkVat });
  assert.equal(result.source, 'GLEIF');
  assert.equal(result.name, 'Spar Destelbergen NV');
  assert.equal(result.taxNumber, null);
});

test('registryEnrichment never chains VIES for a non-Belgian GLEIF match', async () => {
  const gleifEntity = {
    legalName: 'Voorbeeld GmbH',
    registeredAs: 'HRB123456',
    address: { StreetName: 'Teststrasse', HouseNumber: '1', PostalCode: '10115', CityName: 'Berlin', Country: 'DE' }
  };
  const lookup = async () => ({
    record: { additionalNames: ['Voorbeeld GmbH'], addresses: [gleifEntity.address] },
    facts: { gleif: [gleifEntity] }
  });
  const checkVat = async () => { throw new Error('VIES must not be called for a non-Belgian match'); };
  const result = await registryEnrichment('Voorbeeld', { lookup, checkVat });
  assert.equal(result.source, 'GLEIF');
  assert.equal(result.taxNumber, null);
});

test('registryEnrichment is best-effort: a lookup failure resolves to null, never throws', async () => {
  const lookup = async () => { throw new Error('GLEIF unavailable'); };
  assert.equal(await registryEnrichment('Anything', { lookup }), null);
});

/**
 * A requester typing a VAT number directly in the chat ("BP ING aanmaken met VIes nummer
 * BE0403.200.393") is a stronger signal than a name search - extractVatNumber finds it in free text,
 * and directVatLookup answers it via VIES directly rather than only reaching VIES indirectly through
 * a GLEIF name match.
 */
test('extractVatNumber finds a VAT number in free-form Dutch prose, dots and all', () => {
  assert.deepEqual(
    extractVatNumber('Ik zou graag een nieuwe BP ING aanmaken met volgende VIes nummer BE0403.200.393'),
    { country: 'BE', vatNumber: 'BE0403200393' }
  );
  assert.deepEqual(extractVatNumber('VAT: BE 0403 200 393 graag'), { country: 'BE', vatNumber: 'BE0403200393' });
  assert.deepEqual(extractVatNumber('vat number FR12345678901'), { country: 'FR', vatNumber: 'FR12345678901' });
  assert.equal(extractVatNumber('Does Alluvion already exist in our system?'), null);
  assert.equal(extractVatNumber(''), null);
  assert.equal(extractVatNumber(null), null);
  // XX is not a country VIES recognises, so it is left alone rather than misread as a VAT number.
  assert.equal(extractVatNumber('order XX1234567 was shipped'), null);
});

test('directVatLookup confirms a valid Belgian VAT number and proposes it as a tax number', async () => {
  const checkVat = async (country, vatNumber) => {
    assert.equal(country, 'BE');
    assert.equal(vatNumber, 'BE0403200393');
    return {
      status: 'valid', name: 'ING BELGIUM NV', countryCode: 'BE', vatNumber: '0403200393',
      address: { StreetName: 'Sint-Michielswarande', HouseNumber: '60', PostalCode: '1040', CityName: 'Brussel', Country: 'BE' }
    };
  };
  const result = await directVatLookup('BP ING aanmaken met VIes nummer BE0403.200.393', checkVat);
  assert.equal(result.status, 'valid');
  assert.equal(result.name, 'ING BELGIUM NV');
  assert.deepEqual(result.taxNumber, { BPTaxType: 'BE0', BPTaxNumber: 'BE0403200393' });
});

test('directVatLookup still answers when VIES does not confirm the number', async () => {
  const invalid = await directVatLookup(
    'BE0403.200.393',
    async () => ({ status: 'invalid', countryCode: 'BE', vatNumber: '0403200393' })
  );
  assert.deepEqual(invalid, { status: 'invalid', countryCode: 'BE', vatNumber: '0403200393', reason: undefined });

  const unknown = await directVatLookup(
    'BE0403.200.393',
    async () => ({ status: 'unknown', countryCode: 'BE', vatNumber: '0403200393', reason: 'timeout' })
  );
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reason, 'timeout');
});

/**
 * vatNumberFromWebSearch is registryEnrichment's name-only counterpart when GLEIF has no record for
 * the company at all: the same VIES call, reached through a public web search for the number itself
 * rather than through a GLEIF hit's registeredAs. Unverified candidates only ever become an answer
 * once VIES confirms one - a candidate search noise turns up that VIES does not confirm is dropped
 * silently, never reported as "not registered" the way a number the requester actually typed is.
 */
test('vatNumberFromWebSearch confirms the first web-found candidate VIES validates', async () => {
  const search = async (name) => {
    assert.equal(name, 'Alluvion');
    return [{ country: 'BE', number: '0403200393' }];
  };
  const checkVat = async (country, vatNumber) => {
    assert.equal(country, 'BE');
    assert.equal(vatNumber, 'BE0403200393');
    return { status: 'valid', name: 'ALLUVION', countryCode: 'BE', vatNumber: '0403200393', address: { CityName: 'Gent', Country: 'BE' } };
  };
  const result = await vatNumberFromWebSearch('Alluvion', { search, checkVat });
  assert.equal(result.status, 'valid');
  assert.equal(result.name, 'ALLUVION');
  assert.deepEqual(result.taxNumber, { BPTaxType: 'BE0', BPTaxNumber: 'BE0403200393' });
});

test('vatNumberFromWebSearch tries the next candidate once the first is not confirmed, and stops at the cap', async () => {
  const attempted = [];
  const search = async () => [
    { country: 'BE', number: '1111111111' },
    { country: 'FR', number: '22222222222' },
    { country: 'DE', number: '333333333' },
    { country: 'NL', number: '444444444B01' }
  ];
  const checkVat = async (country, vatNumber) => {
    attempted.push(vatNumber);
    return { status: 'invalid' };
  };
  const result = await vatNumberFromWebSearch('Nobody NV', { search, checkVat });
  assert.equal(result, null);
  // Capped at MAX_WEB_VAT_CANDIDATES (3): the fourth candidate is never even tried.
  assert.equal(attempted.length, 3);
});

test('vatNumberFromWebSearch never calls VIES for a code VIES does not serve, and is best-effort', async () => {
  const checkVat = async () => { throw new Error('VIES must not be called for an unrecognised code'); };
  const result = await vatNumberFromWebSearch(
    'Nobody NV', { search: async () => [{ country: 'ZZ', number: '123456789' }], checkVat }
  );
  assert.equal(result, null);

  const failing = await vatNumberFromWebSearch(
    'Nobody NV', { search: async () => { throw new Error('web search unavailable'); }, checkVat: async () => ({ status: 'valid' }) }
  );
  assert.equal(failing, null);
});

/**
 * Asking the assistant to create a supplier/customer used to propose only General/Addresses/
 * TaxNumbers - no BusinessPartnerRoles row, so the existing cvi_account_group derivation (which keys
 * off the role) never had anything to fire on and the Customers/Suppliers section stayed empty too.
 */
test('detectRequestedRoles reads customer/supplier intent from free text, Dutch and English', () => {
  assert.deepEqual(detectRequestedRoles('Maak een supplier aan voor Alluvion'), ['FLVN01']);
  assert.deepEqual(detectRequestedRoles('please create a customer for Alluvion'), ['FLCU01']);
  assert.deepEqual(detectRequestedRoles('maak een leverancier aan'), ['FLVN01']);
  assert.deepEqual(detectRequestedRoles('maak een klant aan'), ['FLCU01']);
  assert.deepEqual(detectRequestedRoles('create a vendor and a customer for this company').sort(), ['FLCU01', 'FLVN01']);
  assert.deepEqual(detectRequestedRoles('does Alluvion already exist?'), []);
  assert.deepEqual(detectRequestedRoles(''), []);
});

test('businessPartnerCreationSuggestion proposes the matching role, leaving the account-group section for Check to derive', () => {
  // requestedCompanyName has no pattern for "create a BP for X" imperatives - in production that
  // resolution comes from the model-based intent parser (ASSISTANT_INTENT_SOURCE: model) and reaches
  // this function as resolvedCompanyName, exactly as passed here.
  const supplier = JSON.parse(businessPartnerCreationSuggestion(
    'Maak een supplier aan voor Alluvion', [], null, 'Alluvion'
  ).SuggestedData);
  assert.deepEqual(supplier.sections.BusinessPartnerRoles, [{ BusinessPartnerRole: 'FLVN01' }]);
  assert.equal(supplier.sections.Suppliers, undefined);

  const customer = JSON.parse(businessPartnerCreationSuggestion(
    'please create a customer for Alluvion', [], null, 'Alluvion'
  ).SuggestedData);
  assert.deepEqual(customer.sections.BusinessPartnerRoles, [{ BusinessPartnerRole: 'FLCU01' }]);

  const neither = JSON.parse(businessPartnerCreationSuggestion('Does Alluvion already exist in our system?', []).SuggestedData);
  assert.equal(neither.sections.BusinessPartnerRoles, undefined);
});

test('businessPartnerCreationSuggestion names the proposal from the registry when no company name was typed', () => {
  const suggestion = JSON.parse(businessPartnerCreationSuggestion(
    'BE0403.200.393',
    [],
    null,
    '',
    { name: 'ING BELGIUM NV', address: { CityName: 'Brussel', Country: 'BE' }, taxNumber: { BPTaxType: 'BE0', BPTaxNumber: 'BE0403200393' }, source: 'VIES' }
  ).SuggestedData);
  assert.equal(suggestion.root.OrganizationBPName1, 'ING BELGIUM NV');
  assert.deepEqual(suggestion.sections.TaxNumbers, [{ BPTaxType: 'BE0', BPTaxNumber: 'BE0403200393' }]);
});

test('externalResearchAnswer reports what VIES said about a directly-typed VAT number that was not confirmed', () => {
  const invalid = externalResearchAnswer('ING', null, null, { status: 'invalid', countryCode: 'BE', vatNumber: '0403200393' });
  assert.match(invalid, /VIES says VAT number BE0403200393 is not registered\./u);

  const unknown = externalResearchAnswer('ING', null, null, { status: 'unknown', countryCode: 'BE', vatNumber: '0403200393', reason: 'timeout' });
  assert.match(unknown, /VIES could not confirm VAT number BE0403200393 right now \(timeout\)\./u);

  const notApplicable = externalResearchAnswer('ING', null, null, { status: 'not_applicable', countryCode: 'US', vatNumber: '123456789' });
  assert.match(notApplicable, /VIES does not cover US/u);

  // A VALID verdict is folded into `registry` and reported via registryAnswerLine instead - passing
  // it here must not double it up.
  const valid = externalResearchAnswer('ING', null, null, { status: 'valid', countryCode: 'BE', vatNumber: 'BE0403200393' });
  assert.doesNotMatch(valid, /VIES/u);
});

test('externalResearchAnswer surfaces the registry line whatever the research outcome', () => {
  const confirmed = { name: 'SPAR DESTELBERGEN', taxNumber: { BPTaxType: 'BE0', BPTaxNumber: 'BE0123456789' } };
  const unconfirmed = { name: 'Voorbeeld NV', address: { CityName: 'Brussel' }, taxNumber: null };

  assert.match(
    externalResearchAnswer('Spar Destelbergen', null, confirmed),
    /VIES confirms SPAR DESTELBERGEN — VAT number BE0123456789\./u
  );
  assert.match(
    externalResearchAnswer('Voorbeeld', null, unconfirmed),
    /GLEIF lists Voorbeeld NV in Brussel \(not confirmed via VIES\)\./u
  );
  assert.doesNotMatch(externalResearchAnswer('Nobody', null, null), /VIES|GLEIF/u);
  assert.match(
    externalResearchAnswer('Spar Destelbergen', { source: 'Wikipedia', title: 'Spar', extract: 'A retailer.', url: 'https://x' }, confirmed),
    /VIES confirms SPAR DESTELBERGEN/u
  );
});

/**
 * A country only ever proposes CorrespondenceLanguage where the business language is unambiguous -
 * BE and LU stay silent on the field (Dutch/French, and French/German/Luxembourgish respectively),
 * because a wrong guess is worse than an empty one the requester fills in themselves.
 */
test('the language proposal only fires for a country with one dominant business language', () => {
  const partners = [];
  const forCountry = (country) => JSON.parse(businessPartnerCreationSuggestion(
    'Geef info over het bedrijf Voorbeeld',
    partners,
    { source: 'Public web search', suggestedAddress: { Country: country } }
  ).SuggestedData).root.CorrespondenceLanguage;

  assert.equal(forCountry('NL'), 'NL');
  assert.equal(forCountry('DE'), 'DE');
  assert.equal(forCountry('FR'), 'FR');
  assert.equal(forCountry('GB'), 'EN');
  assert.equal(forCountry('BE'), undefined);
  assert.equal(forCountry('LU'), undefined);
  assert.equal(forCountry(''), undefined);
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
  assert.equal(confirmedSuggestion.root.OrganizationBPName1, 'Spar Destelbergen');
  assert.equal(confirmedSuggestion.sections.Addresses[0].CityName, 'Destelbergen');
  assert.equal(contextualCompanyName('SPAR destelbergen', history), 'SPAR destelbergen');
  assert.throws(
    () => parseConversationHistory('{broken'),
    /ConversationJson must contain valid JSON/
  );
});

// Reported 2026-09-04: the search name given to the web search, VIES and every proposed field was
// "always our search query in the prompt" - the pattern parser's bareWords fallback treated any
// short imperative with no generic stop word ("maak", "bp", "create" are not one) as if it were the
// bare company name and echoed the whole sentence back. Creation imperatives are the model-based
// intent parser's job in production (ASSISTANT_INTENT_SOURCE: model) - the pattern parser only has
// to stop guessing wrong when the model is unavailable, which is what these pin.
test('a creation imperative is never echoed back whole as the company name', () => {
  assert.equal(contextualCompanyName('maak BP Alluvion', []), '');
  assert.equal(contextualCompanyName('maak BP Alluvion aan', []), '');
  assert.equal(contextualCompanyName('create BP Acme', []), '');
  assert.equal(contextualCompanyName('creëer BP Acme', []), '');
  // A bare name with no command word is still resolved, unaffected by the fix.
  assert.equal(contextualCompanyName('Alluvion', []), 'Alluvion');
  assert.equal(contextualCompanyName('Acme Corp', []), 'Acme Corp');
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

test('the assistant filter drops the key for a word and keeps it for a number', () => {
  const words = JSON.stringify(assistantSearchFilter(['alluvion', 'destelbergen']));
  assert.equal(/\["BusinessPartner"\]/u.test(words), false);
  assert.match(words, /alluvion/u);
  assert.match(words, /destelbergen/u);
  assert.match(JSON.stringify(assistantSearchFilter(['4711'])), /\["BusinessPartner"\]/u);
});
