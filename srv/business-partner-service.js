'use strict';

const cds = require('@sap/cds');
const { askSapAiCore } = require('./ai/business-partner-assistant');
const { parseIntent, useModelIntent } = require('./ai/intent');
const { aiAssistanceEnabled } = require('./ai/availability');
const { researchCompany } = require('./ai/company-research');
const { startWorkflow } = require("./wf/processAutomation");
const { createCache } = require('./ai/cache');
const {
  VERDICT_LABELS, activeRules, refreshRules, stagedEntries, checkAgainstPartners,
  duplicateFindings, testRuleset
} = require('./ai/duplicate-check');
const { usableRules } = require('./ai/rule-config');
const { createNameIndex } = require('./ai/name-index');
const { createCapReaders, createMcpPartnerReader } = require('./ai/partner-readers');
const { createMcpToolCaller } = require('./ai/mcp-client');
const { checkMetadataDrift } = require('./metadata-drift');
const {
  IN_PROGRESS_REQUEST_STATUSES, PARTNER_FIELDS, pendingCreateEntry, partnerEntry,
  matchesWhere, matchesTerms, pageSplit, byRequestedAtDesc, remoteOrderBy
} = require('./search-results');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const assistantCache = createCache();
const nameIndex = createNameIndex();
let indexReader = null;

const SEARCHABLE_FIELDS = Object.freeze([
  'BusinessPartner',
  'BusinessPartnerFullName',
  'BusinessPartnerName',
  'SearchTerm1',
  'SearchTerm2',
  'FirstName',
  'LastName',
  'OrganizationBPName1'
]);

// S/4's ALPHA conversion exit rejects the whole read (/IWBEP/CM_MGW_RT/264) for a non-numeric key,
// so only a digit term fitting CHAR(10) goes against it. A name still matches the name fields.
const BP_NUMBER_TERM = /^\d{1,10}$/u;

function searchableFieldsFor(term) {
  if (BP_NUMBER_TERM.test(term)) return SEARCHABLE_FIELDS;
  return SEARCHABLE_FIELDS.filter((field) => field !== 'BusinessPartner');
}

/** One term against every field it is safe to send. */
function termExpression(term) {
  return {
    xpr: joinExpressions(
      searchableFieldsFor(term).map((field) => ({
        func: 'contains',
        // CAP 8's OData V2 URL serializer does not double embedded quotes.
        // Escape them here so names such as O'Hara remain valid literals.
        args: [{ ref: [field] }, { val: term.replaceAll("'", "''") }]
      })),
      'or'
    )
  };
}

const CREATE_FIELDS = Object.freeze([
  'BusinessPartnerCategory',
  'BusinessPartnerGrouping',
  'FirstName',
  'LastName',
  'OrganizationBPName1',
  'GroupBusinessPartnerName1',
  'SearchTerm1'
]);

const UPDATE_FIELDS = Object.freeze([
  'FirstName',
  'LastName',
  'OrganizationBPName1',
  'OrganizationBPName2',
  'GroupBusinessPartnerName1',
  'GroupBusinessPartnerName2',
  'SearchTerm1',
  'SearchTerm2',
  'CorrespondenceLanguage',
  'BusinessPartnerIsBlocked'
]);

const ASSISTANT_FIELDS = Object.freeze([
  'BusinessPartner',
  'BusinessPartnerFullName',
  'BusinessPartnerName',
  'BusinessPartnerCategory',
  'BusinessPartnerGrouping',
  'SearchTerm1',
  'SearchTerm2',
  'FirstName',
  'LastName',
  'OrganizationBPName1',
  'BusinessPartnerIsBlocked'
]);

const ASSISTANT_ADDRESS_FIELDS = Object.freeze([
  'BusinessPartner',
  'AddressID',
  'StreetName',
  'HouseNumber',
  'PostalCode',
  'CityName',
  'Region',
  'Country',
  'POBox'
]);

// The assistant reads every matching row by paging; these only size the pages.
const ASSISTANT_PAGE_SIZE = 1000;
const ASSISTANT_ADDRESS_CHUNK = 50;
const ASSISTANT_MAX_ROWS = 100000;

const { STOP_WORDS: ASSISTANT_STOP_WORDS } = require('./ai/stop-words');
const { CVI_REMOTE_SETS } = require('./cvi-config-service');

// Read from ZSRVB_MDMLIGHT_VH rather than forwarded to S/4. One place, so the CDS, the READ handler
// loop and the UI's VALUE_HELP_FIELDS stay in sync when a lookup is added.
const VALUE_HELP_ENTITIES = Object.freeze([
  'BusinessPartnerGroupings',
  'BusinessPartnerCategories',
  'LegalForms',
  'FormsOfAddress',
  'AcademicTitles',
  'Genders',
  'IndustryCodes',
  'Languages',
  'Countries',
  'Regions',
  'IndustrySectors',
  'IndustrySystems',
  'AddressDependentTaxTypes',
  'TaxTypes',
  'IdentificationTypes',
  'CustomerAccountGroups',
  'CustomerClassifications',
  'SupplierAccountGroups',
  'BusinessPartnerRoleCodes'
]);

const MAINTENANCE_ENTITIES = Object.freeze({
  Addresses: Object.freeze({
    remote: 'A_BusinessPartnerAddress',
    navigation: 'to_BusinessPartnerAddress',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['BusinessPartner', 'Country']
  }),
  BusinessPartnerRoles: Object.freeze({
    remote: 'A_BusinessPartnerRole',
    navigation: 'to_BusinessPartnerRole',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['BusinessPartner', 'BusinessPartnerRole']
  }),
  TaxNumbers: Object.freeze({
    remote: 'A_BusinessPartnerTaxNumber',
    navigation: 'to_BusinessPartnerTax',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['BusinessPartner', 'BPTaxType'],
    oneOfCreateFields: ['BPTaxNumber', 'BPTaxLongNumber']
  }),
  BankDetails: Object.freeze({
    remote: 'A_BusinessPartnerBank',
    navigation: 'to_BusinessPartnerBank',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['BusinessPartner', 'BankIdentification'],
    oneOfCreateFields: ['IBAN', 'BankAccount'],
    excludedCreateFields: ['BankName', 'SWIFTCode', 'CityName'],
    excludedUpdateFields: ['BankName', 'SWIFTCode', 'CityName']
  }),
  Identifications: Object.freeze({
    remote: 'A_BuPaIdentification',
    navigation: 'to_BuPaIdentification',
    creatable: true,
    deletable: true,
    requiredCreateFields: [
      'BusinessPartner', 'BPIdentificationType', 'BPIdentificationNumber'
    ]
  }),
  Industries: Object.freeze({
    remote: 'A_BuPaIndustry',
    navigation: 'to_BuPaIndustry',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['BusinessPartner', 'IndustrySector', 'IndustrySystemType'],
    excludedCreateFields: ['IndustryKeyDescription'],
    excludedUpdateFields: ['IndustryKeyDescription']
  }),
  Customers: Object.freeze({
    remote: 'A_Customer',
    navigation: 'to_Customer',
    creatable: true,
    deletable: false,
    updatable: true,
    requiredCreateFields: ['CustomerAccountGroup']
  }),
  Suppliers: Object.freeze({
    remote: 'A_Supplier',
    navigation: 'to_Supplier',
    creatable: true,
    deletable: false,
    updatable: true,
    requiredCreateFields: ['SupplierAccountGroup']
  }),
  // A_BusinessPartner has no navigation to company code data, so a create posts under
  // A_Customer/A_Supplier instead - see parentEntity in businessPartnerNavigationPath.
  CustomerCompany: Object.freeze({
    remote: 'A_CustomerCompany',
    navigation: 'to_CustomerCompany',
    parentEntity: 'A_Customer',
    parentKeyField: 'Customer',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'CompanyCode']
  }),
  SupplierCompany: Object.freeze({
    remote: 'A_SupplierCompany',
    navigation: 'to_SupplierCompany',
    parentEntity: 'A_Supplier',
    parentKeyField: 'Supplier',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Supplier', 'CompanyCode']
  }),
  CustomerSalesArea: Object.freeze({
    remote: 'A_CustomerSalesArea',
    navigation: 'to_CustomerSalesArea',
    parentEntity: 'A_Customer',
    parentKeyField: 'Customer',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'SalesOrganization', 'DistributionChannel', 'Division']
  }),
  CustomerTaxGrouping: Object.freeze({
    remote: 'A_CustomerTaxGrouping',
    navigation: 'to_CustomerTaxGrouping',
    parentEntity: 'A_Customer',
    parentKeyField: 'Customer',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'CustomerTaxGroupingCode']
  }),
  SupplierPurchasingOrg: Object.freeze({
    remote: 'A_SupplierPurchasingOrg',
    navigation: 'to_SupplierPurchasingOrg',
    parentEntity: 'A_Supplier',
    parentKeyField: 'Supplier',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Supplier', 'PurchasingOrganization']
  }),
  // --- The rest of the MDG ERP Customer / Supplier tree -------------------------
  // All grandchildren, several off a COMPOSITE-keyed parent, addressed via parentKeyFields.
  CustomerText: Object.freeze({
    remote: 'A_CustomerText',
    navigation: 'to_CustomerText',
    parentEntity: 'A_Customer',
    parentKeyField: 'Customer',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'Language', 'LongTextID']
  }),
  CustomerAddressExtIdentifier: Object.freeze({
    remote: 'A_CustAddrDepdntExtIdentifier',
    navigation: 'to_CustAddrDepdntExtIdentifier',
    parentEntity: 'A_Customer',
    parentKeyField: 'Customer',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'AddressID']
  }),
  CustomerAddressInfo: Object.freeze({
    remote: 'A_CustAddrDepdntInformation',
    navigation: 'to_CustAddrDepdntInformation',
    parentEntity: 'A_Customer',
    parentKeyField: 'Customer',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'AddressID']
  }),
  CustomerUnloadingPoint: Object.freeze({
    remote: 'A_CustomerUnloadingPoint',
    navigation: 'to_CustomerUnloadingPoint',
    parentEntity: 'A_Customer',
    parentKeyField: 'Customer',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'UnloadingPointName']
  }),
  CustomerUnloadingPointAddressInfo: Object.freeze({
    remote: 'A_CustUnldgPtAddrDepdntInfo',
    navigation: 'to_CustUnldgPtAddrDepdntInfo',
    parentEntity: 'A_Customer',
    parentKeyField: 'Customer',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'AddressID', 'UnloadingPointName']
  }),
  CustomerCompanyText: Object.freeze({
    remote: 'A_CustomerCompanyText',
    navigation: 'to_CompanyText',
    parentEntity: 'A_CustomerCompany',
    parentKeyFields: ['Customer', 'CompanyCode'],
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'CompanyCode', 'Language', 'LongTextID']
  }),
  CustomerDunning: Object.freeze({
    remote: 'A_CustomerDunning',
    navigation: 'to_CustomerDunning',
    parentEntity: 'A_CustomerCompany',
    parentKeyFields: ['Customer', 'CompanyCode'],
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'CompanyCode', 'DunningArea'],
    excludedCreateFields: ['CustomerAccountGroup'],
    excludedUpdateFields: ['CustomerAccountGroup']
  }),
  CustomerWithholdingTax: Object.freeze({
    remote: 'A_CustomerWithHoldingTax',
    navigation: 'to_WithHoldingTax',
    parentEntity: 'A_CustomerCompany',
    parentKeyFields: ['Customer', 'CompanyCode'],
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Customer', 'CompanyCode', 'WithholdingTaxType']
  }),
  CustomerSalesAreaText: Object.freeze({
    remote: 'A_CustomerSalesAreaText',
    navigation: 'to_SalesAreaText',
    parentEntity: 'A_CustomerSalesArea',
    parentKeyFields: ['Customer', 'SalesOrganization', 'DistributionChannel', 'Division'],
    creatable: true,
    deletable: true,
    requiredCreateFields: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'Language',
      'LongTextID'
    ]
  }),
  CustomerTaxIndicators: Object.freeze({
    remote: 'A_CustomerSalesAreaTax',
    navigation: 'to_SalesAreaTax',
    parentEntity: 'A_CustomerSalesArea',
    parentKeyFields: ['Customer', 'SalesOrganization', 'DistributionChannel', 'Division'],
    creatable: true,
    deletable: true,
    requiredCreateFields: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'DepartureCountry',
      'CustomerTaxCategory'
    ]
  }),
  CustomerSalesPartnerFunctions: Object.freeze({
    remote: 'A_CustSalesPartnerFunc',
    navigation: 'to_PartnerFunction',
    parentEntity: 'A_CustomerSalesArea',
    parentKeyFields: ['Customer', 'SalesOrganization', 'DistributionChannel', 'Division'],
    creatable: true,
    deletable: true,
    requiredCreateFields: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'PartnerFunction',
      'PartnerCounter'
    ],
    excludedCreateFields: ['CustomerPartnerDescription'],
    excludedUpdateFields: ['CustomerPartnerDescription']
  }),
  CustomerSalesAreaAddressInfo: Object.freeze({
    remote: 'A_CustSlsAreaAddrDepdntInfo',
    navigation: 'to_SlsAreaAddrDepdntInfo',
    parentEntity: 'A_CustomerSalesArea',
    parentKeyFields: ['Customer', 'SalesOrganization', 'DistributionChannel', 'Division'],
    creatable: true,
    deletable: true,
    requiredCreateFields: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'AddressID'
    ]
  }),
  SupplierText: Object.freeze({
    remote: 'A_SupplierText',
    navigation: 'to_SupplierText',
    parentEntity: 'A_Supplier',
    parentKeyField: 'Supplier',
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Supplier', 'Language', 'LongTextID']
  }),
  SupplierCompanyText: Object.freeze({
    remote: 'A_SupplierCompanyText',
    navigation: 'to_CompanyText',
    parentEntity: 'A_SupplierCompany',
    parentKeyFields: ['Supplier', 'CompanyCode'],
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Supplier', 'CompanyCode', 'Language', 'LongTextID']
  }),
  SupplierDunning: Object.freeze({
    remote: 'A_SupplierDunning',
    navigation: 'to_SupplierDunning',
    parentEntity: 'A_SupplierCompany',
    parentKeyFields: ['Supplier', 'CompanyCode'],
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Supplier', 'CompanyCode', 'DunningArea'],
    excludedCreateFields: ['SupplierAccountGroup'],
    excludedUpdateFields: ['SupplierAccountGroup']
  }),
  SupplierWithholdingTax: Object.freeze({
    remote: 'A_SupplierWithHoldingTax',
    navigation: 'to_SupplierWithHoldingTax',
    parentEntity: 'A_SupplierCompany',
    parentKeyFields: ['Supplier', 'CompanyCode'],
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Supplier', 'CompanyCode', 'WithholdingTaxType'],
    excludedCreateFields: [
      'BusinessPartner', 'BusinessPartnerFullName', 'HouseNumber', 'StreetName', 'City',
      'Country', 'CountryName', 'PostalCode', 'Region', 'RegionName', 'MatchRuleName',
      'MatchScore'
    ],
    excludedUpdateFields: [
      'BusinessPartner', 'BusinessPartnerFullName', 'HouseNumber', 'StreetName', 'City',
      'Country', 'CountryName', 'PostalCode', 'Region', 'RegionName', 'MatchRuleName',
      'MatchScore'
    ]
  }),
  SupplierPurchasingOrgText: Object.freeze({
    remote: 'A_SupplierPurchasingOrgText',
    navigation: 'to_PurchasingOrgText',
    parentEntity: 'A_SupplierPurchasingOrg',
    parentKeyFields: ['Supplier', 'PurchasingOrganization'],
    creatable: true,
    deletable: true,
    requiredCreateFields: ['Supplier', 'PurchasingOrganization', 'Language', 'LongTextID']
  }),
  SupplierPartnerFunctions: Object.freeze({
    remote: 'A_SupplierPartnerFunc',
    navigation: 'to_PartnerFunction',
    parentEntity: 'A_SupplierPurchasingOrg',
    parentKeyFields: ['Supplier', 'PurchasingOrganization'],
    creatable: true,
    deletable: true,
    requiredCreateFields: [
      'Supplier', 'PurchasingOrganization', 'SupplierSubrange', 'Plant', 'PartnerFunction',
      'PartnerCounter'
    ],
    excludedCreateFields: ['CreationDate', 'CreatedByUser'],
    excludedUpdateFields: ['CreationDate', 'CreatedByUser']
  })
});

