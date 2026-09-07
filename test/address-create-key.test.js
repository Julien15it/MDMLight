'use strict';

/**
 * An address create has to answer with its new `AddressID`, because every address-owned child in
 * the same post resolves its parent through it (`addressIdByStagedRow` in change-request-service).
 *
 * Reported live 2026-09-07: BP 639 was created and the post then failed with *"Cannot post
 * AddressEmails: its own address was not created in this run."* The root create goes through
 * `s4.run(INSERT)` and demonstrably answers with its `BusinessPartner`, but an address must be
 * POSTed through the `to_BusinessPartnerAddress` navigation (SAP KBA 3109298, for the XXDEFAULT
 * usage) and that raw `s4.send` response is a shape nothing in this app had ever read a field out
 * of - the recording was written on the assumption it carried the key.
 *
 * So the id is now DERIVED: the partner's address ids are captured before the POST, and the one
 * that is there afterwards and was not there before is the address just created. Exactly one id can
 * be new, so this is a derivation rather than a heuristic - and anything else refuses to pick.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBusinessPartnerAddress,
  addressIdsOf,
  normalizeRemoteRows
} = require('../srv/business-partner-service')._internals;

/**
 * A stand-in S/4. `reads` is answered in order, so a before/after pair can differ; the last entry
 * is repeated once exhausted. `post` is what the navigation POST answers.
 */
const s4With = ({ reads, post }) => {
  const state = { reads: [...reads], sent: null, runs: 0 };
  return {
    state,
    run: async () => {
      state.runs += 1;
      return state.reads.length > 1 ? state.reads.shift() : state.reads[0];
    },
    send: async (request) => {
      state.sent = request;
      return typeof post === 'function' ? post(request) : post;
    }
  };
};

test('normalizeRemoteRows reads every shape the remote answers with', () => {
  const row = { AddressID: '1' };
  assert.deepEqual(normalizeRemoteRows([row]), [row], 'a plain array');
  assert.deepEqual(normalizeRemoteRows({ value: [row] }), [row], 'V4');
  assert.deepEqual(normalizeRemoteRows({ d: { results: [row] } }), [row], 'V2 collection');
  assert.deepEqual(normalizeRemoteRows({ d: row }), [row], 'V2 single');
  // The one that mattered: a bare object is ONE row, not zero.
  assert.deepEqual(normalizeRemoteRows(row), [row], 'a bare single object');
  for (const empty of [null, undefined, '', 0]) {
    assert.deepEqual(normalizeRemoteRows(empty), [], String(empty));
  }
});

test('addressIdsOf collects the ids and drops the blanks', async () => {
  const s4 = s4With({ reads: [[{ AddressID: '1' }, { AddressID: '' }, { AddressID: '2' }, {}]] });
  assert.deepEqual([...await addressIdsOf(s4, '639')].sort(), ['1', '2']);
});

test('the AddressID the POST answers with is used as it stands, with no second read', async () => {
  const s4 = s4With({ reads: [[]], post: { BusinessPartner: '639', AddressID: '7' } });
  const created = await createBusinessPartnerAddress(s4, { BusinessPartner: '639', StreetName: 'Dorpstraat' });

  assert.equal(created.AddressID, '7');
  assert.equal(s4.state.runs, 1, 'only the baseline read, never a re-read');
});

test('a POST that answers without the key still yields the new AddressID', async () => {
  // Before: one address. After: that one plus the new one. The difference is the answer.
  const s4 = s4With({
    reads: [[{ AddressID: '1' }], [{ AddressID: '1' }, { AddressID: '2' }]],
    post: (request) => request.data
  });
  const created = await createBusinessPartnerAddress(s4, { BusinessPartner: '639', StreetName: 'Nieuwstraat' });

  assert.equal(created.AddressID, '2', 'derived from the set difference');
  assert.equal(s4.state.runs, 2, 'the re-read is only paid for when the response gave nothing');
  // The partner already had an address, so this one must NOT claim the standard usage.
  assert.equal(created.to_AddressUsage, undefined);
});

test("the FIRST address still gets XXDEFAULT, and a later one does not", async () => {
  const first = s4With({ reads: [[]], post: (request) => request.data });
  await createBusinessPartnerAddress(first, { BusinessPartner: '639', StreetName: 'Dorpstraat' });
  assert.equal(first.state.sent.path, "/A_BusinessPartner('639')/to_BusinessPartnerAddress");
  assert.deepEqual(first.state.sent.data.to_AddressUsage, [
    { AddressUsage: 'XXDEFAULT', StandardUsage: true }
  ]);

  // A bare single object is the on-premise V2 answer for one row - it means the partner HAS an
  // address, so no usage. Read as zero rows this would wrongly claim the standard usage again.
  const later = s4With({ reads: [{ AddressID: '1' }], post: (request) => request.data });
  await createBusinessPartnerAddress(later, { BusinessPartner: '639', StreetName: 'Nieuwstraat' });
  assert.equal(later.state.sent.data.to_AddressUsage, undefined);
});

/**
 * Never a guess. Attaching an email to the wrong address is worse than the caller reporting it has
 * no AddressID to attach one to - and postToS4's own message says exactly that.
 */
test('an ambiguous answer picks nothing', async () => {
  for (const [what, after] of [
    ['nothing new appeared', [{ AddressID: '1' }]],
    ['two addresses appeared at once', [{ AddressID: '1' }, { AddressID: '2' }, { AddressID: '3' }]]
  ]) {
    const s4 = s4With({
      reads: [[{ AddressID: '1' }], after],
      post: (request) => request.data
    });
    const created = await createBusinessPartnerAddress(s4, { BusinessPartner: '639', StreetName: 'X' });
    assert.equal(created.AddressID, undefined, what);
  }
});

test('an address with no business partner is refused before anything is sent', async () => {
  const s4 = s4With({ reads: [[]], post: {} });
  await assert.rejects(
    () => createBusinessPartnerAddress(s4, { StreetName: 'Dorpstraat' }),
    (error) => error.statusCode === 400 && /business partner number/u.test(error.message)
  );
  assert.equal(s4.state.sent, null, 'nothing reached S/4');
});
