'use strict';

const cds = require('@sap/cds');
const { askSapAiCore } = require('./ai/business-partner-assistant');
const { parseIntent, useModelIntent } = require('./ai/intent');
const { researchCompany } = require('./ai/company-research');
const { createCache } = require('./ai/cache');
const { rankDuplicates, partnerFingerprints } = require('./ai/name-match');
const { createNameIndex } = require('./ai/name-index');
const { createCapPartnerReader, createMcpPartnerReader, ENTITY_SET } = require('./ai/partner-readers');
const { createMcpToolCaller } = require('./ai/mcp-client');
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
    deletable: false,
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
    creatable: false,
    deletable: false,
    updatable: true
  }),
  Suppliers: Object.freeze({
    remote: 'A_Supplier',
    navigation: 'to_Supplier',
    creatable: false,
    deletable: false,
    updatable: true
  })
});

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

function businessPartnerNavigationPath(configuration, payload) {
  const businessPartner = String(payload.BusinessPartner || '').trim();
  if (!businessPartner) {
    throw Object.assign(new Error('Enter a business partner number.'), { statusCode: 400 });
  }
  const escapedBusinessPartner = businessPartner.replaceAll("'", "''");
  return `/A_BusinessPartner('${escapedBusinessPartner}')/${configuration.navigation}`;
}

