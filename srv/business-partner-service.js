'use strict';

const cds = require('@sap/cds');
const { askSapAiCore } = require('./ai/business-partner-assistant');
const { researchCompany } = require('./ai/company-research');

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

const ASSISTANT_STOP_WORDS = Object.freeze(new Set([
  'a', 'an', 'about', 'all', 'alle', 'and', 'are', 'business', 'called', 'de', 'een', 'find',
  'bedrijf', 'company', 'firma', 'for', 'geef', 'hebben', 'het', 'how', 'ik',
  'in', 'info', 'informatie', 'is', 'many', 'me', 'met', 'naam', 'name', 'of', 'organisatie', 'organization',
  'partner', 'partners', 'show', 'tell', 'the', 'toon', 'van', 'wat', 'which',
  'there', 'who', 'with', 'zijn', 'zoek', 'street', 'straat', 'city', 'stad', 'postal', 'postcode',
  'country', 'land', 'region', 'regio', 'located', 'gevestigd', 'adres', 'adressen',
  'address', 'addresses'
]));

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

function assistantSearchTerms(question) {
  const quoted = [...question.matchAll(/["“”']([^"“”']+)["“”']/gu)]
    .map((match) => match[1].trim().toLocaleLowerCase())
    .filter(Boolean);
  if (quoted.length) return quoted;

  return question
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length > 1 && !ASSISTANT_STOP_WORDS.has(word))
    .filter((word) => !['address', 'addresses', 'adres', 'adressen', 'blocked', 'geblokkeerd'].includes(word));
}

function matchingBusinessPartners(terms, partners = [], addresses = []) {
  return partners.filter((partner) => {
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
    return terms.every((term) => searchable.includes(term));
  });
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

  const terms = assistantSearchTerms(normalized);
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

function normalizedCompanyName(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function companyFingerprint(value) {
  const legalForms = new Set([
    'ag', 'bv', 'bvba', 'co', 'company', 'corp', 'corporation', 'gmbh', 'inc',
    'limited', 'llc', 'ltd', 'nv', 'plc', 'sa', 'se', 'srl'
  ]);
  return normalizedCompanyName(value)
    .split(/\s+/u)
    .filter((token) => token && !legalForms.has(token))
    .join('');
}

function diceSimilarity(left, right) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const pairs = new Map();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const available = pairs.get(pair) || 0;
    if (available > 0) {
      overlap += 1;
      pairs.set(pair, available - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

function findPotentialDuplicates(name, partners = []) {
  const requested = companyFingerprint(name);
  if (!requested) return [];

  return partners
    .map((partner) => {
      const candidates = [
        partner.BusinessPartnerFullName,
        partner.BusinessPartnerName,
        partner.OrganizationBPName1
      ].filter(Boolean);
      const score = Math.max(0, ...candidates.map((candidate) => {
        const fingerprint = companyFingerprint(candidate);
        if (!fingerprint) return 0;
        if (fingerprint === requested) return 1;
        const ratio = Math.min(fingerprint.length, requested.length)
          / Math.max(fingerprint.length, requested.length);
        if (requested.length >= 6 && ratio >= 0.75
          && (fingerprint.includes(requested) || requested.includes(fingerprint))) return 0.92;
        return diceSimilarity(requested, fingerprint);
      }));
      return { partner, score };
    })
    .filter(({ score }) => score >= 0.82)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function requestedCompanyName(question) {
  const source = String(question || '').trim();
  const quoted = source.match(/["“”']([^"“”']{2,80})["“”']/u);
  const company = source.match(
    /(?:bedrijf|company|firma|organisatie|organization)\s+(?:genaamd\s+|named\s+)?(.{2,80})$/iu
  );
  const about = source.match(/(?:over|about)\s+(?:het\s+|the\s+)?(.{2,80})$/iu);
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
    /(?:is|are)\s+there\s+(?:an?\s+)?(?:business\s+partner|bp|company|organisation|organization)\s+(?:called|named)\s+(.{2,80}?)(?:[?.!,;:]|$)/iu
  );
  const dutchExistenceQuestion = source.match(
    /(?:bestaat|is)\s+er\s+(?:al\s+)?(?:een\s+)?(?:business\s+partner|bp|bedrijf|firma|organisatie)\s+(?:genaamd|met\s+de\s+naam)\s+(.{2,80}?)(?:[?.!,;:]|$)/iu
  );
  const namedLookup = source.match(
    /(?:business\s+partner|bp|bedrijf|firma|organisatie)\s+(?:called|named|genaamd|met\s+de\s+naam)\s+(.{2,80}?)(?:\s+(?:vinden|zoeken|opzoeken|find|lookup|look\s+up)\b|[?.!,;:]|$)/iu
  );
  const informalExistenceQuestion = source.match(
    /(?:kijken|weten|checken|controleren)\s+(?:of|als)\s+(.{2,80}?)\s+(?:al\s+)?(?:bestaat|aanwezig\s+is)(?:[?.!,;:]|$)/iu
  );
  let name = (quoted && quoted[1])
    || (company && company[1])
    || (about && about[1])
    || (lookupCommand && lookupCommand[1])
    || (lookupAfterVerb && lookupAfterVerb[1])
    || (imperative && imperative[1])
    || (existenceQuestion && existenceQuestion[1])
    || (dutchExistenceQuestion && dutchExistenceQuestion[1])
    || (namedLookup && namedLookup[1])
    || (informalExistenceQuestion && informalExistenceQuestion[1])
    || '';
  name = name
    .replace(/\s+(?:en|and)\s+(?:indien|if|zoek|search|lookup|maak|create)\b[\s\S]*$/iu, '')
    .replace(/^(?:naar|for)\s+/iu, '')
    .replace(/[?.!,;:]+$/u, '')
    .trim();
  if (!name || /^(?:bedrijf|company|firma|organisatie|organization)$/iu.test(name)) return '';
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
  const bareWords = source
    .replace(/[?.!,;:]+$/u, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (bareWords.length >= 2 && bareWords.length <= 6
    && bareWords.every((word) => !ASSISTANT_STOP_WORDS.has(word.toLocaleLowerCase()))) {
    return bareWords.join(' ');
  }
  const isFollowUp = /(?:\ber\b[\s\S]*\bvan\b|\bit\b|\bthat\b|\bdie\b|\bdeze\b|\bhiervan\b|\bdaarvan\b)/iu.test(source)
    && /(?:business\s+partner|\bbp\b|create|maak|maken|prepare|voorstel|informatie|information|research|opzoek|zoek|vergar)/iu.test(source);
  if (!isFollowUp) return '';
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    if (conversationHistory[index].role !== 'user') continue;
    const name = requestedCompanyName(conversationHistory[index].content);
    if (name) return name;
  }
  return '';
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
        const [result, addressResult] = await Promise.all([
          s4.run(cds.ql.SELECT.from(rootEntity).columns(...ASSISTANT_FIELDS).limit(1000)),
          s4.run(
            cds.ql.SELECT
              .from(remoteEntity(s4, 'A_BusinessPartnerAddress'))
              .columns(...ASSISTANT_ADDRESS_FIELDS)
              .limit(5000)
          )
        ]);
        const partners = Array.isArray(result) ? result : [];
        const addresses = Array.isArray(addressResult) ? addressResult : [];
        const companyName = contextualCompanyName(question, conversationHistory);
        const duplicates = companyName ? findPotentialDuplicates(companyName, partners) : [];
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
          conversationHistory
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
  applyBusinessPartnerSearch,
  extractSearchTerms,
  pickDefined,
  parseConversationHistory,
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
