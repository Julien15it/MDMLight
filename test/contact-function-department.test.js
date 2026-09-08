'use strict';

/**
 * A contact's Function, Department and Note are elements of `A_BPContactToFuncAndDept`, not of
 * `A_BusinessPartnerContact`: the same four-part key, a second entity, and CREATE is not supported
 * on it at all (`sap:creatable="false"` on the entity set) because the row exists as soon as the
 * contact does. So they are staged on the contact row the requester fills in, dropped from the
 * contact's own body by `sanitizeEntityPayload`, and written by `postContactDetail` in a follow-up
 * update keyed by the RelationshipNumber S/4 assigns.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');

const {
  CONTACT_DETAIL_NODE, CONTACT_DETAIL_FIELDS, postContactDetail
} = require('../srv/change-request-service')._internals;
const {
  MAINTENANCE_ENTITIES, sanitizeEntityPayload
} = require('../srv/business-partner-service')._internals;

const ROOT = path.join(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

function screenSections() {
  let loaded;
  const define = (dependencies, factory) => { loaded = factory(); };
  new Function('sap', read(
    'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'BusinessPartnerMetadata.js'
  ))({ ui: { define } });
  return loaded.sections;
}

const contactSection = () => screenSections().find((section) => section.id === 'BusinessPartnerContacts');

test('the three fields are staged on the contact row, at S/4 lengths', async () => {
  const model = cds.linked(await cds.load(path.join(ROOT, 'db')));
  const elements = model.definitions['mdmlight.staging.StagedContacts'].elements;
  assert.equal(elements.ContactPersonFunction.length, 4, 'PAFKT is CHAR4');
  assert.equal(elements.ContactPersonDepartment.length, 4, 'ABTNR is CHAR4');
  assert.equal(elements.ContactPersonRemarkText.length, 40);
});

test('the Contacts dialog offers them as editable fields', () => {
  const fields = new Map(contactSection().fields.map((field) => [field.name, field]));
  for (const name of CONTACT_DETAIL_FIELDS) {
    const field = fields.get(name);
    assert.ok(field, `${name} is not on the Contacts screen`);
    assert.equal(field.creatable, true, `${name} must be fillable on a new contact`);
    assert.equal(field.updatable, true, `${name} must be changeable on an existing one`);
  }
});

test('the follow-up node is update-only, and says so the way the EDMX does', () => {
  const configuration = MAINTENANCE_ENTITIES[CONTACT_DETAIL_NODE];
  assert.equal(configuration.remote, 'A_BPContactToFuncAndDept');
  assert.equal(configuration.creatable, false);
  assert.equal(configuration.deletable, false);
  assert.ok(configuration.notCreatableReason, 'the refusal has to say why, not name a role');

  const set = read('srv', 'external', 'API_BUSINESS_PARTNER.edmx')
    .match(/<EntitySet Name="A_BPContactToFuncAndDept"[\s\S]*?\/>/u);
  assert.match(set[0], /sap:creatable="false"/u, 'S/4 has no create verb for this entity');
});

test('the contact create cannot carry them, and the follow-up update can', async () => {
  const model = await cds.load(path.join(ROOT, 'srv'));
  const row = {
    BusinessPartnerPerson: '228', ContactPersonFunction: '0001',
    ContactPersonDepartment: '0002', ContactPersonRemarkText: 'Weekly call'
  };

  const contact = model.definitions['BusinessPartnerService.A_BusinessPartnerContact'];
  assert.deepEqual(
    sanitizeEntityPayload(row, contact, { isCreate: true }),
    { BusinessPartnerPerson: '228' },
    'none of the three is an element of A_BusinessPartnerContact, so the create drops them'
  );

  const detail = model.definitions['BusinessPartnerService.A_BPContactToFuncAndDept'];
  assert.deepEqual(
    sanitizeEntityPayload(row, detail, { isCreate: false }),
    {
      ContactPersonFunction: '0001', ContactPersonDepartment: '0002',
      ContactPersonRemarkText: 'Weekly call'
    },
    'the update sends the three and none of the key'
  );
});

test('the follow-up update is addressed by the whole four-part key', async () => {
  const sent = [];
  const bp = { send: async (action, request) => { sent.push({ action, request }); } };
  await postContactDetail(bp, {
    BusinessPartnerCompany: '649', BusinessPartnerPerson: '228', ValidityEndDate: '2026-10-01',
    ContactPersonFunction: '0001', ContactPersonDepartment: null, ContactPersonRemarkText: null
  }, '35');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].request.Entity, CONTACT_DETAIL_NODE);
  assert.equal(sent[0].request.IsCreate, false);
  assert.deepEqual(JSON.parse(sent[0].request.KeyJson), {
    RelationshipNumber: '35', BusinessPartnerCompany: '649',
    BusinessPartnerPerson: '228', ValidityEndDate: '2026-10-01'
  });
  // A blank travelling beside a filled field is a CLEAR, and has to reach S/4 as one.
  const data = JSON.parse(sent[0].request.DataJson);
  assert.equal(data.ContactPersonFunction, '0001');
  assert.equal(data.ContactPersonDepartment, '');
  assert.equal(data.ContactPersonRemarkText, '');
});

/**
 * A row with all three empty is indistinguishable from one the screen never read back, so the
 * update is skipped rather than sent as blanks - it would otherwise clear what S/4 holds.
 */
test('a contact with none of the three is left alone', async () => {
  const sent = [];
  const bp = { send: async () => { sent.push(1); } };
  await postContactDetail(bp, {
    BusinessPartnerCompany: '649', BusinessPartnerPerson: '228', ValidityEndDate: '2026-10-01',
    ContactPersonFunction: null, ContactPersonDepartment: '', ContactPersonRemarkText: '   '
  }, '35');
  assert.deepEqual(sent, [], 'nothing to write means nothing is written');
});

test('a contact S/4 gave no relationship number for is refused, not posted blind', async () => {
  await assert.rejects(
    () => postContactDetail({ send: async () => {} }, {
      BusinessPartnerCompany: '649', BusinessPartnerPerson: '228',
      ValidityEndDate: '2026-10-01', ContactPersonFunction: '0001'
    }, null),
    /no row to address/u
  );
});

test('postToS4 writes the detail row for a contact, after the contact itself', () => {
  const source = read('srv', 'change-request-service.js');
  const saveAt = source.indexOf("const saveResult = await bp.send('saveBusinessPartnerEntity'");
  assert.ok(saveAt > 0);
  const detailAt = source.indexOf('await postContactDetail(bp, data, contactRelationshipNumber)', saveAt);
  assert.ok(detailAt > saveAt, 'the detail write must follow the contact write, not precede it');
});

/** The value help behind each code, and the ABAP side that has to expose it. */
test('both codes have a value help, from a released SAP view', () => {
  const controller = read(
    'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
    'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  assert.match(controller, /ContactPersonFunction: \{\s*\n\s*collectionPath: "ContactPersonFunctions"/u);
  assert.match(controller, /ContactPersonDepartment: \{\s*\n\s*collectionPath: "ContactPersonDepartments"/u);

  const serviceDefinition = read('abap', 'valuehelp', 'ZMDML_VH_ENTITY.asrvdsrv');
  for (const view of [
    'I_ContactPersonFunction', 'I_ContactPersonFunctionT',
    'I_ContactPersonDepartment', 'I_ContactPersonDepartmentT'
  ]) {
    assert.match(serviceDefinition, new RegExp(`expose ${view}\\s`, 'u'), `${view} is not exposed`);
  }
});
