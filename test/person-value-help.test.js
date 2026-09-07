'use strict';

/**
 * The contact-person value help must offer PEOPLE, and the CDS projection alone did not make it so.
 *
 * `BusinessPartnerPersons` is `A_BusinessPartner as projection on ... where
 * BusinessPartnerCategory = '1'`, and the picker showed organisations and groups all the same
 * (reported live 2026-09-07). A filtered projection over a REMOTE entity is not reliably pushed
 * into the outgoing `$filter`, and this is the only filtered projection in the whole facade - every
 * other value help reads a `ZSRVB_MDMLIGHT_VH` code list that is already exactly the right set,
 * which is why nothing else ever depended on this working.
 *
 * So the condition is added by this app's own code, in the same CQN shape
 * `applyBusinessPartnerSearch` uses, and the projection is deliberately kept as well.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyBusinessPartnerSearch,
  restrictReadTo
} = require('../srv/business-partner-service')._internals;

const ROOT = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(ROOT, 'srv', 'business-partner-service.js'), 'utf8');
const cds = fs.readFileSync(path.join(ROOT, 'srv', 'business-partner-service.cds'), 'utf8');

test('the restriction is the whole WHERE when the read had none', () => {
  const query = { SELECT: { from: { ref: ['BusinessPartnerPersons'] } } };
  restrictReadTo(query, 'BusinessPartnerCategory', '1');
  assert.deepEqual(query.SELECT.where, [
    { ref: ['BusinessPartnerCategory'] }, '=', { val: '1' }
  ]);
});

/**
 * The picker sends its own filter as the user types, and a restriction that REPLACED it would show
 * every person for any search - or, the other way round, be dropped the moment somebody typed.
 */
test('an existing WHERE is kept and ANDed, not replaced', () => {
  const typed = [{ ref: ['LastName'] }, '=', { val: 'Eylenbosch' }];
  const query = { SELECT: { from: { ref: ['BusinessPartnerPersons'] }, where: typed } };
  restrictReadTo(query, 'BusinessPartnerCategory', '1');

  assert.deepEqual(query.SELECT.where, [
    { xpr: typed },
    'and',
    { xpr: [{ ref: ['BusinessPartnerCategory'] }, '=', { val: '1' }] }
  ]);
});

/** The same shape applyBusinessPartnerSearch produces, so the two compose in either order. */
test('it composes with the $search rewrite', () => {
  const query = {
    SELECT: { from: { ref: ['BusinessPartnerPersons'] }, search: [{ val: 'alluvion' }] }
  };
  applyBusinessPartnerSearch(query);
  const searched = query.SELECT.where;
  assert.ok(searched && searched.length, 'the search became a where');

  restrictReadTo(query, 'BusinessPartnerCategory', '1');
  assert.deepEqual(query.SELECT.where[0], { xpr: searched });
  assert.equal(query.SELECT.where[1], 'and');
  assert.equal(query.SELECT.where[2].xpr[0].ref[0], 'BusinessPartnerCategory');
});

test('a query it cannot read is handed back untouched, never half-filtered', () => {
  // An INSERT/UPDATE-shaped or empty query has no SELECT. Returning it unchanged is right; adding
  // a where to something that is not a read would be worse than not restricting it.
  assert.deepEqual(restrictReadTo({}, 'BusinessPartnerCategory', '1'), {});
  assert.equal(restrictReadTo(null, 'BusinessPartnerCategory', '1'), null);
});

test('the handler is registered on the person value help, and on nothing else', () => {
  assert.match(
    service,
    /this\.before\('READ', 'BusinessPartnerPersons', \(req\) => \{\s*restrictReadTo\(req\.query, 'BusinessPartnerCategory', '1'\);/u,
    'the contact-person read is restricted server-side'
  );
  assert.equal(
    (service.match(/restrictReadTo\(req\.query/gu) || []).length, 1,
    'exactly one read is restricted - BusinessPartners itself must stay unfiltered, or the search '
    + 'list and every object page would only ever show people'
  );
});

/**
 * Kept on purpose: it documents the intent where the entity is declared, it is what makes the
 * served metadata honest, and it costs nothing if a later CAP does push it down. Removing it and
 * relying only on the handler would leave the CDS claiming a superset of what the service returns.
 */
test('the CDS projection still carries the same condition', () => {
  assert.match(cds, /BusinessPartnerPersons as projection on S4\.A_BusinessPartner\s*\n\s*where BusinessPartnerCategory = '1';/u);
});
