'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INDEX_FIELDS,
  createNameIndex
} = require('../srv/ai/name-index');
const {
  changedSinceFilter,
  changedSinceQuery,
  indexQueryPath,
  unwrapRows,
  createCapPartnerReader,
  createMcpPartnerReader
} = require('../srv/ai/partner-readers');

const PAGE_SIZE = 2;

const DATA = [
  { BusinessPartner: '1', OrganizationBPName1: 'Alluvion NV', LastChangeDate: '2026-07-01' },
  { BusinessPartner: '2', OrganizationBPName1: 'Beta Holding NV', LastChangeDate: '2026-07-01' },
  { BusinessPartner: '3', OrganizationBPName1: 'Gamma Works BV', LastChangeDate: '2026-07-01' },
  { BusinessPartner: '4', OrganizationBPName1: 'Delta Trading SA', LastChangeDate: '2026-07-01' },
  { BusinessPartner: '5', OrganizationBPName1: 'Epsilon Group', LastChangeDate: '2026-07-01' }
];

const CHANGED = [
  { BusinessPartner: '6', OrganizationBPName1: 'Aluvion Consulting', LastChangeDate: '2026-07-20' }
];

const row = (partner) => ({ CreationDate: '2026-07-01', BusinessPartnerCategory: '2', ...partner });

// Verified against the sandbox: the MCP returns raw V2 JSON dates, CAP returns parsed ones.
const asV2Date = (value) => (value ? `/Date(${Date.parse(`${value}T00:00:00Z`)})/` : null);

const asV2Row = (partner) => ({
  ...partner,
  CreationDate: asV2Date(partner.CreationDate),
  LastChangeDate: asV2Date(partner.LastChangeDate)
});

// One dataset behind both transports, so any difference is the transport and not the fixture.
function serve({ since, top, skip }) {
  const source = (since ? CHANGED : DATA).map(row);
  return source.slice(skip, skip + top);
}

function capReader(calls) {
  const service = {
    async run(query) {
      const select = query.SELECT || query;
      const limit = select.limit || {};
      const top = limit.rows?.val ?? limit.rows ?? PAGE_SIZE;
      const skip = limit.offset?.val ?? limit.offset ?? 0;
      const since = findVal(select.where);
      calls.push({ since, top, skip });
      return serve({ since, top, skip });
    }
  };
  return createCapPartnerReader({ service, entity: 'A_BusinessPartner', pageSize: PAGE_SIZE });
}

function findVal(where) {
  const tokens = Array.isArray(where) ? where : where?.xpr;
  if (!Array.isArray(tokens)) return '';
  for (const token of tokens) {
    if (token && typeof token === 'object' && 'val' in token) return token.val;
  }
  return '';
}

