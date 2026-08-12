'use strict';

const { partnerFingerprints } = require('./name-match');
const { evaluate } = require('./duplicate-engine');

const INDEX_FIELDS = Object.freeze([
  'BusinessPartner',
  'BusinessPartnerFullName',
  'BusinessPartnerName',
  'OrganizationBPName1',
  'SearchTerm1',
  'BusinessPartnerCategory',
  'BusinessPartnerGrouping',
  'BusinessPartnerIsBlocked',
  'CreationDate',
  'LastChangeDate'
]);

/**
 * Child rows the index carries so a rule over country, postal code or tax number has something to
 * compare against. Only the catalog's own columns are kept — the point is the matching fields, not
 * a second copy of S/4. Roughly 150 bytes a partner on top of the header, so a 200k index moves
 * from ~20MB to ~50MB; state a new ceiling here if that stops being acceptable.
 *
 * Bank details are deliberately absent — see the IBAN entry in the field catalog.
 */
const CHILD_SOURCES = Object.freeze({
  addresses: Object.freeze({
    entitySet: 'A_BusinessPartnerAddress',
    columns: Object.freeze(['BusinessPartner', 'StreetName', 'PostalCode', 'CityName', 'Country'])
  }),
  taxNumbers: Object.freeze({
    entitySet: 'A_BusinessPartnerTaxNumber',
    columns: Object.freeze(['BusinessPartner', 'BPTaxType', 'BPTaxNumber'])
  }),
  roles: Object.freeze({
    entitySet: 'A_BusinessPartnerRole',
    columns: Object.freeze(['BusinessPartner', 'BusinessPartnerRole'])
  })
});

const CHILD_NAMES = Object.freeze(Object.keys(CHILD_SOURCES));

// A delta refresh never learns about deletions, so the index is rebuilt outright once a day.
const REBUILD_AFTER_MS = 86400000;
const REFRESH_INTERVAL_MS = 300000;

function fromEpoch(ms) {
  const parsed = new Date(ms);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

// The MCP hands back __metadata the CAP client strips; keeping it would waste ~200 bytes a row
// and make the two transports store different objects.
function project(row) {
  const projected = {};
  for (const field of INDEX_FIELDS) {
    if (row[field] !== undefined) projected[field] = row[field];
  }
  return projected;
}

function toDateKey(value) {
  if (!value) return '';
  if (value instanceof Date) return fromEpoch(value.getTime());
  const text = String(value);
  // The MCP hands back raw OData V2 JSON, where a date is /Date(1712275200000)/.
  const odata = text.match(/^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/u);
  if (odata) return fromEpoch(Number(odata[1]));
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/u);
  if (iso) return iso[1];
  return fromEpoch(Date.parse(text));
}

// Readers receive a plain watermark, never a CQN filter, so a non-CAP transport can serve them too.

// One reader stays a bare function, which is what every caller passed before children existed.
function normaliseReaders(readers) {
  return typeof readers === 'function' ? { partners: readers } : (readers || {});
}

function projectChild(row, columns) {
  const projected = {};
  for (const column of columns) {
    if (row[column] !== undefined) projected[column] = row[column];
  }
  return projected;
}


/**
 * Full-recall duplicate index. The old matcher only ever saw rows the OData
 * `contains` prefilter returned, so "Aluvion NV" could never surface for "Alluvion".
 */
function createNameIndex({
  now = Date.now,
  rebuildAfterMs = REBUILD_AFTER_MS,
  refreshIntervalMs = REFRESH_INTERVAL_MS
} = {}) {
  let entries = new Map();
  let watermark = '';
  let builtAt = 0;
  let refreshedAt = 0;
  let stale = false;
  let inFlight = null;

  function ingest(rows) {
    for (const row of rows) {
      const id = row?.BusinessPartner;
      if (id === undefined || id === null) continue;
      entries.set(String(id), { partner: project(row), fingerprints: partnerFingerprints(row) });
      // The watermark tracks S/4's own dates, not this instance's clock.
      for (const field of ['LastChangeDate', 'CreationDate']) {
        const key = toDateKey(row[field]);
        if (key > watermark) watermark = key;
      }
    }
  }

  /**
   * A delta re-reads children only for the partners it just saw change, so the cost tracks the
   * change volume rather than the population. The gap that leaves: a child edited without touching
   * its header is invisible until the daily full rebuild — the same class of staleness as a
   * deletion, and the same rebuild covers it.
   */
  async function ingestChildren(readers, changedIds) {
    const targets = changedIds || [...entries.keys()];
    for (const name of CHILD_NAMES) {
      const read = readers[name];
      if (!read) continue;
      const rows = await read({ partners: changedIds });
      for (const id of targets) {
        const entry = entries.get(id);
        // Cleared first so a delta replaces a partner's children instead of appending to them.
        if (entry) entry.partner[name] = [];
      }
      for (const row of Array.isArray(rows) ? rows : []) {
        const entry = entries.get(String(row?.BusinessPartner));
        if (!entry) continue;
        entry.partner[name] = entry.partner[name] || [];
        entry.partner[name].push(projectChild(row, CHILD_SOURCES[name].columns));
      }
    }
  }

  async function load(readers) {
    const { partners: readPartners, ...children } = normaliseReaders(readers);
    const full = !builtAt || (now() - builtAt) >= rebuildAfterMs || !watermark;
    // Read before discarding anything, so a failed rebuild cannot empty a working index.
    const rows = await readPartners({ since: full ? '' : watermark });
    if (full) {
      entries = new Map();
      watermark = '';
    }
    const read = Array.isArray(rows) ? rows : [];
    ingest(read);
    await ingestChildren(
      children,
      full ? null : read.map((row) => String(row?.BusinessPartner)).filter(Boolean)
    );
    refreshedAt = now();
    stale = false;
    if (full) builtAt = refreshedAt;
    return { full, read: read.length, size: entries.size };
  }

  // Concurrent questions share one refresh; a failed refresh leaves the previous index in place.
  function refresh(readers, { force = false } = {}) {
    if (inFlight) return inFlight;
    if (!force && !stale && builtAt && (now() - refreshedAt) < refreshIntervalMs) {
      return Promise.resolve({ full: false, read: 0, size: entries.size, skipped: true });
    }
    inFlight = load(readers).finally(() => { inFlight = null; });
    return inFlight;
  }

  // `where` keeps the person/organisation decision a one-line filter rather than an index rebuild.
  function match(candidate, { where, ...options } = {}) {
    const candidates = where
      ? [...entries.values()].filter((entry) => where(entry.partner))
      : entries.values();
    return evaluate(candidate, candidates, options);
  }

  // Sugar for the name-only case; it runs the same engine as every other caller.
  function find(name, options = {}) {
    return match({ Name: name }, options);
  }

  return {
    refresh,
    match,
    find,
    // Every indexed partner, for the admin page's "test against current BPs" run.
    entries: () => [...entries.values()],
    // A write must be matchable straight away, so it drops the refresh interval, not the index.
    markStale: () => { stale = true; },
    size: () => entries.size,
    watermark: () => watermark,
    isBuilt: () => Boolean(builtAt),
    reset: () => { entries = new Map(); watermark = ''; builtAt = 0; refreshedAt = 0; stale = false; }
  };
}

module.exports = {
  INDEX_FIELDS,
  CHILD_SOURCES,
  CHILD_NAMES,
  REBUILD_AFTER_MS,
  REFRESH_INTERVAL_MS,
  toDateKey,
  normaliseReaders,
  createNameIndex
};
