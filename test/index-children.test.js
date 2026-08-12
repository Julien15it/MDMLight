'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CHILD_SOURCES, createNameIndex } = require('../srv/ai/name-index');
const { partnersFilter, createCapChildReader } = require('../srv/ai/partner-readers');
const { catalogFields, isIndexedField } = require('../srv/ai/duplicate-fields');
const { activeRules } = require('../srv/ai/duplicate-check');
const { VERDICTS } = require('../srv/ai/duplicate-engine');

const PARTNERS = [
  { BusinessPartner: '1', OrganizationBPName1: 'Delta NV', CreationDate: '2026-07-01' },
  { BusinessPartner: '2', OrganizationBPName1: 'Delta Inc', CreationDate: '2026-07-01' }
];

const ADDRESSES = [
  { BusinessPartner: '1', Country: 'BE', PostalCode: '9000', CityName: 'Gent', StreetName: 'Kaai 1' },
  { BusinessPartner: '2', Country: 'US', PostalCode: '10001', CityName: 'New York', StreetName: '5th Ave' }
];

const TAX_NUMBERS = [
  { BusinessPartner: '1', BPTaxType: 'BE0', BPTaxNumber: 'BE0666471360' }
];

const ROLES = [{ BusinessPartner: '1', BusinessPartnerRole: 'FLCU01' }];

const readersFor = (partners, { addresses = ADDRESSES, taxNumbers = TAX_NUMBERS, roles = ROLES } = {}) => {
  const calls = [];
  const child = (rows, name) => async ({ partners: ids }) => {
    calls.push({ name, ids });
    return ids === null ? rows : rows.filter((row) => ids.includes(String(row.BusinessPartner)));
  };
  return {
    calls,
    readers: {
      partners: async ({ since }) => (since ? partners.filter((row) => row.LastChangeDate >= since) : partners),
      addresses: child(addresses, 'addresses'),
      taxNumbers: child(taxNumbers, 'taxNumbers'),
      roles: child(roles, 'roles')
    }
  };
};

test('a full build attaches every child collection to its partner', async () => {
  const index = createNameIndex();
  const { readers, calls } = readersFor(PARTNERS);
  await index.refresh(readers);

  const [found] = index.match({ Name: 'Delta', Country: 'BE' }, { rules: activeRules() });
  assert.equal(found.partner.BusinessPartner, '1');
  assert.deepEqual(found.partner.addresses, [ADDRESSES[0]]);
  assert.deepEqual(found.partner.taxNumbers, [TAX_NUMBERS[0]]);
  assert.deepEqual(found.partner.roles, [ROLES[0]]);
  assert.deepEqual(calls.map((call) => call.ids), [null, null, null], 'a full build reads every row');
});

// This is the whole point of the expansion: the safety net could not fire without country.
test('the country disqualifying row now works against indexed partners', async () => {
  const index = createNameIndex();
  const { readers } = readersFor(PARTNERS);
  await index.refresh(readers);

  const belgian = index.match({ Name: 'Delta', Country: 'BE' }, { rules: activeRules() });
  assert.deepEqual(belgian.map((row) => row.partner.BusinessPartner), ['1']);
  assert.equal(belgian[0].verdict, VERDICTS.DUPLICATE);

  const american = index.match({ Name: 'Delta', Country: 'US' }, { rules: activeRules() });
  assert.deepEqual(american.map((row) => row.partner.BusinessPartner), ['2']);
});

test('a matching tax number is definitive against an indexed partner', async () => {
  const index = createNameIndex();
  const { readers } = readersFor(PARTNERS);
  await index.refresh(readers);

  const [found] = index.match({
    Name: 'Nothing Alike',
    Country: 'BE',
    taxNumbers: [{ BPTaxNumber: '0666471360' }]
  }, { rules: activeRules() });
  assert.equal(found.partner.BusinessPartner, '1');
  assert.equal(found.verdict, VERDICTS.DUPLICATE);
});

