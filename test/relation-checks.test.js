'use strict';

/**
 * The customer/supplier number a child node hangs off is CVI's answer - CVI_CUST_LINK and
 * CVI_VEND_LINK, exposed as to_Customer / to_Supplier. postToS4 asks for it while posting,
 * which is after the approval, so a request whose parent never existed used to be approved
 * first and fail second. These assert that the question is asked at submit instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRelationStages } = require('../srv/checks/relation-checks');
const { RELATION_FIELDS } = require('../srv/change-request-service')._internals || {};

const FIELDS = RELATION_FIELDS || {
  Customers: 'Customer', Suppliers: 'Supplier',
  CustomerCompany: 'Customer', SupplierCompany: 'Supplier'
};
const ROLE_NODES = new Set(['Customers', 'Suppliers']);

const stage = ({ resolve, businessPartner }) => createRelationStages({
  resolve, businessPartner, relationFields: FIELDS, roleNodes: ROLE_NODES
}).validations[0];

const payload = (sections, root = {}) => ({ root, sections });

test('a child node with no parent anywhere blocks the submit', async () => {
  const messages = await stage({
    businessPartner: '4711',
    resolve: async () => null
  }).run(payload({ CustomerCompany: [{ CompanyCode: '1000' }] }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 'error');
  assert.match(messages[0].message, /CustomerCompany/u);
  assert.match(messages[0].message, /has none/u);
  assert.equal(messages[0].target, 'CustomerCompany');
});

test('the request creating the parent itself is enough', async () => {
  let asked = 0;
  const messages = await stage({
    businessPartner: '4711',
    resolve: async () => { asked += 1; return null; }
  }).run(payload({
    Customers: [{ CustomerAccountGroup: 'DEBI' }],
    CustomerCompany: [{ CompanyCode: '1000' }]
  }));

  assert.deepEqual(messages, []);
  // Nothing to look up: the parent arrives in the same run, so S/4 is not asked at all.
  assert.equal(asked, 0);
});

test('a parent that already exists in S4 is enough', async () => {
  const messages = await stage({
    businessPartner: '4711',
    resolve: async () => '54'
  }).run(payload({ CustomerCompany: [{ CompanyCode: '1000' }] }));

  assert.deepEqual(messages, []);
});

test('a create with no role node is refused before it is routed', async () => {
  const messages = await stage({
    businessPartner: null,
    resolve: async () => { throw new Error('must not be asked for a create'); }
  }).run(payload({ SupplierCompany: [{ CompanyCode: '1000' }] }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 'error');
  assert.match(messages[0].message, /Suppliers section/u);
});

test('an unreachable S4 warns rather than blocks', async () => {
  const messages = await stage({
    businessPartner: '4711',
    resolve: async () => { throw new Error('destination unavailable'); }
  }).run(payload({ CustomerCompany: [{ CompanyCode: '1000' }] }));

  assert.equal(messages.length, 1);
  // The one thing this must never do: turn an outage into a blocked submit, or into silence.
  assert.equal(messages[0].severity, 'warning');
  assert.match(messages[0].message, /destination unavailable/u);
});

test('each relation is looked up once, however many children hang off it', async () => {
  let asked = 0;
  const messages = await stage({
    businessPartner: '4711',
    resolve: async () => { asked += 1; return '54'; }
  }).run(payload({
    CustomerCompany: [{ CompanyCode: '1000' }],
    CustomerSalesArea: [{ SalesOrganization: '1710' }],
    SupplierCompany: [{ CompanyCode: '1000' }]
  }));

  assert.deepEqual(messages, []);
  assert.equal(asked, 2, 'Customer and Supplier, not once per node');
});

/**
 * Every section this stage's own `Object.entries(sections)` loop reads is required to be an
 * array - `Customers`/`Suppliers` are `!config.many` in PAYLOAD_NODES, so a server-side reader that
 * reconstructs a section as a bare object (or leaves it null) rather than wrapping it in a
 * one-element array is invisible here, whatever it actually holds.
 *
 * This bit `decideRequest`'s approve-time re-validation (2026-08-31): `loadStagedPayload` used to
 * mirror `getRequestPayload`'s own `config.many ? clean : (clean[0] || null)` shape, which is safe
 * there only because `_loadStagedRequest` on the client always re-wraps a bare section into an
 * array before it is staged into `state.sections` - a server reader that feeds this stage directly,
 * with no client in between, must do that wrapping itself. Reported live as "SupplierPurchasingOrg
 * needs a Supplier record, and a new business partner has none" on an approve for a request that
 * plainly had a Suppliers row - because that row was a bare object, not `[row]`, so `!Array.isArray`
 * skipped it and it never made it into `broughtAlong`.
 */