function mcpReader(calls) {
  const callTool = async (name, args) => {
    assert.equal(name, 'execute-sap-operation');
    assert.equal(args.method, 'GET');
    const top = Number(args.path.match(/\$top=(\d+)/u)[1]);
    const skip = Number(args.path.match(/\$skip=(\d+)/u)[1]);
    const filter = args.path.match(/\$filter=([^&]+)/u);
    const since = filter ? decodeURIComponent(filter[1]).match(/datetime'([\d-]+)T/u)[1] : '';
    calls.push({ since, top, skip });
    const results = serve({ since, top, skip }).map(asV2Row);
    return { content: [{ type: 'text', text: JSON.stringify({ d: { results } }) }] };
  };
  return createMcpPartnerReader({ callTool, serviceId: 'S4', pageSize: PAGE_SIZE });
}

const TRANSPORTS = [['cap', capReader], ['mcp', mcpReader]];

// A wrapped {xpr} object reads as a column named "xpr", which is how the first delta filter broke.
test('the CAP delta filter is a flat token array, like every other filter here', () => {
  const filter = changedSinceFilter('2026-07-01');
  assert.ok(Array.isArray(filter));
  assert.deepEqual(filter, [
    '(', { ref: ['LastChangeDate'] }, '>=', { val: '2026-07-01' }, ')',
    'or',
    '(', { ref: ['CreationDate'] }, '>=', { val: '2026-07-01' }, ')'
  ]);
});

test('the MCP path builds a V2 datetime filter for the same watermark', () => {
  assert.equal(
    changedSinceQuery('2026-07-01'),
    "(LastChangeDate ge datetime'2026-07-01T00:00:00') or (CreationDate ge datetime'2026-07-01T00:00:00')"
  );
  const path = indexQueryPath('', 1000, 0);
  assert.ok(path.startsWith('A_BusinessPartner?'));
  assert.ok(path.includes(`$select=${INDEX_FIELDS.join(',')}`));
  assert.ok(!path.includes('$filter='));
});

test('unwraps every envelope the MCP may answer with', () => {
  const rows = [{ BusinessPartner: '1' }];
  assert.deepEqual(unwrapRows({ content: [{ type: 'text', text: JSON.stringify({ d: { results: rows } }) }] }), rows);
  assert.deepEqual(unwrapRows({ d: { results: rows } }), rows);
  assert.deepEqual(unwrapRows({ value: rows }), rows);
  assert.deepEqual(unwrapRows(rows), rows);
  assert.deepEqual(unwrapRows(null), []);
  assert.deepEqual(unwrapRows({ content: [{ type: 'text', text: 'not json' }] }), []);
});

for (const [name, makeReader] of TRANSPORTS) {
  test(`${name}: pages through every row and stops on a short page`, async () => {
    const calls = [];
    const rows = await makeReader(calls)({ since: '' });

    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((entry) => entry.BusinessPartner), ['1', '2', '3', '4', '5']);
    assert.deepEqual(calls.map((call) => call.skip), [0, 2, 4]);
    assert.ok(calls.every((call) => call.since === ''));
  });

  test(`${name}: passes the watermark through as a delta read`, async () => {
    const calls = [];
    const rows = await makeReader(calls)({ since: '2026-07-20' });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].BusinessPartner, '6');
    assert.equal(calls[0].since, '2026-07-20');
  });

  test(`${name}: drives the name index to the same full-recall match`, async () => {
    let clock = 1000;
    const index = createNameIndex({ now: () => clock });
    const reader = makeReader([]);

    await index.refresh(reader);
    assert.equal(index.size(), 5);
    assert.equal(index.find('Alluvion')[0].partner.BusinessPartner, '1');

    clock += 300001;
    await index.refresh(reader);
    assert.equal(index.size(), 6);
    assert.deepEqual(
      index.find('Alluvion').map((hit) => hit.partner.BusinessPartner).sort(),
      ['1', '6']
    );
  });

  test(`${name}: an empty result is not an error`, async () => {
    const reader = name === 'cap'
      ? createCapPartnerReader({ service: { run: async () => [] }, entity: 'X' })
      : createMcpPartnerReader({ callTool: async () => ({ d: { results: [] } }), serviceId: 'S4' });

    assert.deepEqual(await reader({ since: '' }), []);
  });

  test(`${name}: a transport failure propagates so the index keeps its rows`, async () => {
    const boom = () => { throw new Error('transport down'); };
    const reader = name === 'cap'
      ? createCapPartnerReader({ service: { run: boom }, entity: 'X' })
      : createMcpPartnerReader({ callTool: boom, serviceId: 'S4' });

    await assert.rejects(() => reader({ since: '' }), /transport down/);
  });
}

// Raw rows differ by date encoding, so parity is asserted on what the index makes of them.
test('both transports drive the index to the same keys, watermark and matches', async () => {
  const build = async (makeReader) => {
    const index = createNameIndex();
    await index.refresh(makeReader([]));
    return {
      size: index.size(),
      watermark: index.watermark(),
      match: index.find('Alluvion').map((hit) => hit.partner.BusinessPartner)
    };
  };

  assert.deepEqual(await build(capReader), await build(mcpReader));
});

test('the index reads a V2 wire date, which is what the MCP actually returns', async () => {
  const index = createNameIndex();
  await index.refresh(async () => [
    { BusinessPartner: '1', OrganizationBPName1: 'Alluvion NV', LastChangeDate: '/Date(1785715200000)/' }
  ]);
  assert.equal(index.watermark(), '2026-08-03');
});
