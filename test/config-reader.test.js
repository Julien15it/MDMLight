'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readAll, readAllOf, PAGE_SIZE, MAX_ROWS } = require('../srv/checks/config-reader');

const rows = (from, count) => Array.from({ length: count }, (_, i) => ({ id: from + i }));

/**
 * A remote service that pages the way the real one does: it answers at most `serverPage` rows
 * however large a `$top` it is handed. That is the whole bug -- 100 came back, 100 was believed.
 */
function service(total, serverPage = 100) {
  const calls = [];
  return {
    calls,
    async run(query) {
      const limit = query.SELECT.limit;
      const top = Number(limit.rows.val);
      const skip = Number(limit.offset?.val || 0);
      calls.push({ top, skip });
      return rows(skip, Math.max(0, Math.min(total - skip, top, serverPage)));
    }
  };
}

test('every page is read, not just the first', async () => {
  const remote = service(414);
  const read = await readAll(remote, 'DerPartnerFunctionAccGrp');
  assert.equal(read.length, 414);
  // Contiguous and in order: a repeated or skipped row would mean the offset is wrong.
  assert.deepEqual(read.map((row) => row.id), rows(0, 414).map((row) => row.id));
});

/**
 * The trap this reader exists to avoid. `readAllPages` in business-partner-service.js stops on a
 * SHORT page, which is correct when the caller sets the page size -- and wrong here: the read that
 * lost account group DEBI was short (100 of 414) precisely because the server capped it.
 */

// skip advances by what ARRIVED, never by pageSize; the server's page size is its own business.
test('the offset follows the rows received, not the page size asked for', async () => {
  const remote = service(250, 100);
  await readAll(remote, 'X');
  assert.deepEqual(remote.calls.map((call) => call.skip), [0, 100, 200, 250]);
  assert.ok(remote.calls.every((call) => call.top === PAGE_SIZE));
});

// One extra round trip, deliberately: an exact multiple of the page size cannot be recognised any
// other way, and against a 60s cache the cost is nothing.
test('it ends on an empty page, including when the total is an exact multiple', async () => {
  const remote = service(200, 100);
  const read = await readAll(remote, 'X');
  assert.equal(read.length, 200);
  assert.deepEqual(remote.calls.map((call) => call.skip), [0, 100, 200]);
});

// A service that ignores $skip would otherwise spin forever. The cap is a backstop, not a limit.
test('a service that never advances is stopped by the safety cap', async () => {
  let asked = 0;
  const stuck = { async run() { asked += 1; return rows(0, 100); } };
  const read = await readAll(stuck, 'X', { maxRows: 300 });
  assert.equal(read.length, 300);
  assert.equal(asked, 3);
});

test('readAllOf keeps the order it was given', async () => {
  const remote = {
    async run(query) {
      const entity = query.SELECT.from.ref[0];
      const skip = Number(query.SELECT.limit.offset?.val || 0);
      const sizes = { A: 5, B: 150, C: 0 };
      return rows(skip, Math.max(0, Math.min(sizes[entity] - skip, 100)));
    }
  };
  const [a, b, c] = await readAllOf(remote, ['A', 'B', 'C']);
  assert.equal(a.length, 5);
  assert.equal(b.length, 150);
  assert.equal(c.length, 0);
});

/**
 * The reason this is a shared module and not a local helper: both files had the same bug, and only
 * one of them had a symptom anybody noticed. `CviBusinessPartnerRoles` decides account groups and
 * role categories, so a truncated read there is a wrong verdict on a check that blocks a submit.
 */
test('no check reads its customizing with a bare unpaged SELECT any more', () => {
  // Matched across newlines: derivation-checks.js wraps its entity list, and pinning the call onto
  // one line made a reformat read as a reintroduced bug.
  const expected = {
    'cvi-checks.js': ['CviBusinessPartnerRoles', 'CviSyncDirections'],
    'derivation-checks.js': ['DerPartnerFunctionAccGrp', 'DerSupplierFunctionAccGrp']
  };
  for (const [file, entities] of Object.entries(expected)) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'srv', 'checks', file), 'utf8');
    assert.match(source, /await readAllOf\(\s*service,/u, `${file} pages its reads`);
    for (const entity of entities) {
      assert.ok(source.includes(`'${entity}'`), `${file} still reads ${entity}`);
    }
    assert.equal(
      /service\.run\(cds\.ql\.SELECT\.from\(/u.test(source), false,
      `${file} has no unpaged remote read left`
    );
  }
});