test('a delta scopes the child reads to the partners it just saw change', async () => {
  let clock = 1;
  const index = createNameIndex({ now: () => clock, refreshIntervalMs: 0 });
  const partners = PARTNERS.map((row) => ({ ...row, LastChangeDate: '2026-07-01' }));
  const { readers, calls } = readersFor(partners);
  await index.refresh(readers);

  clock = 2;
  partners.push({ BusinessPartner: '3', OrganizationBPName1: 'Delta Group', LastChangeDate: '2026-07-05' });
  calls.length = 0;
  await index.refresh(readers, { force: true });

  // Ids, not null: a delta must never re-read the whole population's children.
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(Array.isArray(call.ids), `${call.name} read every row instead of the changed ones`);
    assert.ok(call.ids.includes('3'));
  }
  // The untouched partner keeps the children the full build gave it.
  const [found] = index.match({ Name: 'Delta NV', Country: 'BE' }, { rules: activeRules() });
  assert.deepEqual(found.partner.addresses, [ADDRESSES[0]]);
});

test('a delta replaces a partner children rather than appending to them', async () => {
  let clock = 1;
  const index = createNameIndex({ now: () => clock, refreshIntervalMs: 0 });
  const partners = [{ BusinessPartner: '1', OrganizationBPName1: 'Delta NV', LastChangeDate: '2026-07-01' }];
  const addresses = [{ BusinessPartner: '1', Country: 'BE', PostalCode: '9000' }];
  const { readers } = readersFor(partners, { addresses });
  await index.refresh(readers);

  clock = 2;
  partners[0].LastChangeDate = '2026-07-05';
  addresses[0].PostalCode = '2000';
  await index.refresh(readers, { force: true });

  const [found] = index.match({ Name: 'Delta NV', Country: 'BE' }, { rules: activeRules() });
  assert.deepEqual(found.partner.addresses, [{ BusinessPartner: '1', Country: 'BE', PostalCode: '2000' }]);
});

test('only catalog columns are kept, so the index is not a second copy of S/4', async () => {
  const index = createNameIndex();
  const { readers } = readersFor([PARTNERS[0]], {
    addresses: [{ BusinessPartner: '1', Country: 'BE', AddressID: '531', POBox: 'noise', Region: 'VAN' }]
  });
  await index.refresh(readers);
  const [found] = index.match({ Name: 'Delta', Country: 'BE' }, { rules: activeRules() });
  assert.deepEqual(found.partner.addresses, [{ BusinessPartner: '1', Country: 'BE' }]);
});

test('a reader bundle without children still builds, as a bare function always did', async () => {
  const index = createNameIndex();
  await index.refresh(async () => PARTNERS);
  assert.equal(index.size(), 2);
  assert.equal(index.match({ Name: 'Delta NV' }, { rules: activeRules() }).length, 2);
});

test('the child reader chunks its filter and reads everything when unfiltered', async () => {
  const queries = [];
  // One short page per query, so paging ends immediately and the count is the chunk count.
  const service = {
    async run(query) {
      queries.push(query);
      return [{ BusinessPartner: '1', Country: 'BE' }];
    }
  };
  const read = createCapChildReader({
    service,
    entity: 'A_BusinessPartnerAddress',
    columns: CHILD_SOURCES.addresses.columns,
    pageSize: 1000
  });

  await read({ partners: Array.from({ length: 120 }, (unused, index) => String(index)) });
  assert.equal(queries.length, 3, '120 ids at 50 a chunk is three reads');
  assert.ok(queries.every((query) => query.SELECT?.where), 'a delta read is always filtered');

  queries.length = 0;
  await read({ partners: [] });
  assert.equal(queries.length, 0, 'no changed partners means no read at all');

  queries.length = 0;
  await read({ partners: null });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].SELECT?.where, undefined, 'a full build reads unfiltered');
});

test('the partner filter is the flat xpr shape .where() accepts here', () => {
  assert.deepEqual(partnersFilter(['1', '2']), [
    { xpr: [{ ref: ['BusinessPartner'] }, '=', { val: '1' }] },
    'or',
    { xpr: [{ ref: ['BusinessPartner'] }, '=', { val: '2' }] }
  ]);
  assert.deepEqual(partnersFilter([]), []);
});

test('the catalog says which fields the index can actually serve', () => {
  const fields = Object.fromEntries(catalogFields().map(({ field, indexed }) => [field, indexed]));
  assert.equal(fields.Country, true);
  assert.equal(fields.TaxNumber, true);
  assert.equal(fields.Role, true);
  assert.equal(fields.IBAN, false, 'bank data is deliberately not resident in the index');
  assert.equal(isIndexedField('TaxNumber.BE0'), true, 'a tax type inherits from its base field');
  assert.equal(isIndexedField('NotInTheCatalog'), false);
});
