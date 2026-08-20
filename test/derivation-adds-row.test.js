'use strict';

/**
 * A derivation that adds its own row.
 *
 * Without it a rule like "role FLVN01 in BE means purchasing organisation 1710" can say
 * nothing until the requester has already added the line - and if the target is the row's
 * own key, it can never say anything at all: the add-row dialog requires that field, and a
 * derivation only fills empty ones.
 *
 * The two properties worth holding onto are that it is idempotent - checking twice adds one
 * row - and that adding runs before filling, so the fields of a proposed row get filled in
 * the same pass.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const cds = require('@sap/cds');

const {
  createConfiguredStages, validateDerivationRule, runDerivationRule
} = require('../srv/checks/rule-engine');
const { runDerivations } = require('../srv/checks/pipeline');

let model;
test.before(async () => {
  model = cds.linked(await cds.load(path.join(__dirname, '..', 'db')));
  cds.model = model;
});

const ADDS_ORG = Object.freeze({
  ID: 'a', sequence: 10, isActive: true, createsRow: true,
  conditionField: 'BusinessPartnerRoles.BusinessPartnerRole', conditionValue: 'FLVN01',
  conditionField2: 'Addresses.Country', conditionValue2: 'BE',
  field: 'SupplierPurchasingOrg.PurchasingOrganization', value: '1710'
});

const FILLS_CURRENCY = Object.freeze({
  ID: 'b', sequence: 20, isActive: true, createsRow: false,
  conditionField: 'BusinessPartnerRoles.BusinessPartnerRole', conditionValue: 'FLVN01',
  field: 'SupplierPurchasingOrg.PurchaseOrderCurrency', value: 'EUR'
});

function request(sections = {}, country = 'BE') {
  return {
    root: { OrganizationBPName1: 'Test NV', BusinessPartnerCategory: '2' },
    sections: {
      Addresses: [{ Country: country, CityName: 'Brussel' }],
      BusinessPartnerRoles: [{ BusinessPartnerRole: 'FLVN01' }],
      ...sections
    }
  };
}

const derive = (rules, payload) =>
  runDerivations(payload, createConfiguredStages({ derivations: rules, model }).derivations);

test('the row is added when the conditions hold and nothing holds the value yet', async () => {
  const { derived, applied } = await derive([ADDS_ORG], request());

  assert.deepEqual(derived.sections.SupplierPurchasingOrg, [{ PurchasingOrganization: '1710' }]);
  const [entry] = applied.filter((message) => message.field);
  assert.equal(entry.createsRow, true);
  assert.equal(entry.target, 'SupplierPurchasingOrg');
  assert.equal(entry.index, 0);
  // The requester has to be able to tell a row they did not build from a field they left blank.
  assert.match(entry.message, /row was added/iu);
});

test('adding runs before filling, so a proposed row is completed in the same pass', async () => {
  const { derived } = await derive([ADDS_ORG, FILLS_CURRENCY], request());

  assert.deepEqual(derived.sections.SupplierPurchasingOrg, [
    { PurchasingOrganization: '1710', PurchaseOrderCurrency: 'EUR' }
  ]);
});

test('checking twice adds one row, not two', async () => {
  const first = await derive([ADDS_ORG, FILLS_CURRENCY], request());
  const second = await derive([ADDS_ORG, FILLS_CURRENCY], first.derived);

  assert.deepEqual(second.derived.sections.SupplierPurchasingOrg,
    first.derived.sections.SupplierPurchasingOrg);
  assert.deepEqual(second.applied.filter((message) => message.field), []);
});

test('a row the requester added by hand is kept, and a different one is left beside it', async () => {
  // Same organisation: theirs is the row the rule would have proposed, so nothing is added.
  const same = await derive([ADDS_ORG], request({
    SupplierPurchasingOrg: [{ PurchasingOrganization: '1710' }]
  }));
  assert.deepEqual(same.derived.sections.SupplierPurchasingOrg, [{ PurchasingOrganization: '1710' }]);

  // A different organisation is not the same statement, so the rule still has something to say.
  const other = await derive([ADDS_ORG], request({
    SupplierPurchasingOrg: [{ PurchasingOrganization: '1010' }]
  }));
  assert.deepEqual(other.derived.sections.SupplierPurchasingOrg, [
    { PurchasingOrganization: '1010' }, { PurchasingOrganization: '1710' }
  ]);
});

test('the conditions still gate it', async () => {
  const wrongCountry = await derive([ADDS_ORG], request({}, 'NL'));
  assert.equal(wrongCountry.derived.sections.SupplierPurchasingOrg, undefined);

  const noRole = request();
  noRole.sections.BusinessPartnerRoles = [{ BusinessPartnerRole: 'FLVN00' }];
  const wrongRole = await derive([ADDS_ORG], noRole);
  assert.equal(wrongRole.derived.sections.SupplierPurchasingOrg, undefined);
});

test('a gap-filler still refuses to invent a row', async () => {
  // The behaviour createsRow opts out of, and the reason it has to be opt-in: a rule that
  // fills a field must not quietly start creating records.
  const { derived, applied } = await derive([FILLS_CURRENCY], request());

  assert.equal(derived.sections.SupplierPurchasingOrg, undefined);
  // And it says so. Looping zero times in silence is what made this look broken rather than
  // misconfigured, so the message names the checkbox that fixes it.
  const advice = applied.find((message) => /no SupplierPurchasingOrg row/u.test(message.message));
  assert.ok(advice, 'a rule that cannot fire said nothing');
  assert.match(advice.message, /Add row/u);
  assert.equal(advice.field, undefined, 'advice must not be applied as a value');
});

test('a row-adding rule is refused when it could not mean what it says', () => {
  // A condition on the section being added is about a row that does not exist yet.
  const ownSection = validateDerivationRule({
    createsRow: true,
    conditionField: 'SupplierPurchasingOrg.PurchasingGroup', conditionValue: '001',
    field: 'SupplierPurchasingOrg.PurchasingOrganization', value: '1710'
  }, model);
  assert.match(ownSection.errors[0].message, /does not exist yet/u);

  // Same for copying a value out of it.
  const ownReference = validateDerivationRule({
    createsRow: true,
    field: 'SupplierPurchasingOrg.PurchasingOrganization',
    value: 'SupplierPurchasingOrg.PurchasingGroup'
  }, model);
  assert.ok(ownReference.errors.some((error) => /the one being added/u.test(error.message)));

  // And the request root is not a list.
  const root = validateDerivationRule({
    createsRow: true, field: 'General.Language', value: 'NL'
  }, model);
  assert.match(root.errors[0].message, /not a list/u);

  // The same rule without the flag is fine, so the flag is what is being refused.
  assert.deepEqual(validateDerivationRule({
    field: 'SupplierPurchasingOrg.PurchasingOrganization', value: '1710'
  }, model).errors, []);
});

test('an unusable row-adding rule is dropped rather than run', () => {
  const stages = createConfiguredStages({
    derivations: [{ ...ADDS_ORG, field: 'SupplierPurchasingOrg.NotAField' }],
    model
  });
  assert.deepEqual(stages.derivations, []);
});

test('a reference value is resolved from the partner, not from the row being added', () => {
  const copiesCountry = {
    ...ADDS_ORG, field: 'SupplierCompany.CompanyCode', value: 'Addresses.Country'
  };
  const [entry] = runDerivationRule(copiesCountry, request(), model);
  assert.equal(entry.value, 'BE');
  assert.equal(entry.createsRow, true);
});
