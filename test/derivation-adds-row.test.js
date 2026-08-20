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
const fs = require('node:fs');
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
  ID: 'a', sequence: 10, isActive: true,
  conditionField: 'BusinessPartnerRoles.BusinessPartnerRole', conditionValue: 'FLVN01',
  conditionField2: 'Addresses.Country', conditionValue2: 'BE',
  field: 'SupplierPurchasingOrg.PurchasingOrganization', value: '1710'
});

const FILLS_CURRENCY = Object.freeze({
  ID: 'b', sequence: 20, isActive: true,
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

/**
 * The column outlived the design. `cds-deploy` refuses to drop an element and it had already
 * reached the deployed model, so it stays as dead weight - exactly like the four `cond*` columns on
 * DuplicateRules. This test exists to keep it dead: the trigger is the payload, and a rule carrying
 * `createsRow: true` must behave no differently from one without it.
 */
test('the superseded createsRow column is kept but never read', async () => {
  const flagged = await derive([{ ...ADDS_ORG, createsRow: true }], request());
  const plain = await derive([ADDS_ORG], request());
  assert.deepEqual(flagged.derived.sections.SupplierPurchasingOrg,
    plain.derived.sections.SupplierPurchasingOrg);

  // And it cannot make a rule add a row beside one that exists.
  const beside = await derive([{ ...ADDS_ORG, createsRow: true }], request({
    SupplierPurchasingOrg: [{ PurchasingOrganization: '1010' }]
  }));
  assert.deepEqual(beside.derived.sections.SupplierPurchasingOrg, [{ PurchasingOrganization: '1010' }]);

  const source = fs.readFileSync(path.join(__dirname, '..', 'srv', 'checks', 'rule-engine.js'), 'utf8');
  assert.equal(/rule\.createsRow/u.test(source), false, 'the engine must not read it');
});

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

/**
 * Scope, decided 2026-08-20: only an EMPTY section gets a row. A section the requester has already
 * put a row in is theirs - the rule falls back to filling its gaps, and never appends beside it.
 */
test('a section that already has a row is filled, never appended to', async () => {
  // Their row already carries the value: nothing to add and nothing to fill.
  const same = await derive([ADDS_ORG], request({
    SupplierPurchasingOrg: [{ PurchasingOrganization: '1710' }]
  }));
  assert.deepEqual(same.derived.sections.SupplierPurchasingOrg, [{ PurchasingOrganization: '1710' }]);

  // A different organisation is theirs to keep: a derivation never overwrites, and no second row
  // appears beside it.
  const other = await derive([ADDS_ORG], request({
    SupplierPurchasingOrg: [{ PurchasingOrganization: '1010' }]
  }));
  assert.deepEqual(other.derived.sections.SupplierPurchasingOrg, [{ PurchasingOrganization: '1010' }]);

  // An empty row of theirs is a gap, so it is filled where it stands.
  const blank = await derive([ADDS_ORG], request({ SupplierPurchasingOrg: [{ PurchasingGroup: '001' }] }));
  assert.deepEqual(blank.derived.sections.SupplierPurchasingOrg, [
    { PurchasingGroup: '001', PurchasingOrganization: '1710' }
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

/**
 * There is no gap-filler/row-adder distinction on the rule any more: the same rule does whichever
 * the payload calls for. A rule that used to say "there is no row to hold it" now proposes the row.
 */
test('a rule over an empty section proposes the row rather than reporting it', async () => {
  const { derived, applied } = await derive([FILLS_CURRENCY], request());
  assert.deepEqual(derived.sections.SupplierPurchasingOrg, [{ PurchaseOrderCurrency: 'EUR' }]);
  const entry = applied.find((message) => message.target === 'SupplierPurchasingOrg');
  assert.equal(entry.createsRow, true);
  assert.equal(entry.field, 'PurchaseOrderCurrency');
});

/**
 * The refusals that guarded the checkbox went with it: with the payload deciding, there is nothing
 * to misconfigure. Both cases simply do not fire - a condition on the section being added is
 * evaluated against an empty row, and a value copied out of it resolves to nothing.
 */
test('a rule that could not mean anything proposes nothing, and is not refused', async () => {
  const ownSection = {
    ID: 'c', isActive: true,
    conditionField: 'SupplierPurchasingOrg.PurchasingGroup', conditionValue: '001',
    field: 'SupplierPurchasingOrg.PurchasingOrganization', value: '1710'
  };
  assert.deepEqual(validateDerivationRule(ownSection, model).errors, [], 'nothing to refuse');
  const conditioned = await derive([ownSection], request());
  assert.equal(conditioned.derived.sections.SupplierPurchasingOrg, undefined);

  const ownReference = {
    ID: 'd', isActive: true,
    field: 'SupplierPurchasingOrg.PurchasingOrganization',
    value: 'SupplierPurchasingOrg.PurchasingGroup'
  };
  const copied = await derive([ownReference], request());
  assert.equal(copied.derived.sections.SupplierPurchasingOrg, undefined);

  // The request root is not a list, so it is never a row to add - it is filled as it always was.
  const root = await derive([{ ID: 'e', isActive: true, field: 'General.Language', value: 'NL' }], request());
  assert.equal(root.derived.root.Language, 'NL');
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