/**
 * S/4 derives these and refuses to be told them (`sap:creatable="false"`), so they must not travel on
 * a create either - the update path has excluded them all along, the create path excluded nothing.
 * It cost nothing while nobody could produce a value; the composed full name (srv/partner-name.js)
 * is exactly such a value, and a create rejected by S/4 is a request that fails at the post.
 */
const ROOT_CREATE_EXCLUDED_FIELDS = Object.freeze(new Set([
  'BusinessPartnerFullName',
  'BusinessPartnerName'
]));

const ROOT_UPDATE_EXCLUDED_FIELDS = Object.freeze(new Set([
  'BusinessPartner',
  'BusinessPartnerCategory',
  'BusinessPartnerGrouping',
  'BusinessPartnerFullName',
  'BusinessPartnerName',
  'BusinessPartnerUUID',
  'Customer',
  'Supplier',
  'CreatedByUser',
  'CreationDate',
  'CreationTime',
  'LastChangeDate',
  'LastChangeTime',
  'LastChangedByUser',
  'ETag'
]));

function pickDefined(data, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => data[field] !== undefined && data[field] !== null)
      .map((field) => [field, data[field]])
  );
}

function parseJsonObject(value, name) {
  let parsed;
  try {
    parsed = JSON.parse(value || '{}');
  } catch {
    throw Object.assign(new Error(`${name} must contain valid JSON.`), { statusCode: 400 });
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw Object.assign(new Error(`${name} must contain a JSON object.`), { statusCode: 400 });
  }
  return parsed;
}

function scalarElements(entity) {
  return Object.entries(entity && entity.elements ? entity.elements : {})
    .filter(([, element]) => !element.target);
}

function sanitizeEntityPayload(data, entity, { isCreate, excluded = new Set() } = {}) {
  return Object.fromEntries(
    scalarElements(entity)
      .filter(([name, element]) => (
        data[name] !== undefined &&
        data[name] !== null &&
        !excluded.has(name) &&
        (isCreate || !element.key)
      ))
      .map(([name]) => [name, data[name]])
  );
}

function sanitizeEntityKeys(data, entity) {
  const keys = scalarElements(entity).filter(([, element]) => element.key);
  const sanitized = Object.fromEntries(
    keys
      .filter(([name]) => data[name] !== undefined && data[name] !== null && data[name] !== '')
      .map(([name]) => [name, data[name]])
  );

  const missing = keys.map(([name]) => name).filter((name) => sanitized[name] === undefined);
  if (missing.length) {
    throw Object.assign(
      new Error(`Missing key field(s): ${missing.join(', ')}.`),
      { statusCode: 400 }
    );
  }
  return sanitized;
}

function normalizeRemoteResult(result) {
  if (Array.isArray(result)) return result[0] || null;
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result.value)) return result.value[0] || null;
  if (result.d && Array.isArray(result.d.results)) return result.d.results[0] || null;
  if (result.d && typeof result.d === 'object') return result.d;
  return result;
}

function remoteErrorMessage(error, fallback) {
  const data = error?.response?.data || error?.cause?.response?.data;
  const message = data?.error?.message?.value
    || data?.error?.message
    || error?.cause?.message
    || error?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

function remoteEntity(service, name) {
  return service.entities?.[name] || `API_BUSINESS_PARTNER.${name}`;
}

function hasMaintenanceValue(value) {
  return value !== undefined && value !== null
    && (typeof value !== 'string' || value.trim() !== '');
}

function validateMaintenanceCreate(entityName, payload, configuration) {
  const missing = (configuration.requiredCreateFields || [])
    .filter((field) => !hasMaintenanceValue(payload[field]));
  if (missing.length) {
    throw Object.assign(
      new Error(`${entityName}: enter required field(s) ${missing.join(', ')}.`),
      { statusCode: 400 }
    );
  }

  const oneOf = configuration.oneOfCreateFields || [];
  if (oneOf.length && !oneOf.some((field) => hasMaintenanceValue(payload[field]))) {
    throw Object.assign(
      new Error(`${entityName}: enter at least one of ${oneOf.join(' or ')}.`),
      { statusCode: 400 }
    );
  }
}

/**
 * The parent's canonical URI plus the navigation. A parent may itself be a child with a composite
 * key, hence parentKeyFields as a list (parentKeyField stays for the single-key nodes). Key values
 * come off the client payload - a grandchild carries its parent's keys, so no extra round trip.
 */
function businessPartnerNavigationPath(configuration, payload) {
  const parentEntity = configuration.parentEntity || 'A_BusinessPartner';
  const parentKeyFields = configuration.parentKeyFields
    || [configuration.parentKeyField || 'BusinessPartner'];
  const values = parentKeyFields.map((field) => {
    const value = String(payload[field] ?? '').trim();
    if (!value) {
      throw Object.assign(new Error(`Enter a ${field} number.`), { statusCode: 400 });
    }
    return { field, value: value.replaceAll("'", "''") };
  });
  // A single key stays positional, A_Customer('54'); a composite key must name each field, because
  // position alone would not say which is which.
  const keyPredicate = values.length === 1
    ? `'${values[0].value}'`
    : values.map(({ field, value }) => `${field}='${value}'`).join(',');
  return `/${parentEntity}(${keyPredicate})/${configuration.navigation}`;
}

async function createBusinessPartnerChild(s4, configuration, payload) {
  return normalizeRemoteResult(await s4.send({
    method: 'POST',
    path: businessPartnerNavigationPath(configuration, payload),
    data: payload
  }));
}

// The catalogue arrives once per installed language, so a picker would repeat every category. Which
// encoding the key uses (`EN` or `E`) is not in the metadata, so the row is chosen by prefix match.
function taxTypeLanguageRank(language, wanted) {
  const value = String(language || '').trim().toUpperCase();
  if (!value) return 3;
  if (value.startsWith(wanted) || wanted.startsWith(value)) return 0;
  if (value === 'EN' || value === 'E') return 1;
  return 2;
}

function oneRowPerTaxType(rows, locale) {
  // A $count comes back as a number, not a list — leave it alone.
  if (!Array.isArray(rows)) return rows;
  const wanted = String(locale || 'en').slice(0, 2).toUpperCase();
  const best = new Map();
  for (const row of rows) {
    const code = row?.BPTaxType;
    if (!code) continue;
    const current = best.get(code);
    const better = !current
      || taxTypeLanguageRank(row.Language, wanted) < taxTypeLanguageRank(current.Language, wanted);
    if (better) best.set(code, row);
  }
  return [...best.values()]
    .sort((left, right) => String(left.BPTaxType).localeCompare(String(right.BPTaxType)));
}

function addDefaultAddressUsage(payload, hasExistingAddress) {
  const result = { ...payload };
  if (!result.AddressID) delete result.AddressID;
  if (!hasExistingAddress) {
    result.to_AddressUsage = [{
      AddressUsage: 'XXDEFAULT',
      StandardUsage: true
    }];
  }
  return result;
}

async function createBusinessPartnerAddress(s4, payload) {
  const businessPartner = String(payload.BusinessPartner || '').trim();
  if (!businessPartner) {
    throw Object.assign(new Error('Enter a business partner number for the address.'), { statusCode: 400 });
  }

  const existing = normalizeRemoteResult(await s4.run(
    cds.ql.SELECT.one
      .from(remoteEntity(s4, 'A_BusinessPartnerAddress'))
      .columns('AddressID')
      .where({ BusinessPartner: businessPartner })
  ));
  const data = addDefaultAddressUsage(payload, Boolean(existing));
  // SAP KBA 3109298 requires the first address to be created through this
  // navigation with an explicit XXDEFAULT address usage.
  return createBusinessPartnerChild(s4, MAINTENANCE_ENTITIES.Addresses, data);
}

function extractSearchTerms(searchExpression) {
  const values = [];

  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      if (typeof value.val === 'string') values.push(value.val);
      if (value.xpr) visit(value.xpr);
    }
  };

  visit(searchExpression);

  return values
    .flatMap((value) => value.trim().split(/\s+/u))
    .filter(Boolean);
}

