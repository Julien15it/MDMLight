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
  // Address-owned child (Email/Phone/Fax/Website/Tax Number) - AddressID is required for S/4 to
  // accept the row, but postToS4 resolves and injects it PER ROW from whichever staged address it
  // belongs to (never known up front, unlike Customer/Supplier's single relation value), so it must
  // never be demanded here.
  AddressEmails: {
    creatable: true,
    requiredCreateFields: ['BusinessPartner', 'AddressID', 'EmailAddress']
  }
});

const RELATION_FIELDS = Object.freeze({
  CustomerTaxIndicators: 'Customer',
  CustomerSalesArea: 'Customer',
  Customers: 'Customer'
});

const ROLE_NODES = new Set(['Customers', 'Suppliers']);
const ADDRESS_CHILD_NODES = new Set(['AddressEmails']);

const stage = () => createNodeRequiredStages({
  entities: ENTITIES, relationFields: RELATION_FIELDS, roleNodes: ROLE_NODES,
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

/**
 * Reported live 2026-09-04, right after "Address-owned children" shipped: creating a brand new
 * address together with its own email/phone/etc. in the same request failed Check with
 * "AddressEmails: enter required field(s) AddressID." - exactly the row this feature exists to
 * accept, since AddressID cannot be known until the address itself is created. AddressID is real
 * S/4 API data postToS4 resolves and injects PER ROW (from whichever staged address a child
 * belongs to), the same way Customer/Supplier's single relation value already is - it must never
 * be demanded here just because it has no relationFields entry of its own.
 */
test('an address-owned child never has its AddressID demanded, even brand new', async () => {
  assert.deepEqual(await run({
    AddressEmails: [{ action: 'C', EmailAddress: 'info@example.com' }]
  }), [], 'AddressID comes from the address this row belongs to, resolved at post time');
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
