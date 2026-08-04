'use strict';

const { partnerFingerprints, rankDuplicates } = require('./name-match');

// No address fields: that omission is what keeps a 200k index around 20MB.
const INDEX_FIELDS = Object.freeze([
  'BusinessPartner',
  'BusinessPartnerFullName',
  'BusinessPartnerName',
  'OrganizationBPName1',
  'BusinessPartnerCategory',
  'BusinessPartnerGrouping',
  'BusinessPartnerIsBlocked',
  'CreationDate',
  'LastChangeDate'
]);

// A delta refresh never learns about deletions, so the index is rebuilt outright once a day.
const REBUILD_AFTER_MS = 86400000;
const REFRESH_INTERVAL_MS = 300000;

function toDateKey(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/u);
  if (match) return match[1];
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

// Readers receive a plain watermark, never a CQN filter, so a non-CAP transport can serve them too.


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
      entries.set(String(id), { partner: row, fingerprints: partnerFingerprints(row) });
      // The watermark tracks S/4's own dates, not this instance's clock.
      for (const field of ['LastChangeDate', 'CreationDate']) {
        const key = toDateKey(row[field]);
        if (key > watermark) watermark = key;
      }
    }
  }

  async function load(readPartners) {
    const full = !builtAt || (now() - builtAt) >= rebuildAfterMs || !watermark;
    // Read before discarding anything, so a failed rebuild cannot empty a working index.
    const rows = await readPartners({ since: full ? '' : watermark });
    if (full) {
      entries = new Map();
      watermark = '';
    }
    ingest(Array.isArray(rows) ? rows : []);
    refreshedAt = now();
    stale = false;
    if (full) builtAt = refreshedAt;
    return { full, read: Array.isArray(rows) ? rows.length : 0, size: entries.size };
  }

  // Concurrent questions share one refresh; a failed refresh leaves the previous index in place.
  function refresh(readPartners, { force = false } = {}) {
    if (inFlight) return inFlight;
    if (!force && !stale && builtAt && (now() - refreshedAt) < refreshIntervalMs) {
      return Promise.resolve({ full: false, read: 0, size: entries.size, skipped: true });
    }
    inFlight = load(readPartners).finally(() => { inFlight = null; });
    return inFlight;
  }

  // `where` keeps the person/organisation decision a one-line filter rather than an index rebuild.
  function find(name, { where, ...options } = {}) {
    const candidates = where
      ? [...entries.values()].filter((entry) => where(entry.partner))
      : entries.values();
    return rankDuplicates(name, candidates, options);
  }

  return {
    refresh,
    find,
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
  REBUILD_AFTER_MS,
  REFRESH_INTERVAL_MS,
  toDateKey,
  createNameIndex
};