function joinExpressions(expressions, operator) {
  return expressions.flatMap((expression, index) => [
    ...(index === 0 ? [] : [operator]),
    expression
  ]);
}

// Not every S/4 release implements the V2 free-text search extension, so Fiori's `$search` becomes
// ordinary `contains` filters.
/**
 * A partner is locked while a request over it is in flight. `failed` counts as active because the
 * post is not atomic and may have left it half-written; `reworkRequired` counts because the
 * requester is about to edit and resubmit, so leaving it out would unlock the partner mid-rework.
 * `checkAndEnrich` counts for the same reason as `reworkRequired`: a data steward is mid-edit.
 */
const ACTIVE_REQUEST_STATUSES = [
  'draft', 'inApproval', 'approved', 'reworkRequired', 'checkAndEnrich', 'failed'
];

function applyBusinessPartnerSearch(query) {
  const select = query && query.SELECT;
  if (!select || !select.search) return query;

  const terms = extractSearchTerms(select.search);
  select.search = undefined;
  if (terms.length === 0) return query;

  const searchExpression = joinExpressions(terms.map(termExpression), 'and');

  select.where = select.where && select.where.length
    ? [{ xpr: select.where }, 'and', { xpr: searchExpression }]
    : searchExpression;

  return query;
}

function validateBusinessPartnerCreate(data = {}) {
  const errors = [];
  const category = data.BusinessPartnerCategory;

  if (!category) {
    errors.push({
      target: 'BusinessPartnerCategory',
      message: 'Enter a business partner category.'
    });
  } else if (!['1', '2', '3'].includes(category)) {
    errors.push({
      target: 'BusinessPartnerCategory',
      message: 'Business partner category must be 1 (Person), 2 (Organization), or 3 (Group).'
    });
  }

  if (!data.BusinessPartnerGrouping) {
    errors.push({
      target: 'BusinessPartnerGrouping',
      message: 'Enter a business partner grouping.'
    });
  }

  if (category === '1' && !data.LastName) {
    errors.push({ target: 'LastName', message: 'Enter the last name for a person.' });
  }

  if (category === '2' && !data.OrganizationBPName1) {
    errors.push({
      target: 'OrganizationBPName1',
      message: 'Enter the organization name.'
    });
  }

  if (category === '3' && !data.GroupBusinessPartnerName1) {
    errors.push({
      target: 'GroupBusinessPartnerName1',
      message: 'Enter the group name.'
    });
  }

  return errors;
}

function assistantPartnerName(partner) {
  return partner.BusinessPartnerFullName
    || partner.BusinessPartnerName
    || partner.OrganizationBPName1
    || [partner.FirstName, partner.LastName].filter(Boolean).join(' ')
    || 'Unnamed Business Partner';
}

function assistantCategory(category) {
  return ({ '1': 'Person', '2': 'Organization', '3': 'Group' })[category]
    || category
    || 'Unknown';
}

function assistantPartnerLine(partner) {
  return `${partner.BusinessPartner} — ${assistantPartnerName(partner)}`
    + ` | ${assistantCategory(partner.BusinessPartnerCategory)}`
    + ` | Grouping ${partner.BusinessPartnerGrouping || '–'}`
    + ` | Blocked: ${partner.BusinessPartnerIsBlocked ? 'Yes' : 'No'}`;
}

function assistantAddressLine(address) {
  return [
    address.StreetName,
    address.HouseNumber,
    address.PostalCode,
    address.CityName,
    address.Region,
    address.Country,
    address.POBox ? `PO Box ${address.POBox}` : ''
  ].filter(Boolean).join(' ');
}

function assistantList(title, partners) {
  if (!partners.length) return `${title}\nNo matching Business Partners were found.`;
  const visible = partners.slice(0, 10);
  const remainder = partners.length - visible.length;
  return [
    `${title} (${partners.length})`,
    ...visible.map(assistantPartnerLine),
    ...(remainder > 0 ? [`…and ${remainder} more.`] : [])
  ].join('\n');
}

// Needs the ORIGINAL question, not a lower-cased one: quoted text wins, then capitalised words
// (almost always the name being asked about), then the remaining content words.
function assistantSearchTerms(question) {
  const raw = String(question || '');

  const quoted = [...raw.matchAll(/["“”']([^"“”']+)["“”']/gu)]
    .map((match) => match[1].trim().toLocaleLowerCase())
    .filter(Boolean);
  if (quoted.length) return quoted;

  const words = raw.replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/u).filter(Boolean);
  const isContentWord = (word) => (
    word.length > 1 &&
    !ASSISTANT_STOP_WORDS.has(word) &&
    !['address', 'addresses', 'adres', 'adressen', 'blocked', 'geblokkeerd'].includes(word)
  );

  // A capitalised word that does not open the sentence is the strongest signal.
  const properNouns = words
    .filter((word, index) => index > 0 && /^\p{Lu}/u.test(word))
    .map((word) => word.toLocaleLowerCase())
    .filter(isContentWord);
  if (properNouns.length) return properNouns;

  return words.map((word) => word.toLocaleLowerCase()).filter(isContentWord);
}

/** Pushed down to S/4, so the whole data set is searched and not just the first rows loaded. */
function assistantSearchFilter(terms) {
  return joinExpressions(terms.map(termExpression), 'or');
}

// Scopes an address read to the partners actually in context.
function assistantAddressFilter(partners = []) {
  return joinExpressions(
    partners.map((partner) => ({
      xpr: [{ ref: ['BusinessPartner'] }, '=', { val: String(partner.BusinessPartner) }]
    })),
    'or'
  );
}

// Pages through S/4 until every matching row has been read.
async function readAllPages(s4, buildQuery, pageSize = ASSISTANT_PAGE_SIZE) {
  const rows = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await s4.run(buildQuery(pageSize, skip));
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    if (rows.length >= ASSISTANT_MAX_ROWS) {
      console.warn(`[assistant] read stopped at the ${ASSISTANT_MAX_ROWS} row safety cap`);
      break;
    }
  }
  return rows;
}

// Chunks the partner list so the generated $filter stays a sane length.
async function readAssistantAddresses(s4, partners = []) {
  if (!partners.length) return [];
  const entity = remoteEntity(s4, 'A_BusinessPartnerAddress');
  const chunks = [];
  for (let index = 0; index < partners.length; index += ASSISTANT_ADDRESS_CHUNK) {
    chunks.push(partners.slice(index, index + ASSISTANT_ADDRESS_CHUNK));
  }
  const pages = await Promise.all(chunks.map((chunk) => readAllPages(
    s4,
    (top, skip) => cds.ql.SELECT
      .from(entity)
      .columns(...ASSISTANT_ADDRESS_FIELDS)
      .where(assistantAddressFilter(chunk))
      .limit(top, skip)
  )));
  return pages.flat();
}

// Selected by config so the same index can be fed by either transport. Deliberately not under
// cds.env.requires — CAP resolves that namespace as services and would try to connect this.
function createIndexReader(s4, env = cds.env.assistant?.indexSource) {
  const source = String(process.env.ASSISTANT_INDEX_SOURCE || env?.kind || 'cap').toLowerCase();
  if (source !== 'mcp') {
    return createCapReaders({ service: s4, remoteEntity: (name) => remoteEntity(s4, name) });
  }
  console.warn('[assistant] MCP index source carries names only — country and tax rules cannot fire');
  const destinationName = process.env.MCP_DESTINATION || env?.destination;
  // Confirmed against the sandbox; the destination has no default because it is landscape-specific.
  const serviceId = process.env.MCP_SERVICE_ID || env?.serviceId || 'ZAPI_BUSINESS_PARTNER_0001';
  if (!destinationName) throw new Error('ASSISTANT_INDEX_SOURCE=mcp needs MCP_DESTINATION');
  console.log(`[assistant] Name index reading through MCP service ${serviceId}`);
  return createMcpPartnerReader({
    callTool: createMcpToolCaller({ destinationName, executeHttpRequest }),
    serviceId
  });
}

// Reads the configured ruleset where a read is already happening, so it costs no extra round trip
// on a question. TTL-gated inside the store, and a failure keeps the rules already loaded.
function readDuplicateRules() {
  return refreshRules(async () => {
    const db = await cds.connect.to('db');
    return db.run(cds.ql.SELECT.from('mdmlight.config.DuplicateRules'));
  });
}

const MB = 1024 * 1024;

// The index is resident memory and mta.yaml pins none, so measure it rather than sizing on a guess.
// `grew` is indicative only - GC may run mid-build; compare the absolutes across partner counts.
function logIndexFootprint(refreshed, heapBefore) {
  // A skipped refresh did no work, and logging it would bury the builds.
  if (!refreshed || refreshed.skipped) return;
  const { heapUsed, rss } = process.memoryUsage();
  console.log(
    `[index] ${refreshed.full ? 'full build' : 'delta'}: ${refreshed.size} partners, `
    + `${refreshed.read} rows read, heap ${Math.round(heapUsed / MB)}MB `
    + `(grew ${Math.round((heapUsed - heapBefore) / MB)}MB), rss ${Math.round(rss / MB)}MB`
  );
}

// Falls back to the rows already read, so a failed index build never blocks an answer.
async function ensureIndex(s4) {
  try {
    if (!indexReader) indexReader = createIndexReader(s4);
    const heapBefore = process.memoryUsage().heapUsed;
    const [refreshed] = await Promise.all([
      nameIndex.refresh(indexReader),
      readDuplicateRules()
    ]);
    logIndexFootprint(refreshed, heapBefore);
  } catch (error) {
    console.warn('[assistant] Name index unavailable, matching on the filtered read:', error.message);
  }
}