async function createBusinessPartnerChild(s4, configuration, payload) {
  return normalizeRemoteResult(await s4.send({
    method: 'POST',
    path: businessPartnerNavigationPath(configuration, payload),
    data: payload
  }));
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

/**
 * API_BUSINESS_PARTNER is OData V2 and not every S/4 release implements its
 * free-text search extension consistently. Convert the Fiori `$search` request
 * to ordinary `contains` filters, which CAP translates to OData V2.
 */
function applyBusinessPartnerSearch(query) {
  const select = query && query.SELECT;
  if (!select || !select.search) return query;

  const terms = extractSearchTerms(select.search);
  select.search = undefined;
  if (terms.length === 0) return query;

  const searchExpression = joinExpressions(
    terms.map((term) => ({
      xpr: joinExpressions(
        SEARCHABLE_FIELDS.map((field) => ({
          func: 'contains',
          // CAP 8's OData V2 URL serializer does not double embedded quotes.
          // Escape them here so names such as O'Hara remain valid literals.
          args: [{ ref: [field] }, { val: term.replaceAll("'", "''") }]
        })),
        'or'
      )
    })),
    'and'
  );

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

/**
 * Derives the search terms from a free-form question. Must be given the
 * original question, not a lower-cased one: quoted text wins, then capitalised
 * words such as "Alluvion" (almost always the name the user is after), and only
 * then the remaining content words.
 */
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

/**
 * Pushes the search down to S/4 so the whole data set is searched instead of
 * only the rows that happen to be loaded first.
 */
function assistantSearchFilter(terms) {
  return joinExpressions(
    terms.map((term) => ({
      xpr: joinExpressions(
        SEARCHABLE_FIELDS.map((field) => ({
          func: 'contains',
          args: [{ ref: [field] }, { val: term.replaceAll("'", "''") }]
        })),
        'or'
      )
    })),
    'or'
  );
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
    return createCapPartnerReader({ service: s4, entity: remoteEntity(s4, ENTITY_SET) });
  }
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

// Falls back to the rows already read, so a failed index build never blocks an answer.
async function findIndexedDuplicates(s4, name, partners = []) {
  try {
    if (!indexReader) indexReader = createIndexReader(s4);
    await nameIndex.refresh(indexReader);
  } catch (error) {
    console.warn('[assistant] Name index unavailable, matching on the filtered read:', error.message);
  }
  return nameIndex.isBuilt()
    ? nameIndex.find(name)
    : findPotentialDuplicates(name, partners);
}

/**
 * Matches on any term and ranks by how many terms hit. Requiring every term to
 * match makes a natural sentence such as "toon alle data die Alluvion als naam
 * heeft" impossible to satisfy, because no partner contains every word.
 */
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

// Fingerprints rows on the fly; the name index precomputes the same thing once per partner.
function findPotentialDuplicates(name, partners = [], options = {}) {
  return rankDuplicates(
    name,
    partners.map((partner) => ({ partner, fingerprints: partnerFingerprints(partner) })),
    options
  );
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
    ...duplicates.map(({ partner, score }) => (
      `${assistantPartnerLine(partner)} | Name match ${Math.round(score * 100)}%`
    )),
    'Review the existing record before creating another Business Partner.'
  ].join('\n');
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

    // Any write invalidates this instance's cached assistant reads.
    this.before('*', (req) => {
      if (['READ', 'askBusinessPartnerAssistant'].includes(req.event)) return;
      assistantCache.clear();
      nameIndex.markStale();
    });

    this.before('READ', 'BusinessPartners', (req) => {
      applyBusinessPartnerSearch(req.query);
    });

    this.before('CREATE', 'BusinessPartners', (req) => {
      for (const error of validateBusinessPartnerCreate(req.data)) {
        req.error(400, error.message, error.target);
      }
    });

    this.on('createBusinessPartner', async (req) => {
      const errors = validateBusinessPartnerCreate(req.data);
      if (errors.length) {
        for (const error of errors) req.error(400, error.message, error.target);
        return;
      }

      const payload = pickDefined(req.data, CREATE_FIELDS);
      try {
        return normalizeRemoteResult(await s4.run(
          cds.ql.INSERT.into(remoteEntity(s4, 'A_BusinessPartner')).entries(payload)
        ));
      } catch (error) {
        req.reject(error.statusCode || 502, remoteErrorMessage(error, 'S/4HANA rejected the create request.'));
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
        req.reject(error.statusCode || 400, error.message, 'DataJson');
      }

      const isCreate = Boolean(req.data.IsCreate);
      const entity = this.entities.BusinessPartners;
      const payload = sanitizeEntityPayload(data, entity, {
        isCreate,
        excluded: isCreate ? new Set() : ROOT_UPDATE_EXCLUDED_FIELDS
      });

      if (isCreate) {
        const errors = validateBusinessPartnerCreate(payload);
        if (errors.length) {
          for (const error of errors) req.error(400, error.message, error.target);
          return;
        }
        try {
          const created = normalizeRemoteResult(await s4.run(
            cds.ql.INSERT.into(remoteEntity(s4, 'A_BusinessPartner')).entries(payload)
          ));
          if (!created?.BusinessPartner) {
            req.reject(502, 'S/4HANA did not return the number of the created Business Partner.');
          }
          return created;
        } catch (error) {
          req.reject(error.statusCode || 502, remoteErrorMessage(error, 'S/4HANA rejected the create request.'));
        }
      }

      const businessPartner = req.data.BusinessPartner;
      if (!businessPartner) req.reject(400, 'Enter a business partner number.', 'BusinessPartner');
      if (Object.keys(payload).length === 0) req.reject(400, 'There are no fields to update.');

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

    this.on('askBusinessPartnerAssistant', async (req) => {
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
        const modelIntent = useModelIntent()
          ? await parseIntent({ question, conversationHistory })
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
          duplicateCandidates: duplicates.map(({ partner, score }) => ({
            ...partner,
            MatchScore: Math.round(score * 100)
          })),
          conversationHistory,
          totalBusinessPartners: needsPartnerData ? partners.length : null
        });
        return { ...assistantResult, ...(suggestion || {}) };
      } catch (error) {
        req.reject(
          error.statusCode || 502,
          remoteErrorMessage(error, 'The Business Partner Assistant could not read S/4HANA data.')
        );
      }
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
  CREATE_FIELDS,
  UPDATE_FIELDS,
  MAINTENANCE_ENTITIES,
  ROOT_UPDATE_EXCLUDED_FIELDS,
  ASSISTANT_PAGE_SIZE,
  ASSISTANT_ADDRESS_CHUNK,
  ASSISTANT_MAX_ROWS,
  applyBusinessPartnerSearch,
  assistantAddressFilter,
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
  externalResearchAnswer
};

module.exports = BusinessPartnerService;
