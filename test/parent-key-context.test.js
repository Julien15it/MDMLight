'use strict';

/**
 * The parent's keys travel in the URL, the node's own fields travel in the body, and
 * `sanitizeEntityPayload` only ever knew about the second of those.
 *
 * Reported live 2026-09-07: a create passed every check and then failed at activation for a
 * missing number. `sanitizeEntityPayload` keeps only what is an element of the node's OWN entity,
 * and four of the five address-owned children have no `BusinessPartner` element at all
 * (`A_AddressEmailAddress` and its Phone/Fax/HomePageURL siblings key on
 * `AddressID/Person/OrdinalNumber`) - while the parent they are posted under,
 * `A_BusinessPartnerAddress`, keys on `BusinessPartner` AND `AddressID`. So the one value that
 * could address the parent was dropped on the way out, and the create asked for it back.
 *
 * `A_BusinessPartnerContact` is the same defect on a different node: it spells the partner
 * `BusinessPartnerCompany`, has no `BusinessPartner` element either, and `postToS4` only ever
 * stamped `BusinessPartner` for a role node - so contacts never had one to drop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cds = require('@sap/cds');

const {
  MAINTENANCE_ENTITIES,
  businessPartnerNavigationPath,
  parentKeyContext,
  createBusinessPartnerChild,
  sanitizeEntityPayload
} = require('../srv/business-partner-service')._internals;

const ROOT = path.join(__dirname, '..');
const changeRequestService = fs.readFileSync(path.join(ROOT, 'srv', 'change-request-service.js'), 'utf8');
const maintenanceController = fs.readFileSync(path.join(
  ROOT, 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
  'controller', 'BusinessPartnerMaintenance.controller.js'
), 'utf8');

/** The five address-owned children, and the one of them that escaped the bug. */
const ADDRESS_CHILDREN = ['AddressEmails', 'AddressPhoneNumbers', 'AddressFaxNumbers', 'AddressHomePageURLs'];
const CARRIES_ITS_OWN_PARTNER = 'AddressTaxNumbers';

test('parentKeyContext recovers exactly the parent keys, from the raw row', () => {
  assert.deepEqual(
    parentKeyContext(MAINTENANCE_ENTITIES.AddressEmails, {
      BusinessPartner: '1000', AddressID: '77', EmailAddress: 'info@alluvion.eu'
    }),
    { BusinessPartner: '1000', AddressID: '77' },
    'the keys that address the parent, and nothing else off the row'
  );
});

test('a node with no parentKeyFields still resolves to BusinessPartner', () => {
  assert.deepEqual(
    parentKeyContext(MAINTENANCE_ENTITIES.BusinessPartnerContacts, {
      BusinessPartner: '1000', BusinessPartnerCompany: '1000', BusinessPartnerPerson: '2000'
    }),
    { BusinessPartner: '1000' },
    'the default parent is A_BusinessPartner, keyed by BusinessPartner'
  );
});

test('a parent key absent from the row is simply not claimed', () => {
  assert.deepEqual(parentKeyContext(MAINTENANCE_ENTITIES.AddressEmails, { EmailAddress: 'x@y.z' }), {});
});

test('every address-owned child is addressed under its own address, body unchanged', async () => {
  for (const section of ADDRESS_CHILDREN) {
    const configuration = MAINTENANCE_ENTITIES[section];
    const row = { BusinessPartner: '1000', AddressID: '77', Person: '', OrdinalNumber: '' };
    const addressed = { ...parentKeyContext(configuration, row), ...row };

    assert.equal(
      businessPartnerNavigationPath(configuration, addressed),
      `/A_BusinessPartnerAddress(BusinessPartner='1000',AddressID='77')/${configuration.navigation}`,
      section
    );

    let sent;
    await createBusinessPartnerChild(
      { send: async (request) => { sent = request; return {}; } },
      configuration,
      { AddressID: '77' },
      addressed
    );
    assert.equal(sent.path, `/A_BusinessPartnerAddress(BusinessPartner='1000',AddressID='77')/${configuration.navigation}`);
    assert.deepEqual(sent.data, { AddressID: '77' }, `${section}: the body stays the node's own fields`);
  }
});

test('the four children genuinely have no BusinessPartner to sanitize, and the fifth does', async () => {
  const model = await cds.load(path.join(ROOT, 'srv'));

  for (const section of ADDRESS_CHILDREN) {
    const entity = model.definitions[`BusinessPartnerService.${section}`];
    assert.ok(entity, `${section} is exposed`);
    assert.deepEqual(
      sanitizeEntityPayload({ BusinessPartner: '1000', AddressID: '77' }, entity, { isCreate: true }),
      { AddressID: '77' },
      `${section}: BusinessPartner is not an element, so it cannot survive the body`
    );
  }

  const taxNumbers = model.definitions[`BusinessPartnerService.${CARRIES_ITS_OWN_PARTNER}`];
  assert.deepEqual(
    sanitizeEntityPayload({ BusinessPartner: '1000', AddressID: '77' }, taxNumbers, { isCreate: true }),
    { BusinessPartner: '1000', AddressID: '77' },
    'A_BusPartAddrDepdntTaxNmbr keys on BusinessPartner, which is why it never hit this'
  );
});

test('postToS4 stamps BusinessPartner for every node, not just a role node', () => {
  assert.match(
    changeRequestService,
    /\/\/ Unconditional rather than per node[\s\S]{0,400}?\n\s*data\.BusinessPartner = businessPartner;/u,
    'the role-node-only condition is gone, and says why it is safe to drop'
  );
  assert.doesNotMatch(
    changeRequestService,
    /if \(isRoleNode\) data\.BusinessPartner = businessPartner;/u,
    'nothing is left that would leave a contact or an address child without one'
  );
});

/**
 * The same spelling, one layer up: the screen resolves a section's relation value from a map keyed
 * by relationField, and `BusinessPartnerCompany` was not in it - so a change request read its
 * contacts as "the role was never assigned" and showed the section empty.
 */
test('the screen resolves a relation value for BusinessPartnerCompany on both read paths', () => {
  const maps = maintenanceController.match(/var relationValues = \{[\s\S]*?\};/gu) || [];
  assert.equal(maps.length, 2, 'the load path and the diff baseline');
  for (const map of maps) {
    assert.match(map, /BusinessPartnerCompany: businessPartner/u, map);
  }
});

/**
 * A create flips the staged row to 'U', so the number S/4 assigned is a retry dependency - the
 * same reasoning that made the four address children carry their OrdinalNumber.
 */
test('a contact create records the RelationshipNumber S/4 assigned', () => {
  const createAt = changeRequestService.indexOf("const persisted = { action: 'U' };");
  assert.ok(createAt > 0);
  const block = changeRequestService.slice(createAt, changeRequestService.indexOf('.where({ ID }));', createAt));
  assert.match(block, /section === 'BusinessPartnerContacts'/u, 'only the node whose key S/4 numbers');
  assert.match(block, /persisted\.RelationshipNumber = assigned/u, 'and it is persisted, not just read');
});

test('the staged contact has somewhere to keep that number', async () => {
  const model = cds.linked(await cds.load(path.join(ROOT, 'db')));
  const elements = model.definitions['mdmlight.staging.StagedContacts'].elements;
  assert.ok(elements.RelationshipNumber, 'StagedContacts carries RelationshipNumber');
  assert.equal(elements.RelationshipNumber.length, 12, 'RelationshipNumber is CHAR12 in S/4');
});