const STAGING_NODES = Object.freeze({
  Addresses: 'mdmlight.staging.StagedAddresses',
  TaxNumbers: 'mdmlight.staging.StagedTaxNumbers',
  BankDetails: 'mdmlight.staging.StagedBankDetails',
  BusinessPartnerRoles: 'mdmlight.staging.StagedRoles'
});

// Pending creates, read whole so they can be matched. Best-effort: unavailable staging degrades the
// check to live partners rather than failing the question.
async function pendingCreateRequests() {
  try {
    const db = await cds.connect.to('db');
    const requests = await db.run(
      cds.ql.SELECT.from('mdmlight.staging.ChangeRequests')
        .columns('ID', 'status', 'requestType')
        .where({ status: { in: ACTIVE_REQUEST_STATUSES }, requestType: 'create' })
    );
    if (!requests.length) return [];
    const ids = requests.map((request) => request.ID);
    const general = await db.run(
      cds.ql.SELECT.from('mdmlight.staging.StagedGeneral').where({ request_ID: { in: ids } })
    );
    const nodes = {};
    for (const [section, entity] of Object.entries(STAGING_NODES)) {
      nodes[section] = await db.run(cds.ql.SELECT.from(entity).where({ request_ID: { in: ids } }));
    }
    return requests.map((request) => ({
      request,
      general: general.find((row) => row.request_ID === request.ID) || {},
      nodes: Object.fromEntries(Object.entries(nodes).map(([section, rows]) => [
        section, rows.filter((row) => row.request_ID === request.ID)
      ]))
    }));
  } catch (error) {
    console.warn('[duplicates] Pending change requests unavailable, checking live partners only:', error.message);
    return [];
  }
}

async function findIndexedDuplicates(s4, candidate, partners = [], { excludeRequest } = {}) {
  const record = typeof candidate === 'string' ? { Name: candidate } : candidate;
  await ensureIndex(s4);
  const pending = stagedEntries(await pendingCreateRequests(), { exclude: excludeRequest });
  return nameIndex.isBuilt()
    ? nameIndex.match(record, { rules: activeRules(), extra: pending })
    : checkAgainstPartners(record, partners, { extra: pending });
}

