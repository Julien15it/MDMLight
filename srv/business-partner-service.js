'use strict';

const cds = require('@sap/cds');
const { askSapAiCore } = require('./ai/business-partner-assistant');

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

const ASSISTANT_STOP_WORDS = Object.freeze(new Set([
  'a', 'about', 'all', 'alle', 'and', 'are', 'business', 'de', 'een', 'find',
  'for', 'geef', 'hebben', 'het', 'how', 'ik', 'in', 'is', 'me', 'met', 'of',
  'partner', 'partners', 'show', 'tell', 'the', 'toon', 'van', 'wat', 'which',
  'who', 'zijn', 'zoek'
]));

const MAINTENANCE_ENTITIES = Object.freeze({
  Addresses: Object.freeze({ remote: 'A_BusinessPartnerAddress', creatable: true }),
  BusinessPartnerRoles: Object.freeze({ remote: 'A_BusinessPartnerRole', creatable: true }),
  TaxNumbers: Object.freeze({ remote: 'A_BusinessPartnerTaxNumber', creatable: true }),
  BankDetails: Object.freeze({ remote: 'A_BusinessPartnerBank', creatable: true }),
  Identifications: Object.freeze({ remote: 'A_BuPaIdentification', creatable: true }),
  Industries: Object.freeze({ remote: 'A_BuPaIndustry', creatable: true }),
  Customers: Object.freeze({ remote: 'A_Customer', creatable: false }),
  Suppliers: Object.freeze({ remote: 'A_Supplier', creatable: false })
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

function answerBusinessPartnerQuestion(question, partners = [], addresses = []) {
  const normalized = String(question || '').trim().toLocaleLowerCase();
  if (!normalized) return 'Enter a question about the available Business Partners.';

  const asksAddress = /\b(address|addresses|adres|adressen)\b/u.test(normalized);
  const asksGrouping = /\b(grouping|groep|groepering)\b/u.test(normalized);
  const numberMatch = normalized.match(/\b(?:bp|business partner|partner)\s*#?\s*(\d{1,10})\b/u);

  if (asksAddress && numberMatch) {
    const number = numberMatch[1];
    const partner = partners.find((item) => String(item.BusinessPartner) === number);
    if (!partner) return `Business Partner ${number} was not found.`;
    if (!addresses.length) return `${assistantPartnerLine(partner)}\nNo address was found.`;
    return [
      `Addresses for ${number} — ${assistantPartnerName(partner)}:`,
      ...addresses.map((address) => [
        address.StreetName,
        address.HouseNumber,
        address.PostalCode,
        address.CityName,
        address.Region,
        address.Country
      ].filter(Boolean).join(' '))
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

  if (/\b(how many|count|aantal|hoeveel|total|totaal)\b/u.test(normalized)) {
    return `There are ${partners.length} Business Partners available in S/4HANA.`;
  }

  const terms = assistantSearchTerms(normalized);
  if (!terms.length) {
    return 'Try asking “How many Business Partners are there?”, “Which are blocked?”, “Show BP 1”, or “Find Brussels”.';
  }

  const matching = partners.filter((partner) => {
    const searchable = ASSISTANT_FIELDS
      .map((field) => partner[field])
      .filter((value) => value !== undefined && value !== null)
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  return assistantList(`Results for “${terms.join(' ')}”`, matching);
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
      const payload = sanitizeEntityPayload(data, entity, { isCreate });
      const targetEntity = remoteEntity(s4, configuration.remote);

      if (isCreate) {
        try {
          const result = normalizeRemoteResult(
            await s4.run(cds.ql.INSERT.into(targetEntity).entries(payload))
          );
          return JSON.stringify(result || payload);
        } catch (error) {
          req.reject(error.statusCode || 502, remoteErrorMessage(error, `S/4HANA rejected the ${req.data.Entity} create request.`));
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

    this.on('askBusinessPartnerAssistant', async (req) => {
      const question = String(req.data.Question || '').trim();
      if (!question) req.reject(400, 'Enter a question.', 'Question');

      const rootEntity = remoteEntity(s4, 'A_BusinessPartner');
      try {
        const result = await s4.run(
          cds.ql.SELECT.from(rootEntity).columns(...ASSISTANT_FIELDS).limit(1000)
        );
        const partners = Array.isArray(result) ? result : [];
        let addresses = [];
        const normalized = question.toLocaleLowerCase();
        const numberMatch = normalized.match(/\b(?:bp|business partner|partner)\s*#?\s*(\d{1,10})\b/u);
        if (/\b(address|addresses|adres|adressen)\b/u.test(normalized) && numberMatch) {
          const addressResult = await s4.run(
            cds.ql.SELECT
              .from(remoteEntity(s4, 'A_BusinessPartnerAddress'))
              .columns(
                'BusinessPartner',
                'AddressID',
                'StreetName',
                'HouseNumber',
                'PostalCode',
                'CityName',
                'Region',
                'Country'
              )
              .where({ BusinessPartner: numberMatch[1] })
              .limit(50)
          );
          addresses = Array.isArray(addressResult) ? addressResult : [];
        }
        const fallbackAnswer = answerBusinessPartnerQuestion(question, partners, addresses);
        return await askSapAiCore({
          question,
          partners,
          addresses,
          fallbackAnswer
        });
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
  SEARCHABLE_FIELDS,
  CREATE_FIELDS,
  UPDATE_FIELDS,
  MAINTENANCE_ENTITIES,
  ROOT_UPDATE_EXCLUDED_FIELDS,
  applyBusinessPartnerSearch,
  extractSearchTerms,
  pickDefined,
  parseJsonObject,
  normalizeRemoteResult,
  remoteErrorMessage,
  sanitizeEntityKeys,
  sanitizeEntityPayload,
  validateBusinessPartnerCreate,
  answerBusinessPartnerQuestion
};

module.exports = BusinessPartnerService;
