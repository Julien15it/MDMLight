'use strict';

const { fetchJson } = require('./company-research');

// Free, CC0, no key, global. The only registry source that works from a name alone worldwide.
const GLEIF_API = 'https://api.gleif.org/api/v1/';
const DEFAULT_LIMIT = 5;
// Coverage skews to larger and financial-market entities, so a miss says nothing about the company.
const MAX_FUZZY_CANDIDATES = 10;

function firstText(value) {
  return String(value || '').trim();
}

function toAddress(address = {}) {
  const street = (Array.isArray(address.addressLines) ? address.addressLines : [])
    .map(firstText)
    .filter(Boolean)
    .join(' ');
  return {
    StreetName: street,
    PostalCode: firstText(address.postalCode),
    CityName: firstText(address.city),
    Country: firstText(address.country).toLocaleUpperCase()
  };
}

/**
 * `registeredAs` is the local company number — for a Belgian entity that is the KBO enterprise
 * number, which is worth far more to a duplicate check than any name string.
 */
function toEntity(record) {
  const attributes = record?.attributes || {};
  const entity = attributes.entity || {};
  const legalName = firstText(entity.legalName?.name);
  if (!legalName) return null;
  return {
    source: 'GLEIF',
    lei: firstText(attributes.lei) || firstText(record?.id),
    legalName,
    otherNames: (Array.isArray(entity.otherNames) ? entity.otherNames : [])
      .map((other) => firstText(other?.name))
      .filter(Boolean),
    registeredAs: firstText(entity.registeredAs),
    registeredAt: firstText(entity.registeredAt?.id),
    status: firstText(entity.status),
    address: toAddress(entity.legalAddress)
  };
}

function recordsFrom(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  return data.map(toEntity).filter(Boolean);
}

function leiRecordsUrl(params) {
  const url = new URL('lei-records', GLEIF_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

// A comma-separated filter[lei] is an OR; a LEI that does not exist is skipped rather than erroring.
async function byLeis(leis, options) {
  if (!leis.length) return [];
  return recordsFrom(await fetchJson(leiRecordsUrl({
    'filter[lei]': leis.join(','),
    'page[size]': String(leis.length)
  }), options));
}

function leisFromCompletions(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  const seen = new Set();
  for (const row of data) {
    const lei = firstText(row?.relationships?.['lei-records']?.data?.id);
    if (lei) seen.add(lei);
    if (seen.size >= MAX_FUZZY_CANDIDATES) break;
  }
  return [...seen];
}

async function fuzzySearch(name, options) {
  const url = new URL('fuzzycompletions', GLEIF_API);
  url.searchParams.set('field', 'entity.legalName');
  url.searchParams.set('q', name);
  return byLeis(leisFromCompletions(await fetchJson(url, options)), options);
}

/**
 * Two passes on purpose: the legalName filter is tokenised and misses spelling variants, which is
 * exactly the case a duplicate check cares about. The fuzzy pass costs a second call, so it only
 * runs when the first found nothing.
 */
async function searchByName(name, { limit = DEFAULT_LIMIT, ...options } = {}) {
  const companyName = firstText(name);
  if (!companyName) return [];
  const direct = recordsFrom(await fetchJson(leiRecordsUrl({
    'filter[entity.legalName]': companyName,
    'page[size]': String(limit)
  }), options));
  if (direct.length) return direct.slice(0, limit);
  return (await fuzzySearch(companyName, options)).slice(0, limit);
}

module.exports = {
  GLEIF_API,
  DEFAULT_LIMIT,
  MAX_FUZZY_CANDIDATES,
  toAddress,
  toEntity,
  recordsFrom,
  leisFromCompletions,
  searchByName
};