// Any term, ranked by how many hit. Requiring every term makes a natural sentence unsatisfiable,
// because no partner contains every word of it.
function matchingBusinessPartners(terms, partners = [], addresses = []) {
  return partners
    .map((partner) => {
      const partnerAddresses = addresses.filter(
        (address) => String(address.BusinessPartner) === String(partner.BusinessPartner)
      );
      const searchable = [
        ...ASSISTANT_FIELDS.map((field) => partner[field]),
        ...partnerAddresses.flatMap((address) => (
          ASSISTANT_ADDRESS_FIELDS.map((field) => address[field])
        ))
      ].filter((value) => value !== undefined && value !== null)
        .join(' ')
        .toLocaleLowerCase();
      return { partner, score: terms.filter((term) => searchable.includes(term)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.partner);
}

function answerBusinessPartnerQuestion(question, partners = [], addresses = []) {
  const normalized = String(question || '').trim().toLocaleLowerCase();
  if (!normalized) return 'Enter a question about the available Business Partners.';
  if (/^(?:hallo|hello|hi|hey|goedemorgen|goedemiddag|goedenavond)[!.?\s]*$/iu.test(normalized)) {
    return /^(?:hallo|goedemorgen|goedemiddag|goedenavond)/iu.test(normalized)
      ? 'Hallo! Vraag me gerust om een Business Partner te zoeken, te controleren op duplicaten of een nieuwe Business Partner voor te bereiden.'
      : 'Hello! Ask me to find a Business Partner, check possible duplicates, or prepare a new Business Partner.';
  }

  const asksAddress = /\b(address|addresses|adres|adressen)\b/u.test(normalized);
  const asksGrouping = /\b(grouping|groep|groepering)\b/u.test(normalized);
  const numberMatch = normalized.match(/\b(?:bp|business partner|partner)\s*#?\s*(\d{1,10})\b/u);

  if (asksAddress && numberMatch) {
    const number = numberMatch[1];
    const partner = partners.find((item) => String(item.BusinessPartner) === number);
    if (!partner) return `Business Partner ${number} was not found.`;
    const partnerAddresses = addresses.filter(
      (address) => String(address.BusinessPartner || number) === number
    );
    if (!partnerAddresses.length) return `${assistantPartnerLine(partner)}\nNo address was found.`;
    return [
      `Addresses for ${number} — ${assistantPartnerName(partner)}:`,
      ...partnerAddresses.map(assistantAddressLine)
    ].join('\n');
  }

  if (numberMatch && !asksGrouping) {
    const number = numberMatch[1];
    const partner = partners.find((item) => String(item.BusinessPartner) === number);
    return partner
      ? `Business Partner details:\n${assistantPartnerLine(partner)}`
      : `Business Partner ${number} was not found.`;
  }

  if (/\b(blocked|geblokkeerd|blokkade)\b/u.test(normalized)) {
    const blocked = partners.filter((partner) => Boolean(partner.BusinessPartnerIsBlocked));
    if (/\b(how many|count|aantal|hoeveel)\b/u.test(normalized)) {
      return `${blocked.length} of ${partners.length} Business Partners are blocked.`;
    }
    return assistantList('Blocked Business Partners', blocked);
  }

  if (/\b(category|categories|categorie|type)\b/u.test(normalized)) {
    const counts = partners.reduce((result, partner) => {
      const category = assistantCategory(partner.BusinessPartnerCategory);
      result[category] = (result[category] || 0) + 1;
      return result;
    }, {});
    return [
      `Business Partners by category (${partners.length} total):`,
      ...Object.entries(counts).map(([category, count]) => `${category}: ${count}`)
    ].join('\n');
  }

  if (asksGrouping) {
    const groupingMatch = normalized.match(/\b([a-z0-9]{4})\b/iu);
    if (!groupingMatch) {
      const counts = partners.reduce((result, partner) => {
        const grouping = partner.BusinessPartnerGrouping || '–';
        result[grouping] = (result[grouping] || 0) + 1;
        return result;
      }, {});
      return [
        'Business Partners by grouping:',
        ...Object.entries(counts)
          .sort((left, right) => right[1] - left[1])
          .slice(0, 15)
          .map(([grouping, count]) => `${grouping}: ${count}`)
      ].join('\n');
    }
    const grouping = groupingMatch[1].toUpperCase();
    return assistantList(
      `Business Partners in grouping ${grouping}`,
      partners.filter((partner) => String(partner.BusinessPartnerGrouping || '').toUpperCase() === grouping)
    );
  }

  // Pass the original question: capitalised words such as "Alluvion" are the
  // strongest search signal and are lost in the lower-cased variant.
  const terms = assistantSearchTerms(question);
  if (/\b(how many|count|aantal|hoeveel|total|totaal)\b/u.test(normalized)) {
    if (terms.length) {
      const matching = matchingBusinessPartners(terms, partners, addresses);
      return `${matching.length} Business Partner${matching.length === 1 ? '' : 's'} match “${terms.join(' ')}”.`;
    }
    return `There are ${partners.length} Business Partners available in S/4HANA.`;
  }

  if (!terms.length) {
    return 'Try asking “How many Business Partners are there?”, “Which are blocked?”, “Show BP 1”, or “Find Brussels”.';
  }

  const matching = matchingBusinessPartners(terms, partners, addresses);
  return assistantList(`Results for “${terms.join(' ')}”`, matching);
}

// The same engine as the indexed path, over the rows already read.
function findPotentialDuplicates(name, partners = [], options = {}) {
  return checkAgainstPartners({ Name: name }, partners, options);
}

// Every capture above ends at punctuation or end of line, so the words after the name come along.
// Cutting them here fixes all of the patterns at once instead of thirteen times over.
const TRAILING_CLAUSES = Object.freeze([
  /\s+(?:en|and)\s+(?:indien|if|zoek|search|lookup|maak|create)\b[\s\S]*$/iu,
  /\s+(?:in|within|binnen|op)\s+(?:our|the|my|your|their|het|de|ons|onze|dit|deze)\b[\s\S]*$/iu,
  /\s+(?:in|within|binnen|op)\s+(?:\w+\s+){0,2}?(?:system|systeem|s\/4hana|database)\b[\s\S]*$/iu,
  /\s+(?:avail\w*|beschikbaar\w*)\b[\s\S]*$/iu,
  /\s+(?:already|reeds|nog)\b[\s\S]*$/iu,
  /\s+(?:exists?|bestaat|aanwezig)\b[\s\S]*$/iu
]);

function stripTrailingClause(name) {
  return TRAILING_CLAUSES.reduce((result, pattern) => result.replace(pattern, ''), name);
}

function requestedCompanyName(question) {
  const source = String(question || '').trim();
  const quoted = source.match(/["“”']([^"“”']{2,80})["“”']/u);
  // Bounded, and tried last: an unbounded capture here used to swallow "Alluvion exist in our system".
  const company = source.match(
    /(?:bedrijf|bedrijven|company|companies|firma|organisatie|organisation|organization)\s+(?:genaamd\s+|named\s+|called\s+)?(.{2,80}?)(?:\s+(?:al|already|nog)\b)?(?:\s+(?:exists?|bestaat|aanwezig)\b[\s\S]*)?(?:[?.!,;:]|$)/iu
  );
  const about = source.match(/(?:over|about)\s+(?:het\s+|the\s+)?(.{2,80}?)(?:[?.!,;:]|$)/iu);
  const lookupCommand = source.match(
    /(?:kan|kun|could|can|wil|would)\s+(?:je|jij|u|you)\s+(.{2,80}?)\s+(?:opzoeken|zoeken|nakijken|look\s+up|lookup|research|check)\b/iu
  );
  const lookupAfterVerb = source.match(
    /(?:look\s+up|lookup|research|check|search\s+for)\s+(.{2,80}?)(?:\s+(?:and|if)\b|[?.!,;:]|$)/iu
  );
  const imperative = source.match(
    /^(?:zoek|search|lookup|research|check)\s+(?:info(?:rmation)?\s+(?:over|about)\s+)?(.{2,80}?)(?:[?.!,;:]|$)/iu
  );
  const existenceQuestion = source.match(
    /(?:is|are)\s+there\s+(?:an?\s+)?(?:business\s+partners?|bps?|companies|company|organisations?|organizations?)\s+(?:called|named)\s+(.{2,80}?)(?:[?.!,;:]|$)/iu
  );
  const anyNamedQuestion = source.match(
    /\b(?:any|welke|which)\s+(?:business\s+partners?|bps?|companies|company|organisations?|organizations?|bedrijven|bedrijf)\s+(?:called|named|genaamd|met\s+de\s+naam)\s+(.{2,80}?)(?:[?.!,;:]|$)/iu
  );
  const dutchExistenceQuestion = source.match(
    /(?:bestaat|is)\s+er\s+(?:al\s+)?(?:een\s+)?(?:business\s+partner|bp|bedrijf|firma|organisatie)\s+(?:genaamd|met\s+de\s+naam)\s+(.{2,80}?)(?:[?.!,;:]|$)/iu
  );
  const namedLookup = source.match(
    /(?:business\s+partners?|bps?|companies|company|bedrijven|bedrijf|firma|organisaties?|organisations?|organizations?)\s+(?:called|named|genaamd|met\s+de\s+naam)\s+(.{2,80}?)(?:\s+(?:vinden|zoeken|opzoeken|find|lookup|look\s+up)\b|[?.!,;:]|$)/iu
  );
  const informalExistenceQuestion = source.match(
    /(?:kijken|weten|checken|controleren)\s+(?:of|als)\s+(.{2,80}?)\s+(?:al\s+)?(?:bestaat|aanwezig\s+is)(?:[?.!,;:]|$)/iu
  );
  const directEnglishExistenceQuestion = source.match(
    /^does\s+(?:(?:the|a)\s+)?(?:(?:business\s+partner|bp|company|organisation|organization)\s+)?(.{2,80}?)\s+(?:already\s+)?exist(?:s)?(?:\s+(?:in|within)\s+(?:the\s+|our\s+|my\s+|their\s+)?(?:system|s\/4hana))?(?:[?.!,;:]|$)/iu
  );
  const directDutchExistenceQuestion = source.match(
    /^bestaat\s+(?:er\s+)?(?:(?:al|een)\s+)*(?:(?:business\s+partner|bp|bedrijf|firma|organisatie)\s+)?(.{2,80}?)(?:\s+al)?(?:\s+(?:in|binnen)\s+(?:het\s+)?(?:systeem|s\/4hana))?(?:[?.!,;:]|$)/iu
  );
  const predicateExistenceQuestion = source.match(
    /^(?:is|are)\s+(.{2,80}?)\s+(?:an?\s+)?(?:business\s+partner|bp)\b/iu
  );
  // Specific patterns first: the generic "company <rest>" and "about <rest>" catch-alls are backstops.
  let name = (quoted && quoted[1])
    || (existenceQuestion && existenceQuestion[1])
    || (anyNamedQuestion && anyNamedQuestion[1])
    || (dutchExistenceQuestion && dutchExistenceQuestion[1])
    || (namedLookup && namedLookup[1])
    || (informalExistenceQuestion && informalExistenceQuestion[1])
    || (directEnglishExistenceQuestion && directEnglishExistenceQuestion[1])
    || (directDutchExistenceQuestion && directDutchExistenceQuestion[1])
    || (predicateExistenceQuestion && predicateExistenceQuestion[1])
    || (lookupCommand && lookupCommand[1])
    || (lookupAfterVerb && lookupAfterVerb[1])
    || (imperative && imperative[1])
    || (company && company[1])
    || (about && about[1])
    || '';
  name = stripTrailingClause(name)
    .replace(/^(?:naar|for)\s+/iu, '')
    .replace(/[?.!,;:]+$/u, '')
    .trim();
  if (!name || /^(?:bedrijf|bedrijven|company|companies|firma|organisaties?|organisation|organization)$/iu.test(name)) return '';
  return name;
}

function parseConversationHistory(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Object.assign(new Error('ConversationJson must contain valid JSON.'), { statusCode: 400 });
  }
  if (!Array.isArray(parsed)) {
    throw Object.assign(new Error('ConversationJson must contain a JSON array.'), { statusCode: 400 });
  }
  return parsed
    .filter((entry) => entry && ['user', 'assistant'].includes(entry.role))
    .map((entry) => ({
      role: entry.role,
      content: String(entry.content || '').trim().slice(0, 1000)
    }))
    .filter((entry) => entry.content)
    .slice(-10);
}

function contextualCompanyName(question, conversationHistory = []) {
  const direct = requestedCompanyName(question);
  if (direct) return direct;
  const source = String(question || '');
  const isAffirmativeFollowUp = /^(?:yes|yes\s+please|sure|please|ja|ja\s+graag|graag|doe\s+maar|maak\s+(?:die|deze|hem)|prepare\s+it)(?:[?.!,;:]|$)/iu.test(source.trim());
  const bareWords = source
    .replace(/[?.!,;:]+$/u, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (!isAffirmativeFollowUp && bareWords.length >= 1 && bareWords.length <= 6
    && bareWords.every((word) => !ASSISTANT_STOP_WORDS.has(word.toLocaleLowerCase()))) {
    return bareWords.join(' ');
  }
  const isFollowUp = isAffirmativeFollowUp || /(?:\ber\b[\s\S]*\bvan\b|\bit\b|\bthat\b|\bdie\b|\bdeze\b|\bhiervan\b|\bdaarvan\b)/iu.test(source)
    && /(?:business\s+partner|\bbp\b|create|maak|maken|prepare|voorstel|informatie|information|research|opzoek|zoek|vergar)/iu.test(source);
  if (!isFollowUp) return '';
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    if (conversationHistory[index].role !== 'user') continue;
    const name = requestedCompanyName(conversationHistory[index].content);
    if (name) return name;
  }
  return '';
}

const AGGREGATE_PATTERN = /\b(how many|count|aantal|hoeveel|total|totaal|categor|categorie|grouping|groep|groepering|blocked|geblokkeerd|blokkade)\b/u;

// The model resolves the reference itself, so it only needs the earlier name, not the follow-up heuristics.
function companyNameFromHistory(conversationHistory = []) {
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    if (conversationHistory[index].role !== 'user') continue;
    const name = requestedCompanyName(conversationHistory[index].content);
    if (name) return name;
  }
  return '';
}

// One shape whichever parser answered, so the handler never branches on the source.
function resolveQuestionIntent(question, conversationHistory = [], modelIntent = null) {
  const patterns = {
    asksAggregate: AGGREGATE_PATTERN.test(question.toLocaleLowerCase()),
    searchTerms: assistantSearchTerms(question),
    companyName: contextualCompanyName(question, conversationHistory)
  };
  if (!modelIntent) return { ...patterns, isSmalltalk: false, source: 'patterns' };

  return {
    asksAggregate: modelIntent.intent === 'aggregate',
    searchTerms: modelIntent.searchTerms.length ? modelIntent.searchTerms : patterns.searchTerms,
    companyName: modelIntent.companyName
      || (modelIntent.referencesPriorTurn ? companyNameFromHistory(conversationHistory) : ''),
    isSmalltalk: modelIntent.intent === 'smalltalk',
    source: 'model'
  };
}

function businessPartnerCreationSuggestion(
  question,
  partners = [],
  research = null,
  resolvedCompanyName = ''
) {
  const name = resolvedCompanyName || requestedCompanyName(question);
  if (!name) return null;
  if (findPotentialDuplicates(name, partners).length) return null;
  const proposedName = String(research?.source === 'Wikipedia' ? research.title : name).trim();
  const address = research?.suggestedAddress || {};

  return {
    SuggestedAction: 'CREATE_BUSINESS_PARTNER',
    SuggestedData: JSON.stringify({
      BusinessPartnerCategory: '2',
      OrganizationBPName1: proposedName.slice(0, 40),
      SearchTerm1: name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 20),
      ...(address.StreetName ? { AddressStreetName: address.StreetName } : {}),
      ...(address.HouseNumber ? { AddressHouseNumber: address.HouseNumber } : {}),
      ...(address.PostalCode ? { AddressPostalCode: address.PostalCode } : {}),
      ...(address.CityName ? { AddressCityName: address.CityName } : {}),
      ...(address.Country ? { AddressCountry: address.Country } : {})
    })
  };
}

function duplicateAnswer(name, duplicates) {
  return [
    `I found ${duplicates.length === 1 ? 'a possible duplicate' : 'possible duplicates'} for “${name}” in S/4HANA. No creation proposal was prepared:`,
    ...duplicates.map(({ partner, score, verdict }) => (
      `${assistantPartnerLine(partner)} | ${VERDICT_LABELS[verdict] || 'Match'} ${Math.round(score * 100)}%`
    )),
    'Review the existing record before creating another Business Partner.'
  ].join('\n');
}

// attr.email comes from the XSUAA JWT claim; id is the logon-name fallback for auth kinds and
// mocked local users that carry no email.
function requestingUserEmail(req) {
  return req.user?.attr?.email || req.user?.id || '';
}

function lowerFirst(name) {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

const WORKFLOW_DATE_TYPES = Object.freeze(new Set(['cds.Date', 'cds.DateTime', 'cds.Timestamp']));
const WORKFLOW_TIME_TYPES = Object.freeze(new Set(['cds.Time']));
const WORKFLOW_NUMBER_TYPES = Object.freeze(new Set(['cds.Decimal', 'cds.Double', 'cds.Integer', 'cds.Integer64']));

// ABAP's initial date (00000000) reaches us as "0001-01-01" and an initial time as "00:00:00" -
// valid ISO, not real values. BPA rejects both (SAP_IPA_12094), so they are omitted, not sent.
function isAbapInitialDate(date) {
  return date.getUTCFullYear() <= 1;
}

function isAbapInitialTime(value) {
  return value === '00:00:00';
}

// BPA rejects CreationDate/CreationTime (SAP_IPA_12094) even with a real value, and who created a
// record technically is no use to an approver - so these are dropped unconditionally, not when blank.
const WORKFLOW_AUDIT_FIELDS = Object.freeze(new Set([
  'CreationDate', 'CreationTime', 'CreatedByUser',
  'LastChangeDate', 'LastChangeTime', 'LastChangedByUser'
]));

// Fields BPA rejects given the very value it accepts elsewhere, so it is that context variable being
// typed differently, not the value. Add an entry whenever SAP_IPA_12094 names a field not covered above.
const WORKFLOW_FIELD_EXCLUSIONS = Object.freeze({
  A_BuPaAddressUsage: new Set(['ValidityStartDate', 'ValidityEndDate']),
  A_BusinessPartnerRole: new Set(['ValidFrom', 'ValidTo'])
});

function isWorkflowFieldExcluded(entityName, name) {
  return WORKFLOW_FIELD_EXCLUSIONS[entityName]?.has(name) ?? false;
}

function defaultWorkflowValue(element) {
  if (element.type === 'cds.Boolean') return false;
  if (WORKFLOW_NUMBER_TYPES.has(element.type)) return 0;
  return '';
}

function toWorkflowValue(element, value) {
  if (value === undefined || value === null || value === '') return defaultWorkflowValue(element);
  if (element.type === 'cds.Boolean') return Boolean(value);
  if (WORKFLOW_NUMBER_TYPES.has(element.type)) return Number(value);
  return value;
}

// Every scalar field, camelCased as S/4 does for its own V4 proxies (first letter only) - EXCEPT
// date/time fields with no real value, which are omitted: BPA rejects "" and the sentinels alike.
function toWorkflowShape(entity, row, entityName) {
  const shaped = {};
  for (const [name, element] of Object.entries(entity.elements || {})) {
    if (element.target) continue; // skip associations/navigation properties
    if (WORKFLOW_AUDIT_FIELDS.has(name)) continue;
    if (entityName && isWorkflowFieldExcluded(entityName, name)) continue;
    const rawValue = row ? row[name] : undefined;
    const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== '';
    const key = lowerFirst(name);

    if (WORKFLOW_TIME_TYPES.has(element.type)) {
      if (hasValue && !isAbapInitialTime(rawValue)) shaped[key] = rawValue;
      continue;
    }

    if (WORKFLOW_DATE_TYPES.has(element.type)) {
      if (hasValue) {
        const date = rawValue instanceof Date ? rawValue : new Date(rawValue);
        if (!Number.isNaN(date.getTime()) && !isAbapInitialDate(date)) shaped[key] = date.toISOString();
      }
      continue;
    }

    shaped[key] = toWorkflowValue(element, rawValue);
  }
  return shaped;
}

// Every entity businesspartnerinput wants, and how each relates back to the partner. 'one' -> a
// single object (blank if absent), 'many' -> an array. Mirrors the WORKFLOW's schema, not S/4's keys.
const WORKFLOW_ENTITIES = Object.freeze([
  { name: 'A_BPAddrDepdntIntlLocNumber', cardinality: 'one', filterBy: 'businessPartner' },
  { name: 'A_BPContactToAddress', cardinality: 'many', filterBy: 'businessPartnerCompany' },
  { name: 'A_BPContactToFuncAndDept', cardinality: 'many', filterBy: 'businessPartnerCompany' },
  { name: 'A_BPCreditWorthiness', cardinality: 'one', filterBy: 'businessPartner' },
  { name: 'A_BPDataController', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BPFinancialServicesReporting', cardinality: 'one', filterBy: 'businessPartner' },
  { name: 'A_BPFiscalYearInformation', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BPRelationship', cardinality: 'many', filterBy: 'businessPartner1' },
  { name: 'A_BuPaAddressUsage', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BuPaIdentification', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BuPaIndustry', cardinality: 'one', filterBy: 'businessPartner' },
  { name: 'A_BusinessPartnerBank', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BPIntlAddressVersion', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BusinessPartnerContact', cardinality: 'many', filterBy: 'businessPartnerCompany' },
  { name: 'A_BusinessPartnerPaymentCard', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BusinessPartnerRating', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BusinessPartnerRole', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BusinessPartnerTaxNumber', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_BusPartAddrDepdntTaxNmbr', cardinality: 'many', filterBy: 'businessPartner' },
  { name: 'A_Customer', cardinality: 'one', filterBy: 'customer' },
  { name: 'A_CustAddrDepdntExtIdentifier', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustAddrDepdntInformation', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustomerCompany', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustomerCompanyText', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustomerDunning', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustomerSalesArea', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustomerSalesAreaTax', cardinality: 'one', filterBy: 'customer' },
  { name: 'A_CustomerSalesAreaText', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustomerTaxGrouping', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustomerText', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustomerUnloadingPoint', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustomerWithHoldingTax', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustSalesPartnerFunc', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustSlsAreaAddrDepdntInfo', cardinality: 'one', filterBy: 'customer' },
  { name: 'A_CustSlsAreaAddrDepdntTaxInfo', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_CustUnldgPtAddrDepdntInfo', cardinality: 'many', filterBy: 'customer' },
  { name: 'A_Supplier', cardinality: 'one', filterBy: 'supplier' },
  { name: 'A_SupplierCompany', cardinality: 'many', filterBy: 'supplier' },
  { name: 'A_SupplierCompanyText', cardinality: 'many', filterBy: 'supplier' },
  { name: 'A_SupplierDunning', cardinality: 'many', filterBy: 'supplier' },
  { name: 'A_SupplierPartnerFunc', cardinality: 'many', filterBy: 'supplier' },
  { name: 'A_SupplierPurchasingOrg', cardinality: 'many', filterBy: 'supplier' },
  { name: 'A_SupplierPurchasingOrgText', cardinality: 'many', filterBy: 'supplier' },
  { name: 'A_SupplierText', cardinality: 'many', filterBy: 'supplier' },
  { name: 'A_SupplierWithHoldingTax', cardinality: 'many', filterBy: 'supplier' },
  // Not keyed by BusinessPartner at all, so it is filtered by the AddressIDs found via
  // A_BusinessPartnerAddress - see filterBy: 'address'.
  { name: 'A_AddressEmailAddress', cardinality: 'many', filterBy: 'address' },
  { name: 'A_AddressFaxNumber', cardinality: 'many', filterBy: 'address' },
  { name: 'A_AddressHomePageURL', cardinality: 'many', filterBy: 'address' },
  { name: 'A_AddressPhoneNumber', cardinality: 'many', filterBy: 'address' }
]);

async function fetchWorkflowEntityRows(s4, entity, where, cardinality, name) {
  try {
    if (cardinality === 'many') {
      const rows = await s4.run(cds.ql.SELECT.from(entity).where(where));
      return (Array.isArray(rows) ? rows : []).map((row) => toWorkflowShape(entity, row, name));
    }
    const row = await s4.run(cds.ql.SELECT.one.from(entity).where(where));
    return toWorkflowShape(entity, row, name);
  } catch (error) {
    console.error(`Could not load ${name} for the approval workflow payload:`, error);
    return cardinality === 'many' ? [] : toWorkflowShape(entity, null, name);
  }
}

// A_BusinessPartner plus every related entity, each shaped by toWorkflowShape. Best-effort per
// entity: one failing lookup blanks that block rather than aborting the workflow start.
async function fetchBusinessPartnerInputForWorkflow(s4, businessPartner) {
  const result = {};

  const bpEntity = remoteEntity(s4, 'A_BusinessPartner');
  const bpRow = await fetchWorkflowEntityRows(s4, bpEntity, { BusinessPartner: businessPartner }, 'one', 'A_BusinessPartner');
  result.A_BusinessPartner = bpRow;
  const customer = bpRow.customer;
  const supplier = bpRow.supplier;

  const addressEntity = remoteEntity(s4, 'A_BusinessPartnerAddress');
  const addressRows = await fetchWorkflowEntityRows(s4, addressEntity, { BusinessPartner: businessPartner }, 'many', 'A_BusinessPartnerAddress');
  result.A_BusinessPartnerAddress = addressRows;
  const addressIds = addressRows.map((row) => row.addressID).filter(Boolean);

  for (const config of WORKFLOW_ENTITIES) {
    const entity = remoteEntity(s4, config.name);
    let where = null;
    if (config.filterBy === 'businessPartner') where = { BusinessPartner: businessPartner };
    else if (config.filterBy === 'businessPartner1') where = { BusinessPartner1: businessPartner };
    else if (config.filterBy === 'businessPartnerCompany') where = { BusinessPartnerCompany: businessPartner };
    else if (config.filterBy === 'customer' && customer) where = { Customer: customer };
    else if (config.filterBy === 'supplier' && supplier) where = { Supplier: supplier };
    else if (config.filterBy === 'address' && addressIds.length) where = { AddressID: addressIds };

    result[config.name] = where
      ? await fetchWorkflowEntityRows(s4, entity, where, config.cardinality, config.name)
      : (config.cardinality === 'many' ? [] : toWorkflowShape(entity, null, config.name));
  }

  return result;
}

// Every entity businesspartnerinput expects, in the order fetchBusinessPartnerInputForWorkflow uses.
const WORKFLOW_INPUT_ENTITIES = Object.freeze([
  { name: 'A_BusinessPartner', cardinality: 'one' },
  { name: 'A_BusinessPartnerAddress', cardinality: 'many' },
  ...WORKFLOW_ENTITIES
]);

// The same shape, built from rows the caller already has rather than a live read - a `create` has
// nothing in S/4 yet. Entities absent from `rowsByEntity` are shaped blank, like a brand new partner.
function buildWorkflowInputFromRows(s4, rowsByEntity) {
  const result = {};
  for (const config of WORKFLOW_INPUT_ENTITIES) {
    const entity = remoteEntity(s4, config.name);
    const rows = rowsByEntity[config.name];
    if (config.cardinality === 'many') {
      result[config.name] = (Array.isArray(rows) ? rows : []).map((row) => toWorkflowShape(entity, row, config.name));
    } else {
      const row = Array.isArray(rows) ? rows[0] : rows;
      result[config.name] = toWorkflowShape(entity, row || null, config.name);
    }
  }
  return result;
}

const APPROVAL_WORKFLOW_DEFINITION_ID = 'eu10.alluvion-dev-cf.mdmlightapproval.mDM_LIGHT_APPROVAL_WF';

function triggerApprovalWorkflow(req, businessPartnerInput) {
  return startWorkflow(APPROVAL_WORKFLOW_DEFINITION_ID, {
    emailadressinitiator: requestingUserEmail(req),
    businesspartnerinput: businessPartnerInput
  });
}

function externalResearchAnswer(name, research) {
  if (!research) {
    return `${name} is not present as a Business Partner in S/4HANA. No verified public company information could be retrieved, but you can still prepare a new Business Partner with the company name.`;
  }
  return [
    `${name} is not present as a Business Partner in S/4HANA.`,
    '',
    `Public company information from ${research.source || 'a public source'} (${research.title}${research.description ? ` - ${research.description}` : ''}):`,
    research.extract,
    ...(Array.isArray(research.sources) && research.sources.length
      ? research.sources.map((source) => `Source: ${source.title} - ${source.url}`)
      : [`Source: ${research.url}`]),
    '',
    'You can prepare a new Business Partner from this suggestion. Review all proposed data before saving it to S/4HANA.'
  ].join('\n');
}

class BusinessPartnerService extends cds.ApplicationService {
  async init() {
    const s4 = await cds.connect.to('API_BUSINESS_PARTNER');
    // ZSRVB_MDMLIGHT_VH backs every @Common.ValueList lookup; API_BUSINESS_PARTNER exposes none.
    const valueHelp = await cds.connect.to('ZSRVB_MDMLIGHT_VH');
    const db = await cds.connect.to('db');

    // Both remote models are checked-in copies, so they go stale silently. Not awaited: this must
    // never delay or fail boot, and with no destination it logs at debug and stops.
    checkMetadataDrift({
      requires: cds.env.requires,
      maintenanceEntities: MAINTENANCE_ENTITIES,
      valueHelpEntities: VALUE_HELP_ENTITIES,
      cviConfigSets: CVI_REMOTE_SETS,
      executeHttpRequest,
      readFile: require('fs').promises.readFile,
      log: cds.log('metadata')
    }).catch((error) => cds.log('metadata').debug('The drift check did not run:', error.message));

    /**
     * The change requests in flight, for the merged search list. Best-effort: staging unavailable
     * degrades the list to S/4 alone rather than failing the search outright.
     *
     * Only creates need their staged names read - a request over an existing partner is shown as a
     * mark on that partner's own row, so the staged copy is never displayed.
     */
    const inProgressRequests = async () => {
      try {
        const requests = await db.run(
          cds.ql.SELECT.from('mdmlight.staging.ChangeRequests')
            .columns(
              'ID', 'status', 'requestType', 'businessPartner',
              'createdAt', 'createdBy', 'submittedAt', 'submittedBy'
            )
            .where({ status: { in: IN_PROGRESS_REQUEST_STATUSES } })
        );
        const creates = requests.filter((request) => request.requestType === 'create');
        const general = creates.length
          ? await db.run(
            cds.ql.SELECT.from('mdmlight.staging.StagedGeneral')
              .where({ request_ID: { in: creates.map((request) => request.ID) } })
          )
          : [];
        return { requests, general };
      } catch (error) {
        console.warn('[search] Change requests in flight are unavailable, listing S/4 only:', error.message);
        return { requests: [], general: [] };
      }
    };

    /**
     * The remote half of the merged list. The columns are fixed rather than the client's: it asks
     * for status columns that exist only here, and one unknown field fails the whole remote read.
     */
    const readPartnerPage = async ({ where, search, orderBy, skip, top, count }) => {
      if (top === 0 && !count) return { rows: [], count: 0 };

      const query = cds.ql.SELECT.from(this.entities.BusinessPartners).columns(...PARTNER_FIELDS);
      if (where && where.length) query.SELECT.where = where;
      if (search) query.SELECT.search = search;

      const ordering = remoteOrderBy(orderBy);
      if (ordering.length) query.SELECT.orderBy = ordering;

      // A page already filled by staged rows still needs the total, and a count-only remote read is
      // not something this service can express - so it asks for one row and throws it away. The
      // remote counts the same whatever `$top` is; a page-size read was tried here while the string
      // `$count` above was being blamed on `$top=1`, and reverted once the arithmetic explained it.
      const rows = top === 0 ? 1 : top;
      const limit = {
        ...(rows === undefined ? {} : { rows: { val: rows } }),
        ...(skip ? { offset: { val: skip } } : {})
      };
      // An empty limit is not the same as no limit: CAP reads the object and would page on nothing.
      if (Object.keys(limit).length) query.SELECT.limit = limit;
      if (count) query.SELECT.count = true;

      applyBusinessPartnerSearch(query);

      const result = await s4.run(query);
      const page = Array.isArray(result) ? result : [];
      // `$count` arrives as a STRING from the V2 remote ("323"), and the caller adds the staged rows
      // to it. `"323" + 57` is `"32358"`, which is exactly what the list reported for a week - a
      // count two orders of magnitude out that still looked like a plausible partner population.
      const remoteCount = Number(page.$count ?? page.length);
      return {
        rows: top === 0 ? [] : page,
        count: Number.isFinite(remoteCount) ? remoteCount : page.length
      };
    };

    // Any write invalidates this instance's cached assistant reads.
    this.before('*', (req) => {
      if (['READ', 'askBusinessPartnerAssistant'].includes(req.event)) return;
      assistantCache.clear();
      nameIndex.markStale();
    });

    // Partners under an in-flight request used to be filtered out here. They are listed and marked
    // now instead: hiding one meant the display and edit screens could not open it either, and a
    // partner that vanishes teaches nobody that a request is already running over it.
    this.before('READ', 'BusinessPartners', (req) => {
      applyBusinessPartnerSearch(req.query);
    });

    /**
     * The one search list: the live partners and the requests in flight over them. Staging is read
     * first because the staged rows take the top of the list - a pending create has no partner
     * number, so that is where the default sort puts it, and fixing their position is what makes
     * the paging arithmetic exact instead of approximate.
     */
    this.on('READ', 'BusinessPartnerSearchResults', async (req) => {
      const select = req.query.SELECT || {};
      const top = select.limit?.rows?.val;
      const skip = select.limit?.offset?.val || 0;
      const terms = extractSearchTerms(select.search || []);

      let unsupported = null;
      const report = (expression) => { unsupported = unsupported ?? expression; };

      const { requests, general } = await inProgressRequests();
      const generalByRequest = new Map(general.map((row) => [row.request_ID, row]));

      /** Requests over an existing partner, so that partner's row can carry the mark. */
      const requestByPartner = new Map();
      for (const request of requests) {
        if (request.requestType !== 'create' && request.businessPartner) {
          requestByPartner.set(String(request.businessPartner), request);
        }
      }

      const pending = requests
        .filter((request) => request.requestType === 'create')
        .map((request) => pendingCreateEntry({ request, general: generalByRequest.get(request.ID) }))
        .filter((entry) => matchesWhere(entry.searchable, select.where, report)
          && matchesTerms(entry.searchable, terms, SEARCHABLE_FIELDS))
        .sort(byRequestedAtDesc);

      if (unsupported) {
        console.warn(
          '[search] A filter the staged rows cannot evaluate was kept rather than applied:',
          JSON.stringify(unsupported)
        );
      }

      const split = pageSplit({ pendingCount: pending.length, skip, top });
      const partners = await readPartnerPage({
        where: select.where,
        search: select.search,
        orderBy: select.orderBy,
        skip: split.partnerSkip,
        top: split.partnerTop,
        count: Boolean(select.count)
      });

      const rows = [
        ...pending
          .slice(split.pendingSkip, split.pendingSkip + split.pendingTaken)
          .map((entry) => entry.row),
        ...partners.rows.map((partner) => partnerEntry(
          partner, requestByPartner.get(String(partner.BusinessPartner))
        ).row)
      ];

      // Both sides are numbers by the time they meet here - see readPartnerPage. A string on either
      // side turns this into concatenation, which is how a 380-row list came to report 32,358.
      if (select.count) rows.$count = Number(partners.count) + pending.length;

      // An unbounded read of this list is a full read of S/4's partner population, and its count is
      // the one number nobody can sanity-check. Served rather than refused - a client that legitimately
      // asks for everything must still get it - but never silently.
      if (top === undefined) {
        console.warn(
          '[search] A read with no $top asked for the entire partner population; '
          + `${rows.length} rows returned. Query: ${JSON.stringify(select)}`
        );
      }

      return rows;
    });

    this.before('CREATE', 'BusinessPartners', (req) => {
      for (const error of validateBusinessPartnerCreate(req.data)) {
        req.error(400, error.message, error.target);
      }
    });

   this.on('createBusinessPartner', async (req) => {
    const payload = pickDefined(req.data, CREATE_FIELDS);
    let created;

  try {
    created = normalizeRemoteResult(await s4.run(
      cds.ql.INSERT.into(remoteEntity(s4, 'A_BusinessPartner')).entries(payload)
    ));
  } catch (error) {
    return req.reject(error.statusCode || 502, remoteErrorMessage(error, 'S/4HANA rejected the create request.'));
  }

  try {
    console.log("Starting approval workflow...");

    const businessPartnerInput = await fetchBusinessPartnerInputForWorkflow(s4, created.BusinessPartner);
    const workflowResult = await triggerApprovalWorkflow(req, businessPartnerInput);

    console.log("Workflow started successfully.");
    console.log(workflowResult);

    return created;

  } catch (error) {
    console.error("Workflow start failed:");
    console.error(error);

    req.info(500, `Business Partner created, but approval workflow could not be started: ${error.message}`);
    return created;
  }
});

    this.on('updateBusinessPartner', async (req) => {
      const businessPartner = req.data.BusinessPartner;
      if (!businessPartner) req.reject(400, 'Enter a business partner number.', 'BusinessPartner');

      const payload = pickDefined(req.data, UPDATE_FIELDS);
      if (Object.keys(payload).length === 0) {
        req.reject(400, 'Enter at least one value to update.');
      }

      const rootEntity = remoteEntity(s4, 'A_BusinessPartner');
      try {
        await s4.run(
          cds.ql.UPDATE(rootEntity).set(payload).where({ BusinessPartner: businessPartner })
        );
        const updated = normalizeRemoteResult(await s4.run(
          cds.ql.SELECT.one.from(rootEntity).where({ BusinessPartner: businessPartner })
        ));
        if (!updated) req.reject(404, `Business partner ${businessPartner} was not found.`);
        return updated;
      } catch (error) {
        req.reject(error.statusCode || 502, remoteErrorMessage(error, 'S/4HANA rejected the update request.'));
      }
    });

    this.on('saveBusinessPartner', async (req) => {
      let data;
      try {
        data = parseJsonObject(req.data.DataJson, 'DataJson');
      } catch (error) {
        return req.reject(error.statusCode || 400, error.message, 'DataJson');
      }

      const isCreate = Boolean(req.data.IsCreate);
      const entity = this.entities.BusinessPartners;
      const payload = sanitizeEntityPayload(data, entity, {
        isCreate,
        excluded: isCreate ? ROOT_CREATE_EXCLUDED_FIELDS : ROOT_UPDATE_EXCLUDED_FIELDS
      });

      if (isCreate) {
        const errors = validateBusinessPartnerCreate(payload);
        if (errors.length) {
          for (const error of errors) req.error(400, error.message, error.target);
          return;
        }

        let created;
        try {
          created = normalizeRemoteResult(await s4.run(
            cds.ql.INSERT.into(remoteEntity(s4, 'A_BusinessPartner')).entries(payload)
          ));
          if (!created?.BusinessPartner) {
            return req.reject(502, 'S/4HANA did not return the number of the created Business Partner.');
          }
        } catch (error) {
          return req.reject(error.statusCode || 502, remoteErrorMessage(error, 'S/4HANA rejected the create request.'));
        }

        // The workflow is deliberately NOT started here: only the root exists in S/4 yet, so it would
        // always send an empty address list. The UI starts it once every section is saved.

        return created;
      }

      const businessPartner = req.data.BusinessPartner;
      if (!businessPartner) return req.reject(400, 'Enter a business partner number.', 'BusinessPartner');
      if (Object.keys(payload).length === 0) return req.reject(400, 'There are no fields to update.');

      const rootEntity = remoteEntity(s4, 'A_BusinessPartner');
      try {
        await s4.run(
          cds.ql.UPDATE(rootEntity).set(payload).where({ BusinessPartner: businessPartner })
        );
        const updated = normalizeRemoteResult(await s4.run(
          cds.ql.SELECT.one.from(rootEntity).where({ BusinessPartner: businessPartner })
        ));
        if (!updated) return req.reject(404, `Business partner ${businessPartner} was not found.`);
        return updated;
      } catch (error) {
        return req.reject(error.statusCode || 502, remoteErrorMessage(error, 'S/4HANA rejected the update request.'));
      }
    });

    this.on('saveBusinessPartnerEntity', async (req) => {
      const configuration = MAINTENANCE_ENTITIES[req.data.Entity];
      if (!configuration) {
        req.reject(400, `Entity ${req.data.Entity || ''} is not available for maintenance.`, 'Entity');
      }

      const isCreate = Boolean(req.data.IsCreate);
      if (isCreate && !configuration.creatable) {
        req.reject(400, `${req.data.Entity} cannot be created directly. Add the corresponding role first.`);
      }

      let data;
      let keys;
      try {
        data = parseJsonObject(req.data.DataJson, 'DataJson');
        keys = parseJsonObject(req.data.KeyJson, 'KeyJson');
      } catch (error) {
        req.reject(error.statusCode || 400, error.message);
      }

      const entity = this.entities[req.data.Entity];
      const excludedFields = new Set(
        isCreate
          ? configuration.excludedCreateFields || []
          : configuration.excludedUpdateFields || []
      );
      const payload = sanitizeEntityPayload(data, entity, {
        isCreate,
        excluded: excludedFields
      });
      const targetEntity = remoteEntity(s4, configuration.remote);

      if (isCreate) {
        try {
          validateMaintenanceCreate(req.data.Entity, payload, configuration);
          const result = req.data.Entity === 'Addresses'
            ? await createBusinessPartnerAddress(s4, payload)
            : await createBusinessPartnerChild(s4, configuration, payload);
          return JSON.stringify(result || payload);
        } catch (error) {
          const message = remoteErrorMessage(error, `S/4HANA rejected the ${req.data.Entity} create request.`);
          req.reject(
            error.statusCode || 502,
            /BUA_CHECK_ADDRESS_VALIDITY_ALL|check table is missing/iu.test(message)
              ? `${message} The application supplied the required XXDEFAULT usage; verify that address usage XXDEFAULT is configured and active in this S/4HANA system.`
              : message
          );
        }
      }

      try {
        keys = sanitizeEntityKeys(keys, entity);
      } catch (error) {
        req.reject(error.statusCode || 400, error.message, 'KeyJson');
      }
      if (Object.keys(payload).length === 0) req.reject(400, 'There are no fields to update.');

      try {
        const affectedRows = await s4.run(
          cds.ql.UPDATE(targetEntity).set(payload).where(keys)
        );
        return JSON.stringify({ affectedRows: affectedRows ?? 1 });
      } catch (error) {
        req.reject(error.statusCode || 502, remoteErrorMessage(error, `S/4HANA rejected the ${req.data.Entity} update request.`));
      }
    });

    this.on('deleteBusinessPartnerEntity', async (req) => {
      const configuration = MAINTENANCE_ENTITIES[req.data.Entity];
      if (!configuration) {
        req.reject(400, `Entity ${req.data.Entity || ''} is not available for maintenance.`, 'Entity');
      }
      if (!configuration.deletable) {
        req.reject(405, `${req.data.Entity} cannot be deleted through this Business Partner API.`);
      }

      let keys;
      try {
        keys = sanitizeEntityKeys(
          parseJsonObject(req.data.KeyJson, 'KeyJson'),
          this.entities[req.data.Entity]
        );
      } catch (error) {
        req.reject(error.statusCode || 400, error.message, 'KeyJson');
      }

      try {
        const affectedRows = await s4.run(
          cds.ql.DELETE.from(remoteEntity(s4, configuration.remote)).where(keys)
        );
        return affectedRows !== 0;
      } catch (error) {
        req.reject(
          error.statusCode || 502,
          remoteErrorMessage(error, `S/4HANA rejected the ${req.data.Entity} delete request.`)
        );
      }
    });

    this.on('startBusinessPartnerApprovalWorkflow', async (req) => {
      const businessPartner = req.data.BusinessPartner;
      if (!businessPartner) return req.reject(400, 'Enter a business partner number.', 'BusinessPartner');

      let record;
      try {
        record = normalizeRemoteResult(await s4.run(
          cds.ql.SELECT.one.from(remoteEntity(s4, 'A_BusinessPartner')).where({ BusinessPartner: businessPartner })
        ));
      } catch (error) {
        req.info(500, `The approval workflow could not be started: ${remoteErrorMessage(error, error.message)}`);
        return false;
      }
      if (!record) {
        req.info(500, `The approval workflow could not be started: Business Partner ${businessPartner} was not found.`);
        return false;
      }

      try {
        console.log('Starting approval workflow...');
        const businessPartnerInput = await fetchBusinessPartnerInputForWorkflow(s4, businessPartner);
        await triggerApprovalWorkflow(req, businessPartnerInput);
        return true;
      } catch (error) {
        req.info(500, `Business Partner ${businessPartner} was saved, but the approval workflow could not be started: ${error.message}`);
        console.error(error);
        return false;
      }
    });

    // The change-request submit reaches the one duplicate check through here, so it shares this
    // service's S/4 connection and the single resident name index rather than building its own.
    this.on('checkBusinessPartnerDuplicates', async (req) => {
      const candidate = parseJsonObject(req.data.CandidateJson, 'CandidateJson');
      const s4 = await cds.connect.to('API_BUSINESS_PARTNER');
      const matches = await findIndexedDuplicates(s4, candidate, [], {
        excludeRequest: req.data.ExcludeRequest || null
      });
      const excludeBP = String(req.data.ExcludeBP || '').trim();
      const kept = excludeBP
        ? matches.filter((match) => String(match.partner?.BusinessPartner) !== excludeBP)
        : matches;
      return JSON.stringify({ findings: duplicateFindings(kept) });
    });

    this.on('currentUserPermissions', async (req) => ({
      isDataSteward: Boolean(req.user?.is?.('Steward')),
      aiAssistanceEnabled: await aiAssistanceEnabled()
    }));

    // Unsaved rules on purpose: a test that can only run the saved ruleset cannot show anyone the
    // effect of a change before they commit to it, which is the point of the button.
    this.on('testDuplicateRuleset', async (req) => {
      const s4 = await cds.connect.to('API_BUSINESS_PARTNER');
      await ensureIndex(s4);
      if (!nameIndex.isBuilt()) return req.reject(503, 'The duplicate index is not available yet.');
      const draft = req.data.RulesJson ? JSON.parse(req.data.RulesJson) : null;
      const rules = Array.isArray(draft) && draft.length ? usableRules(draft) : activeRules();
      const sampleSize = Number(req.data.SampleSize) > 0 ? Number(req.data.SampleSize) : undefined;
      return JSON.stringify(testRuleset(nameIndex.entries(), {
        rules,
        ...(sampleSize ? { samplesPerVerdict: sampleSize } : {})
      }));
    });

    this.on('askBusinessPartnerAssistant', async (req) => {
      // The one feature that exists solely to reach a language model, so an installation
      // with AI assistance switched off does not get a quieter version of it - it does not
      // get it at all. The UI hides every way in; this is the lock behind that, because the
      // action stays callable by anything holding the service URL.
      if (!await aiAssistanceEnabled()) {
        return req.reject(403, 'AI assistance is switched off for this system.');
      }

      const question = String(req.data.Question || '').trim();
      if (!question) req.reject(400, 'Enter a question.', 'Question');
      let conversationHistory;
      try {
        conversationHistory = parseConversationHistory(req.data.ConversationJson);
      } catch (error) {
        req.reject(error.statusCode || 400, error.message, 'ConversationJson');
      }

      const rootEntity = remoteEntity(s4, 'A_BusinessPartner');
      try {
        const normalized = question.toLocaleLowerCase();
        // A digit after "BP" is not something a model improves on, so this stays a pattern.
        const numberMatch = normalized.match(/\b(?:bp|business partner|partner)\s*#?\s*(\d{1,10})\b/u);
        // True by now - the guard above returned otherwise. Still threaded through, because
        // parseIntent and askSapAiCore are exported and must refuse on their own account
        // rather than trust every future caller to have checked first.
        const aiEnabled = await aiAssistanceEnabled();
        const modelIntent = useModelIntent()
          ? await parseIntent({ question, conversationHistory, aiEnabled })
          : null;
        // Aggregate questions need the broad set; a name search must be pushed
        // down to S/4 so it is not limited to the first rows returned.
        const { asksAggregate, searchTerms, companyName, isSmalltalk } = resolveQuestionIntent(
          question,
          conversationHistory,
          modelIntent
        );

        const partnerFilter = numberMatch
          ? { BusinessPartner: numberMatch[1] }
          : searchTerms.length && !asksAggregate
            ? assistantSearchFilter(searchTerms)
            : null;

        // Greetings and unrecognised questions need no business partner data at all.
        const needsPartnerData = !isSmalltalk
          && (Boolean(numberMatch) || asksAggregate || searchTerms.length > 0);
        const cacheKey = JSON.stringify(partnerFilter);
        const partners = needsPartnerData
          ? await assistantCache.get(`partners:${cacheKey}`, () => readAllPages(s4, (top, skip) => {
            const select = cds.ql.SELECT.from(rootEntity).columns(...ASSISTANT_FIELDS);
            if (partnerFilter) select.where(partnerFilter);
            return select.limit(top, skip);
          }))
          : [];
        // Only targeted questions use addresses; aggregates never reference them.
        const addresses = partnerFilter
          ? await assistantCache.get(`addresses:${cacheKey}`, () => readAssistantAddresses(s4, partners))
          : [];
        const duplicates = companyName ? await findIndexedDuplicates(s4, companyName, partners) : [];
        let research = null;
        if (companyName && !duplicates.length) {
          try {
            research = await researchCompany(companyName);
          } catch (error) {
            console.warn('[assistant] Public company lookup unavailable:', error.message);
          }
        }
        const suggestion = duplicates.length
          ? null
          : businessPartnerCreationSuggestion(question, partners, research, companyName);
        const fallbackAnswer = duplicates.length
          ? duplicateAnswer(companyName, duplicates)
          : suggestion
            ? externalResearchAnswer(companyName, research)
            : answerBusinessPartnerQuestion(question, partners, addresses);
        const assistantResult = await askSapAiCore({
          question,
          partners,
          addresses,
          fallbackAnswer,
          externalResearch: research,
          duplicateCandidates: duplicates.map(({ partner, score, verdict }) => ({
            ...partner,
            MatchScore: Math.round(score * 100),
            MatchVerdict: verdict,
            // Without this a pending create reads as a live partner that happens to have no number.
            PendingChangeRequest: partner.ChangeRequest || null
          })),
          conversationHistory,
          totalBusinessPartners: needsPartnerData ? partners.length : null,
          aiEnabled
        });
        return { ...assistantResult, ...(suggestion || {}) };
      } catch (error) {
        req.reject(
          error.statusCode || 502,
          remoteErrorMessage(error, 'The Business Partner Assistant could not read S/4HANA data.')
        );
      }
    });

    // Value-help entities backed by ZSRVB_MDMLIGHT_VH — read from there
    // instead of being forwarded to S4 by the catch-all handler below.
    for (const entity of VALUE_HELP_ENTITIES) {
      // TaxTypes has its own handler below: it is the one list keyed by language.
      if (entity === 'TaxTypes') continue;
      this.on('READ', entity, (req) => valueHelp.run(req.query));
    }

    // No paging: one row per category needs every language's rows in hand, and a page that shrinks
    // after deduplication is worse than reading a catalogue this small whole.
    this.on('READ', 'TaxTypes', async (req) => {
      if (req.query?.SELECT?.limit) delete req.query.SELECT.limit;
      return oneRowPerTaxType(await valueHelp.run(req.query), req.locale);
    });

    this.on(['READ', 'CREATE', 'UPDATE'], '*', (req) => s4.run(req.query));

    this.on('DELETE', '*', (req) => {
      req.reject(405, 'Deleting business partner data is disabled in this application.');
    });

    return super.init();
  }
}

BusinessPartnerService._internals = {
  ASSISTANT_FIELDS,
  ASSISTANT_ADDRESS_FIELDS,
  SEARCHABLE_FIELDS,
  searchableFieldsFor,
  termExpression,
  CREATE_FIELDS,
  UPDATE_FIELDS,
  MAINTENANCE_ENTITIES,
  VALUE_HELP_ENTITIES,
  ROOT_CREATE_EXCLUDED_FIELDS,
  ROOT_UPDATE_EXCLUDED_FIELDS,
  ASSISTANT_PAGE_SIZE,
  ASSISTANT_ADDRESS_CHUNK,
  ASSISTANT_MAX_ROWS,
  applyBusinessPartnerSearch,
  ACTIVE_REQUEST_STATUSES,
  assistantAddressFilter,
  assistantSearchFilter,
  readAllPages,
  readAssistantAddresses,
  createIndexReader,
  findIndexedDuplicates,
  nameIndex,
  extractSearchTerms,
  pickDefined,
  parseConversationHistory,
  companyNameFromHistory,
  resolveQuestionIntent,
  parseJsonObject,
  normalizeRemoteResult,
  remoteErrorMessage,
  businessPartnerNavigationPath,
  createBusinessPartnerChild,
  addDefaultAddressUsage,
  taxTypeLanguageRank,
  oneRowPerTaxType,
  createBusinessPartnerAddress,
  sanitizeEntityKeys,
  sanitizeEntityPayload,
  validateMaintenanceCreate,
  validateBusinessPartnerCreate,
  answerBusinessPartnerQuestion,
  findPotentialDuplicates,
  requestedCompanyName,
  contextualCompanyName,
  businessPartnerCreationSuggestion,
  duplicateAnswer,
  externalResearchAnswer,
  requestingUserEmail,
  WORKFLOW_ENTITIES,
  WORKFLOW_INPUT_ENTITIES,
  WORKFLOW_AUDIT_FIELDS,
  WORKFLOW_FIELD_EXCLUSIONS,
  lowerFirst,
  toWorkflowValue,
  toWorkflowShape,
  buildWorkflowInputFromRows,
  remoteEntity
};

module.exports = BusinessPartnerService;
