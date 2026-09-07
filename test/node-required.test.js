'use strict';

// The app's own post-time required fields, evaluated at check time. Built after a change request
// passed every check and failed at activation with "CustomerTaxIndicators: enter required field(s)
// Customer, SalesOrganization, ..." -- by which point the root and earlier children had posted.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createNodeRequiredStages } = require('../srv/checks/node-required');

// The real rules, narrowed to what these tests state.
const ENTITIES = Object.freeze({
  CustomerTaxIndicators: {
    creatable: true,
    requiredCreateFields: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'DepartureCountry',
      'CustomerTaxCategory'
    ]
  },
  TaxNumbers: {
    creatable: true,
    requiredCreateFields: ['BusinessPartner', 'BPTaxType'],
    oneOfCreateFields: ['BPTaxNumber', 'BPTaxLongNumber']
  },
  Customers: { creatable: true, requiredCreateFields: ['CustomerAccountGroup'] },
  CustomerSalesArea: {
    creatable: true,
    requiredCreateFields: ['Customer', 'SalesOrganization', 'DistributionChannel', 'Division']
  },
  BusinessPartners: { creatable: false, requiredCreateFields: ['BusinessPartnerCategory'] },
  // Address-owned children: absent from RELATION_FIELDS on purpose, so `AddressID` is injected
  // through `addressChildNodes` instead. See ADDRESS_CHILD_NODES in change-request-service.js.
  AddressEmails: {
    creatable: true,
    requiredCreateFields: ['BusinessPartner', 'AddressID', 'EmailAddress']
  },
  AddressTaxNumbers: {
    creatable: true,
    requiredCreateFields: ['BusinessPartner', 'AddressID', 'BPTaxType']
  },
  // References an address, but is not OWNED by one: its AddressID is the requester's to pick.
  CustomerAddressInfo: { creatable: true, requiredCreateFields: ['Customer', 'AddressID'] }
});

const RELATION_FIELDS = Object.freeze({
  CustomerTaxIndicators: 'Customer',
  CustomerSalesArea: 'Customer',
  Customers: 'Customer',
  CustomerAddressInfo: 'Customer'
});

const ROLE_NODES = new Set(['Customers', 'Suppliers']);
const ADDRESS_CHILD_NODES = new Set(['AddressEmails', 'AddressTaxNumbers']);

const stage = () => createNodeRequiredStages({
  entities: ENTITIES,
  relationFields: RELATION_FIELDS,
  roleNodes: ROLE_NODES,
  addressChildNodes: ADDRESS_CHILD_NODES
}).validations[0];

const run = (sections) => stage().run({ root: {}, sections });

test('the reported failure is now caught before the submit', async () => {
  const findings = await run({
    CustomerTaxIndicators: [{ action: 'C', CustomerTaxCategory: 'MWST', DepartureCountry: 'BE' }]
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error', 'it blocks: the post would refuse this row');
  assert.equal(findings[0].target, 'CustomerTaxIndicators');
  assert.equal(findings[0].index, 0);
  // Customer is EXCLUDED - postToS4 resolves and injects it - so only the sales area is named.
  assert.equal(
    findings[0].message,
    'CustomerTaxIndicators: enter required field(s) SalesOrganization, DistributionChannel, Division.'
  );
});

/**
 * The one way this stage could break a working app: flagging a field postToS4 supplies itself.
 * `Customer`/`Supplier`/`BusinessPartner` are resolved from the relation at post time and are
 * legitimately absent from staging, so a row missing only those is complete as far as this goes.
 */
test('fields the post injects are never demanded', async () => {
  assert.deepEqual(await run({
    CustomerSalesArea: [{
      action: 'C', SalesOrganization: '1710', DistributionChannel: '10', Division: '00'
    }]
  }), [], 'Customer comes from the relation');

  assert.deepEqual(await run({
    TaxNumbers: [{ action: 'C', BPTaxType: 'BE0', BPTaxNumber: '0403200393' }]
  }), [], 'BusinessPartner comes from the relation');

  assert.deepEqual(await run({
    Customers: [{ action: 'C', CustomerAccountGroup: 'DEBI' }]
  }), [], 'a role node also gets BusinessPartner injected');
});

// postToS4 skips N, deletes D without a create check and sends U as an update, so validating any of
// them would refuse a row nothing rejects.
test('only rows the post will CREATE are judged', async () => {
  const incomplete = { CustomerTaxCategory: 'MWST' };
  for (const action of ['U', 'D', 'N']) {
    assert.deepEqual(
      await run({ CustomerTaxIndicators: [{ ...incomplete, action }] }), [], action
    );
  }
  // A row with no action at all is a create: that is the staging default.
  assert.equal((await run({ CustomerTaxIndicators: [incomplete] })).length, 1);
});

test('oneOf is reported separately, and satisfied by either field', async () => {
  const findings = await run({ TaxNumbers: [{ action: 'C', BPTaxType: 'BE0' }] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].message, 'TaxNumbers: enter at least one of BPTaxNumber or BPTaxLongNumber.');

  assert.deepEqual(
    await run({ TaxNumbers: [{ action: 'C', BPTaxType: 'BE0', BPTaxLongNumber: 'X' }] }), []
  );
});

test('every row is judged, and each names its own index', async () => {
  const findings = await run({
    CustomerTaxIndicators: [
      { action: 'C', CustomerTaxCategory: 'MWST', DepartureCountry: 'BE', SalesOrganization: '1710', DistributionChannel: '10', Division: '00' },
      { action: 'C', CustomerTaxCategory: 'UTXJ' }
    ]
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].index, 1, 'the second row is the short one');
});

// Same config and same emptiness test as validateMaintenanceCreate, so a row this passes cannot be
// refused by the post for a reason this could have named.
test('it mirrors the post-time rules rather than restating them', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'business-partner-service.js'), 'utf8'
  );
  assert.match(service, /enter required field\(s\) \$\{missing\.join\(', '\)\}/u);
  assert.match(service, /enter at least one of \$\{oneOf\.join\(' or '\)\}/u);

  const stageSource = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'checks', 'node-required.js'), 'utf8'
  );
  assert.match(stageSource, /enter required field\(s\) \$\{missing\.join\(', '\)\}/u);
  assert.match(stageSource, /enter at least one of \$\{oneOf\.join\(' or '\)\}/u);
  // The rules are injected, never re-listed here.
  assert.equal(/requiredCreateFields: \[/u.test(stageSource), false);
});

