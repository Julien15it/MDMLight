'use strict';

const cds = require('@sap/cds');

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

    this.on(['READ', 'CREATE', 'UPDATE'], '*', (req) => s4.run(req.query));

    this.on('DELETE', '*', (req) => {
      req.reject(405, 'Deleting business partner data is disabled in this application.');
    });

    return super.init();
  }
}

BusinessPartnerService._internals = {
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
  validateBusinessPartnerCreate
};

module.exports = BusinessPartnerService;
