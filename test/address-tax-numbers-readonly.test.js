'use strict';

/**
 * An address-dependent tax number cannot be CREATED through API_BUSINESS_PARTNER on this release.
 *
 * Reported live 2026-09-07: BP 638 was created and the post then failed *"Operation is not
 * supported"*. S/4 answered the POST to `/A_BusinessPartner('638')/to_BusPartAddrDepdntTaxNmbr`
 * with `/IWBEP/CM_MGW_RT/027 Operation 'CREATE_ENTITY' not supported for entity type
 * 'A_BusPartAddrDepdntTaxNmbrType'` - the entity set has no create implementation at all.
 *
 * It is NOT a wrong URL and NOT visible in the imported metadata:
 *   - `to_BusPartAddrDepdntTaxNmbr` hangs off `A_BusinessPartner` and is the only navigation to
 *     this entity anywhere in the model - `A_BusinessPartnerAddress` has no tax-number navigation,
 *     so there is no address-parented route and no deep-insert route.
 *   - the entity set carries no `sap:creatable="false"`, so the copy reads as creatable. Only the
 *     live system says otherwise - "the imported models are copies and go stale silently".
 *
 * So the screen stops offering Add, the check pipeline refuses a staged create, and the post's own
 * refusal says why. Reading existing rows is untouched.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAINTENANCE_ENTITIES
} = require('../srv/business-partner-service')._internals;
const { createNodeRequiredStages } = require('../srv/checks/node-required');

const ROOT = path.join(__dirname, '..');
const edmx = fs.readFileSync(path.join(ROOT, 'srv', 'external', 'API_BUSINESS_PARTNER.edmx'), 'utf8');

// The generated screen metadata, loaded the way mdg-node-tree.test.js loads it.
function screenSections() {
  const file = path.join(
    ROOT, 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'BusinessPartnerMetadata.js'
  );
  let loaded;
  const define = (dependencies, factory) => { loaded = factory(); };
  new Function('sap', fs.readFileSync(file, 'utf8'))({ ui: { define } });
  return new Map(loaded.sections.map((section) => [section.id, section]));
}

test('the server config marks it read-only, and says why in its own words', () => {
  const config = MAINTENANCE_ENTITIES.AddressTaxNumbers;
  assert.equal(config.creatable, false);
  assert.match(config.notCreatableReason, /does not support creating/u);
  assert.match(config.notCreatableReason, /CREATE_ENTITY/u);
  // The default message names a ROLE, which has nothing to do with this. Customers/Suppliers are
  // the nodes that message was written for, and they must not have grown a reason of their own.
  assert.equal(MAINTENANCE_ENTITIES.Customers.notCreatableReason, undefined);
});

test('its four siblings stay creatable - only this one entity set lacks the operation', () => {
  for (const section of ['AddressEmails', 'AddressPhoneNumbers', 'AddressFaxNumbers', 'AddressHomePageURLs']) {
    assert.equal(MAINTENANCE_ENTITIES[section].creatable, true, section);
  }
});

/**
 * The reason this could not be caught from the checked-in model, pinned so nobody "fixes" the
 * config back on the strength of the metadata alone.
 */
test('the imported metadata still claims it is creatable', () => {
  const set = edmx.match(/<EntitySet Name="A_BusPartAddrDepdntTaxNmbr"([^>]*)>/u);
  assert.ok(set, 'the entity set is in the imported model');
  assert.equal(
    /sap:creatable="false"/u.test(set[1]), false,
    'no creatable=false in the copy - only the live gateway refuses'
  );
});

test('there is no address-parented navigation to it, so no other route exists', () => {
  const address = edmx.match(/<EntityType Name="A_BusinessPartnerAddressType"[\s\S]*?<\/EntityType>/u)[0];
  const navigations = [...address.matchAll(/<NavigationProperty Name="([^"]+)"/gu)].map((m) => m[1]);

  // Its siblings each have one; the tax number has none.
  for (const nav of ['to_EmailAddress', 'to_PhoneNumber', 'to_FaxNumber', 'to_URLAddress']) {
    assert.ok(navigations.includes(nav), `the address should navigate to ${nav}`);
  }
  assert.equal(
    navigations.some((nav) => /Tax/u.test(nav)), false,
    'no tax-number navigation off the address - the only route is A_BusinessPartner'
  );
  assert.equal(MAINTENANCE_ENTITIES.AddressTaxNumbers.parentEntity, undefined,
    'so it correctly defaults to A_BusinessPartner');
});

test('the screen stops offering Add, and says why the section is empty', () => {
  const section = screenSections().get('AddressTaxNumbers');
  assert.ok(section, 'the section still renders - reading is unaffected');
  assert.equal(section.creatable, false, '_renderSection drops the Add button on this');
  assert.match(section.emptyText, /does not support creating/u);
  // Its siblings keep theirs.
  assert.notEqual(screenSections().get('AddressEmails').creatable, false);
});

/**
 * `node_required_fields` deliberately skips a non-creatable section - it has no create rules. So
 * nothing said the row could not be posted AT ALL, and it passed every check.
 */
test('the check pipeline refuses a staged create, in the post-time words', async () => {
  const stage = createNodeRequiredStages({ entities: MAINTENANCE_ENTITIES })
    .validations.find((validation) => validation.name === 'node_not_creatable');
  assert.ok(stage, 'the stage is registered');

  const findings = await stage.run({
    root: {},
    sections: {
      AddressTaxNumbers: [{ action: 'C', BPTaxType: 'BE0', BPTaxNumber: '0403200393' }]
    }
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error', 'it blocks: the post would refuse this row');
  assert.equal(findings[0].target, 'AddressTaxNumbers');
  assert.equal(findings[0].index, 0);
  assert.match(findings[0].message, /does not support creating/u);
});

test('only rows the post would CREATE are refused', async () => {
  const stage = createNodeRequiredStages({ entities: MAINTENANCE_ENTITIES })
    .validations.find((validation) => validation.name === 'node_not_creatable');

  // U/D/N are an update, a delete and a row staged for context - none is a create.
  for (const action of ['U', 'D', 'N']) {
    assert.deepEqual(
      await stage.run({ sections: { AddressTaxNumbers: [{ action, BPTaxType: 'BE0' }] } }), [], action
    );
  }
  // And a creatable section is never touched by this stage.
  assert.deepEqual(
    await stage.run({ sections: { AddressEmails: [{ action: 'C', EmailAddress: 'info@alluvion.eu' }] } }), []
  );
});

/**
 * The stage keys off `creatable === false`, so anything that becomes non-creatable is blocked with
 * it. Today that is exactly one section - a wider list would be a behaviour change to notice.
 */
test('exactly one maintenance node is non-creatable', () => {
  const readOnly = Object.entries(MAINTENANCE_ENTITIES)
    .filter(([, config]) => config.creatable === false)
    .map(([section]) => section);
  assert.deepEqual(readOnly, ['AddressTaxNumbers']);
});