// It has to run on submit, not only on the check buttons: a derived row reaches the payload only
// once the requester has accepted it, so the first Check cannot see it.
test('the stage runs on every gate, submit included', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );
  // Two textual sites since submit/resubmit/data steward complete/decideRequest's approve gate
  // were consolidated into one shared runSubmitValidations (2026-08-31) - see
  // field-property-apply.test.js for the full call-site count (now four, decideRequest included).
  const uses = service.split('...nodeRequiredStages.validations').length - 1;
  assert.equal(uses, 2, 'runRequestChecks (checks) and runSubmitValidations (submit and beyond)');
  assert.equal((service.match(/runSubmitValidations\(/gu) || []).length, 4);
  assert.match(service, /entities: MAINTENANCE_ENTITIES/u);
  assert.match(service, /relationFields: RELATION_FIELDS/u);
  assert.match(service, /roleNodes: ROLE_NODES/u);
});

/**
 * Reported live 2026-09-04, right after the five address-owned child sections were added: every
 * new email, phone, fax, website and address tax number was refused for a missing `AddressID`.
 *
 * It cannot be supplied at check time and is not meant to be. A brand new address has no S/4 key
 * until the moment it is created, so the child is linked to its parent through
 * `__addressKey`/`address_ID` and `postToS4` backfills the real `AddressID` per row from
 * `addressIdByStagedRow`. These sections are deliberately absent from `RELATION_FIELDS` -- their
 * relation is not one value resolved once for the whole section -- which is exactly why the
 * `relationFields[section]` fallback did not cover them.
 */
test('an address-owned child never has to carry AddressID', async () => {
  assert.deepEqual(
    await run({ AddressEmails: [{ action: 'C', EmailAddress: 'info@alluvion.eu' }] }),
    [],
    'a new email on a brand new address is complete without an AddressID'
  );
  assert.deepEqual(
    await run({ AddressTaxNumbers: [{ action: 'C', BPTaxType: 'BE0' }] }),
    [],
    'and so is an address-dependent tax number'
  );
});

/**
 * The injection is scoped to the five address-OWNED sections, not to the field name. Several
 * customer sections also require an `AddressID`, and theirs is a real requirement the requester
 * picks from the addresses on the request -- nothing backfills it.
 */
test('AddressID is still demanded on a section that merely references an address', async () => {
  const findings = await run({ CustomerAddressInfo: [{ action: 'C' }] });
  assert.equal(findings.length, 1);
  // Customer is injected via RELATION_FIELDS; AddressID is not.
  assert.equal(findings[0].message, 'CustomerAddressInfo: enter required field(s) AddressID.');
});

test("the child's own required fields are still enforced", async () => {
  const findings = await run({ AddressEmails: [{ action: 'C' }] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].message, 'AddressEmails: enter required field(s) EmailAddress.');
});
