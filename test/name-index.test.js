'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INDEX_FIELDS,
  toDateKey,
  changedSinceFilter,
  createNameIndex
} = require('../srv/ai/name-index');

const partner = (id, name, dates = {}) => ({
  BusinessPartner: id,
  OrganizationBPName1: name,
  BusinessPartnerCategory: '2',
  CreationDate: dates.created || '2026-07-01',
  LastChangeDate: dates.changed || '2026-07-01'
});

// Records every filter it was asked for so tests can assert full vs delta reads.
function fakeReader(pages) {
  const calls = [];
  const reader = async (filter) => {
    calls.push(filter);
    const page = pages.shift();
    if (page instanceof Error) throw page;
    return page || [];
  };
  reader.calls = calls;
  return reader;
}

test('carries no address fields, which is what keeps the index small', () => {
  assert.ok(!INDEX_FIELDS.some((field) => /Street|City|PostalCode|Country/u.test(field)));
  assert.ok(INDEX_FIELDS.includes('BusinessPartnerCategory'));
  assert.ok(INDEX_FIELDS.includes('LastChangeDate'));
});

test('normalises S/4 dates to a comparable day key', () => {
  assert.equal(toDateKey('2026-07-15T00:00:00Z'), '2026-07-15');
  assert.equal(toDateKey(new Date('2026-07-15T12:00:00Z')), '2026-07-15');
  assert.equal(toDateKey(null), '');
  assert.equal(toDateKey('not a date'), '');
});

test('finds a duplicate the contains prefilter could never have returned', async () => {
  const index = createNameIndex();
  const read = fakeReader([[partner('1', 'Aluvion NV'), partner('2', 'Unrelated Holding')]]);
  await index.refresh(read);

  const found = index.find('Alluvion');
  assert.equal(index.size(), 2);
  assert.equal(found.length, 1);
  assert.equal(found[0].partner.BusinessPartner, '1');
});

test('the first refresh reads everything and later ones only what changed', async () => {
  let clock = 1000;
  const index = createNameIndex({ now: () => clock });
  const read = fakeReader([
    [partner('1', 'Alluvion NV', { changed: '2026-07-01' })],
    [partner('2', 'Alluvion Consulting', { changed: '2026-07-20' })]
  ]);

  await index.refresh(read);
  assert.equal(read.calls[0], null);
  assert.equal(index.watermark(), '2026-07-01');

  clock += 300001;
  const result = await index.refresh(read);
  assert.deepEqual(read.calls[1], changedSinceFilter('2026-07-01'));
  assert.equal(result.full, false);
  assert.equal(index.size(), 2);
  assert.equal(index.watermark(), '2026-07-20');
});

test('a delta refresh replaces a row rather than duplicating it', async () => {
  let clock = 1000;
  const index = createNameIndex({ now: () => clock });
  const read = fakeReader([
    [partner('1', 'Old Name NV')],
    [partner('1', 'Alluvion NV', { changed: '2026-07-20' })]
  ]);

  await index.refresh(read);
  clock += 300001;
  await index.refresh(read);

  assert.equal(index.size(), 1);
  assert.equal(index.find('Alluvion').length, 1);
  assert.equal(index.find('Old Name').length, 0);
});

test('skips the read while the refresh interval has not elapsed', async () => {
  let clock = 1000;
  const index = createNameIndex({ now: () => clock });
  const read = fakeReader([[partner('1', 'Alluvion NV')]]);

  await index.refresh(read);
  const result = await index.refresh(read);

  assert.equal(result.skipped, true);
  assert.equal(read.calls.length, 1);
});

test('a write makes the next question refresh immediately', async () => {
  let clock = 1000;
  const index = createNameIndex({ now: () => clock });
  const read = fakeReader([
    [partner('1', 'Alluvion NV')],
    [partner('2', 'Aluvion Consulting', { changed: '2026-08-04' })]
  ]);

  await index.refresh(read);
  index.markStale();
  await index.refresh(read);

  assert.equal(read.calls.length, 2);
  assert.equal(index.size(), 2);
});

test('rebuilds in full once a day so deletions cannot linger', async () => {
  let clock = 1000;
  const index = createNameIndex({ now: () => clock });
  const read = fakeReader([
    [partner('1', 'Alluvion NV'), partner('2', 'Gone Soon NV')],
    [partner('1', 'Alluvion NV')]
  ]);

  await index.refresh(read);
  clock += 86400001;
  const result = await index.refresh(read);

  assert.equal(result.full, true);
  assert.equal(read.calls[1], null);
  assert.equal(index.size(), 1);
});

test('concurrent questions share one refresh', async () => {
  const index = createNameIndex();
  let reads = 0;
  const read = async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return [partner('1', 'Alluvion NV')];
  };

  await Promise.all([index.refresh(read), index.refresh(read)]);
  assert.equal(reads, 1);
});

test('a failed refresh leaves the previous index in place', async () => {
  let clock = 1000;
  const index = createNameIndex({ now: () => clock });
  const read = fakeReader([
    [partner('1', 'Alluvion NV')],
    new Error('S/4 unavailable')
  ]);

  await index.refresh(read);
  clock += 300001;
  await assert.rejects(() => index.refresh(read), /S\/4 unavailable/);

  assert.equal(index.isBuilt(), true);
  assert.equal(index.find('Alluvion').length, 1);
});

test('an unbuilt index reports itself so the caller can fall back', async () => {
  const index = createNameIndex();
  assert.equal(index.isBuilt(), false);
  await assert.rejects(() => index.refresh(fakeReader([new Error('down')])), /down/);
  assert.equal(index.isBuilt(), false);
});

test('a where filter narrows matching without rebuilding the index', async () => {
  const index = createNameIndex();
  await index.refresh(fakeReader([[
    { ...partner('1', 'Alluvion NV'), BusinessPartnerCategory: '2' },
    { ...partner('2', 'Alluvion NV'), BusinessPartnerCategory: '1' }
  ]]));

  assert.equal(index.find('Alluvion').length, 2);
  const organisations = index.find('Alluvion', {
    where: (row) => row.BusinessPartnerCategory === '2'
  });
  assert.equal(organisations.length, 1);
  assert.equal(organisations[0].partner.BusinessPartner, '1');
});

test('rows without a key are ignored', async () => {
  const index = createNameIndex();
  await index.refresh(fakeReader([[{ OrganizationBPName1: 'Alluvion NV' }, partner('1', 'Alluvion NV')]]));
  assert.equal(index.size(), 1);
});
