'use strict';

const { INDEX_FIELDS, CHILD_SOURCES } = require('./name-index');

const ENTITY_SET = 'A_BusinessPartner';
const PAGE_SIZE = 1000;
// Keeps the generated $filter a sane length, the same reason readAssistantAddresses chunks.
const CHILD_CHUNK = 50;
// Above the 200k top of the agreed customer range, so the cap is a safety net and not a limit.
const MAX_ROWS = 250000;

// Truncation silently under-reports duplicates, so it must never pass unnoticed.
function reachedCap(rows, maxRows, transport) {
  if (rows.length < maxRows) return false;
  console.warn(`[assistant] ${transport} name index stopped at the ${maxRows} row cap — duplicate checks are now partial`);
  return true;
}

// A never-changed partner can have a null LastChangeDate, so CreationDate has to be in the OR.
const WATERMARK_FIELDS = Object.freeze(['LastChangeDate', 'CreationDate']);

// A flat token array, which is what this codebase's other filters hand to .where().
function changedSinceFilter(since) {
  return WATERMARK_FIELDS.flatMap((field, position) => [
    ...(position ? ['or'] : []),
    '(', { ref: [field] }, '>=', { val: since }, ')'
  ]);
}

// OData V2 wants datetime literals, not bare dates.
function changedSinceQuery(since) {
  return WATERMARK_FIELDS
    .map((field) => `(${field} ge datetime'${since}T00:00:00')`)
    .join(' or ');
}

/**
 * CAP remote-service reader. Kept alongside the MCP reader rather than replaced,
 * so the same suite can exercise both transports.
 */
function createCapPartnerReader({ service, entity, pageSize = PAGE_SIZE, maxRows = MAX_ROWS }) {
  const cds = require('@sap/cds');

  return async function readPartners({ since = '' } = {}) {
    const rows = [];
    for (let skip = 0; ; skip += pageSize) {
      const select = cds.ql.SELECT.from(entity).columns(...INDEX_FIELDS);
      if (since) select.where(changedSinceFilter(since));
      const page = await service.run(select.limit(pageSize, skip));
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      if (page.length < pageSize || reachedCap(rows, maxRows, 'CAP')) break;
    }
    return rows;
  };
}

// The flat `{xpr}`-joined shape this codebase's other filters hand to .where().
function partnersFilter(ids = []) {
  return ids.flatMap((id, position) => [
    ...(position ? ['or'] : []),
    { xpr: [{ ref: ['BusinessPartner'] }, '=', { val: String(id) }] }
  ]);
}

/**
 * Reads one child collection for the index. `partners: null` means every row — a full rebuild;
 * an array of ids means only those partners changed, which is what keeps a delta cheap.
 */
function createCapChildReader({ service, entity, columns, pageSize = PAGE_SIZE, maxRows = MAX_ROWS }) {
  const cds = require('@sap/cds');

  const readPage = async (filter) => {
    const rows = [];
    for (let skip = 0; ; skip += pageSize) {
      const select = cds.ql.SELECT.from(entity).columns(...columns);
      if (filter) select.where(filter);
      const page = await service.run(select.limit(pageSize, skip));
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      if (page.length < pageSize || reachedCap(rows, maxRows, 'CAP child')) break;
    }
    return rows;
  };

  return async function readChildren({ partners = null } = {}) {
    if (partners === null) return readPage(null);
    if (!partners.length) return [];
    const chunks = [];
    for (let index = 0; index < partners.length; index += CHILD_CHUNK) {
      chunks.push(partners.slice(index, index + CHILD_CHUNK));
    }
    const pages = await Promise.all(chunks.map((chunk) => readPage(partnersFilter(chunk))));
    return pages.flat();
  };
}

/**
 * The whole reader bundle the name index needs. The MCP path stays partners-only: it is shelved,
 * and a half-populated index would be worse than an obviously name-only one.
 */
function createCapReaders({ service, remoteEntity, ...options }) {
  const readers = { partners: createCapPartnerReader({ service, entity: remoteEntity(ENTITY_SET), ...options }) };
  for (const [name, source] of Object.entries(CHILD_SOURCES)) {
    readers[name] = createCapChildReader({
      service,
      entity: remoteEntity(source.entitySet),
      columns: source.columns,
      ...options
    });
  }
  return readers;
}

// The MCP returns tool content, not rows; every known envelope unwraps to the same array.
function unwrapRows(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === 'string') return unwrapRows(safeParse(result));
  if (Array.isArray(result.content)) {
    const text = result.content.filter((part) => part?.type === 'text').map((part) => part.text).join('');
    return text ? unwrapRows(safeParse(text)) : [];
  }
  if (result.d) return Array.isArray(result.d.results) ? result.d.results : [result.d];
  if (Array.isArray(result.value)) return result.value;
  if (Array.isArray(result.results)) return result.results;
  return [];
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function indexQueryPath(since, top, skip, entitySet = ENTITY_SET) {
  const query = [
    `$select=${INDEX_FIELDS.join(',')}`,
    `$top=${top}`,
    `$skip=${skip}`
  ];
  if (since) query.push(`$filter=${encodeURIComponent(changedSinceQuery(since))}`);
  return `${entitySet}?${query.join('&')}`;
}

/**
 * AI Data Enabler MCP reader. Same contract as the CAP reader, so the name index
 * cannot tell them apart and the comparison measures transports, not two programs.
 */
function createMcpPartnerReader({
  callTool,
  serviceId,
  entitySet = ENTITY_SET,
  pageSize = PAGE_SIZE,
  maxRows = MAX_ROWS
}) {
  return async function readPartners({ since = '' } = {}) {
    const rows = [];
    for (let skip = 0; ; skip += pageSize) {
      const result = await callTool('execute-sap-operation', {
        serviceId,
        method: 'GET',
        path: indexQueryPath(since, pageSize, skip, entitySet)
      });
      const page = unwrapRows(result);
      if (page.length === 0) break;
      rows.push(...page);
      if (page.length < pageSize || reachedCap(rows, maxRows, 'MCP')) break;
    }
    return rows;
  };
}

module.exports = {
  ENTITY_SET,
  PAGE_SIZE,
  CHILD_CHUNK,
  MAX_ROWS,
  WATERMARK_FIELDS,
  partnersFilter,
  createCapChildReader,
  createCapReaders,
  changedSinceFilter,
  changedSinceQuery,
  indexQueryPath,
  unwrapRows,
  createCapPartnerReader,
  createMcpPartnerReader
};