test('a role node section must be an array to be seen as bringing its own parent along', async () => {
  const asBareObject = await stage({
    businessPartner: null,
    resolve: async () => { throw new Error('must not be asked - a create has no businessPartner'); }
  }).run(payload({
    Suppliers: { SupplierAccountGroup: 'KRED' },
    SupplierPurchasingOrg: [{ PurchasingOrganization: '1000' }]
  }));
  assert.equal(asBareObject.length, 1, 'a bare-object Suppliers section is invisible to this stage');
  assert.match(asBareObject[0].message, /SupplierPurchasingOrg needs a Supplier record/u);

  const asArray = await stage({
    businessPartner: null,
    resolve: async () => { throw new Error('must not be asked - a create has no businessPartner'); }
  }).run(payload({
    Suppliers: [{ SupplierAccountGroup: 'KRED' }],
    SupplierPurchasingOrg: [{ PurchasingOrganization: '1000' }]
  }));
  assert.deepEqual(asArray, [], 'wrapped in an array, the same row is correctly seen');
});

/**
 * Reported live 2026-09-04, on a create: *"BusinessPartnerContacts needs a BusinessPartnerCompany
 * record, and a new business partner has none. Add the **undefined** section to this request."*
 *
 * `A_BusinessPartnerContact` spells its relation `BusinessPartnerCompany`, and that IS the partner
 * being maintained -- not a separate customer or vendor master. So there is no section to add, the
 * root of the same request creates the parent, and `RELATION_ROLE_NODE` rightly has no entry to
 * name. Two bugs in one sentence: a blocking error that should never have fired, and a hole in the
 * text where the missing map entry was interpolated.
 *
 * Stated with its own relationFields rather than the service's, so the rule is readable here even
 * if RELATION_FIELDS later changes shape.
 */
const CONTACT_FIELDS = { BusinessPartnerContacts: 'BusinessPartnerCompany' };

const contactStage = ({ businessPartner, resolve = async () => null }) => createRelationStages({
  resolve, businessPartner, relationFields: CONTACT_FIELDS, roleNodes: new Set()
}).validations[0];

test('a relation the partner itself satisfies is not demanded on a create', async () => {
  let asked = false;
  const messages = await contactStage({
    businessPartner: null,
    resolve: async () => { asked = true; return null; }
  }).run(payload({ BusinessPartnerContacts: [{ BusinessPartnerPerson: '5001' }] }));

  assert.deepEqual(messages, [], 'the request creates the partner these contacts hang off');
  assert.equal(asked, false, 'and there is nothing to look up, so S/4 is never asked');
});

test('the same relation is not demanded on a change either', async () => {
  const messages = await contactStage({
    businessPartner: '4711',
    resolve: async () => null
  }).run(payload({ BusinessPartnerContacts: [{ BusinessPartnerPerson: '5001' }] }));

  assert.deepEqual(messages, [], 'the partner is its own parent, whatever a lookup would answer');
});

// The guard is scoped to relations with no role node, not switched off generally.
test('a customer child is still blocked on a create with no Customers section', async () => {
  const messages = await stage({
    businessPartner: null,
    resolve: async () => null
  }).run(payload({ CustomerCompany: [{ CompanyCode: '1000' }] }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 'error');
  assert.match(messages[0].message, /Add the Customers section to this request/u);
  assert.doesNotMatch(messages[0].message, /undefined/u);
});

