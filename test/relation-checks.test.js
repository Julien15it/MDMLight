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


// ---------------------------------------------------------------------------
// relation_role_requested - customer/supplier data with no role that creates it
// ---------------------------------------------------------------------------

/**
 * Reported live 2026-09-08: a request carrying supplier data but no supplier role was accepted,
 * routed, approved, and then failed at ACTIVATION. `relation_parent_exists` above cannot catch it -
 * a create satisfies that stage by carrying a `Suppliers` section, and it is the ROLE, not the
 * section, that makes CVI create the vendor master.
 */
const roleStage = ({ requestedRelations, resolve = async () => null, businessPartner = null }) =>
  createRelationStages({
    resolve, businessPartner, relationFields: FIELDS, roleNodes: ROLE_NODES, requestedRelations
  }).validations[1];

const relations = (...names) => async () => new Set(names);

test('supplier data with no supplier role blocks the submit', async () => {
  const messages = await roleStage({ requestedRelations: relations() }).run(payload({
    Suppliers: [{ SupplierAccountGroup: 'LIEF' }],
    SupplierPurchasingOrg: [{ PurchasingOrganization: '1000' }],
    BusinessPartnerRoles: [{ BusinessPartnerRole: 'FLCU01' }]
  }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 'error');
  assert.equal(messages[0].target, 'Suppliers');
  assert.match(messages[0].message, /Suppliers, SupplierPurchasingOrg carry supplier data/u);
  assert.match(messages[0].message, /no business partner role on this request creates a supplier/u);
});

test('the role S/4 says creates the account is what clears it', async () => {
  assert.deepEqual(
    await roleStage({ requestedRelations: relations('Supplier') }).run(payload({
      Suppliers: [{ SupplierAccountGroup: 'LIEF' }],
      BusinessPartnerRoles: [{ BusinessPartnerRole: 'FLVN01' }]
    })),
    []
  );
});

test('customer and supplier are judged separately, and both can be missing at once', async () => {
  const messages = await roleStage({ requestedRelations: relations() }).run(payload({
    Customers: [{ CustomerAccountGroup: 'DEBI' }],
    Suppliers: [{ SupplierAccountGroup: 'LIEF' }]
  }));

  assert.deepEqual(
    messages.map((message) => message.target).sort(), ['Customers', 'Suppliers']
  );
  assert.match(messages.find((m) => m.target === 'Customers').message, /creates a customer/u);
});

test('one side satisfied leaves only the other reported', async () => {
  const messages = await roleStage({ requestedRelations: relations('Customer') }).run(payload({
    Customers: [{ CustomerAccountGroup: 'DEBI' }],
    Suppliers: [{ SupplierAccountGroup: 'LIEF' }]
  }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, 'Suppliers');
});

test('a request carrying no customer or supplier data says nothing, and asks S/4 nothing', async () => {
  let asked = 0;
  assert.deepEqual(
    await roleStage({
      requestedRelations: async () => { asked += 1; return new Set(); }
    }).run(payload({ Addresses: [{ Country: 'BE' }] })),
    []
  );
  assert.equal(asked, 0, 'the configuration is not even read when nothing depends on it');
});

// A row on its way out is not data the partner will carry - the same `liveRows` rule cvi-checks.js
// applies to the roles themselves.
test('a section whose only row is being deleted carries no data', async () => {
  assert.deepEqual(
    await roleStage({ requestedRelations: relations() }).run(payload({
      Suppliers: [{ action: 'D', SupplierAccountGroup: 'LIEF' }]
    })),
    []
  );
});

/**
 * A partner that already HAS the vendor master already has the role that made it. Nothing for this
 * request to ask for, and the lookup is the one `relation_parent_exists` already made.
 */
test('a change request against a partner that already has the record is silent', async () => {
  let asked = 0;
  const messages = await roleStage({
    businessPartner: '4711',
    resolve: async () => { asked += 1; return '99'; },
    requestedRelations: relations()
  }).run(payload({ SupplierPurchasingOrg: [{ PurchasingOrganization: '1000' }] }));

  assert.deepEqual(messages, []);
  assert.equal(asked, 1);
});

test('a change request against a partner with no record still needs the role', async () => {
  const messages = await roleStage({
    businessPartner: '4711',
    resolve: async () => null,
    requestedRelations: relations()
  }).run(payload({ Suppliers: [{ SupplierAccountGroup: 'LIEF' }] }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 'error');
});

/**
 * The standing rule, and the posture `cvi_configuration` already takes: a configuration that could
 * not be READ must not block every submit - but "no role creates a supplier" and "nobody could find
 * out" must not read the same either.
 */
test('a CVI configuration that could not be read warns instead of blocking', async () => {
  const messages = await roleStage({
    requestedRelations: async () => { throw new Error('destination unreachable'); }
  }).run(payload({ Suppliers: [{ SupplierAccountGroup: 'LIEF' }] }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 'warning');
  assert.match(messages[0].message, /could not be read \(destination unreachable\)/u);
});

// A relation with no role node of its own is a different question entirely - BusinessPartnerContacts
// hangs off the partner being maintained, and no role creates or fails to create one.
test('a relation the partner itself satisfies is outside this stage', async () => {
  const stages = createRelationStages({
    resolve: async () => null,
    businessPartner: null,
    relationFields: CONTACT_FIELDS,
    roleNodes: new Set(),
    requestedRelations: relations()
  });
  assert.deepEqual(
    await stages.validations[1].run(payload({ BusinessPartnerContacts: [{ BusinessPartnerPerson: '5001' }] })),
    []
  );
});

/**
 * `relation_parent_exists` must stay `validations[0]` - the tests above reach it that way. And a
 * caller that supplies no resolver gets no stage at all rather than one that silently passes.
 */
test('the new stage is appended, and is not built without its resolver', () => {
  const withResolver = createRelationStages({
    resolve: async () => null, relationFields: FIELDS, roleNodes: ROLE_NODES,
    businessPartner: null, requestedRelations: relations()
  });
  assert.deepEqual(
    withResolver.validations.map((validation) => validation.name),
    ['relation_parent_exists', 'relation_role_requested']
  );

  const without = createRelationStages({
    resolve: async () => null, relationFields: FIELDS, roleNodes: ROLE_NODES, businessPartner: null
  });
  assert.deepEqual(without.validations.map((validation) => validation.name), ['relation_parent_exists']);
});
