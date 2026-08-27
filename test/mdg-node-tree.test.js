'use strict';

/**
 * The MDG "ERP Customer" / "ERP Supplier" tree spans four files: the maintenance
 * registry that posts a node, the staging entity that holds it while a request is in
 * review, the payload catalog rules address it by, and the screen metadata that renders
 * it. A node wired into three of the four fails quietly - it shows on screen and is
 * dropped on submit, or it stages and never renders - so the wiring is asserted here
 * rather than left to whoever notices.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAINTENANCE_ENTITIES, businessPartnerNavigationPath
} = require('../srv/business-partner-service')._internals;
const { PAYLOAD_NODES, ROOT_SECTION } = require('../srv/checks/payload-fields');

function screenSections() {
  const file = path.join(
    __dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'BusinessPartnerMetadata.js'
  );
  let loaded;
  const define = (dependencies, factory) => { loaded = factory(); };
  // The generated file is an AMD module; running it needs only sap.ui.define to exist.
  new Function('sap', fs.readFileSync(file, 'utf8'))({ ui: { define } });
  return loaded.sections;
}

test('every MDG node is wired through registry, staging, catalog and screen', () => {
  const sections = screenSections();
  const onScreen = new Map(sections.map((section) => [section.id, section]));

  // The root is the payload's own fields, not a node, and BusinessPartners is the page
  // header rather than a maintainable child - neither is expected on the other side.
  const staged = Object.keys(PAYLOAD_NODES).filter((id) => id !== ROOT_SECTION);

  for (const id of staged) {
    assert.ok(MAINTENANCE_ENTITIES[id], `${id} stages but nothing posts it`);
    assert.ok(onScreen.has(id), `${id} stages but never renders`);
  }

  for (const id of Object.keys(MAINTENANCE_ENTITIES)) {
    assert.ok(PAYLOAD_NODES[id], `${id} posts but a request cannot carry it`);
  }

  // A child renders inside its role's Details dialog, so it must be claimed by exactly
  // one parent - unclaimed means invisible, twice means it renders twice.
  const claimed = sections.flatMap((section) => section.childSections || []);
  assert.equal(new Set(claimed).size, claimed.length, 'a section is claimed twice');
  for (const id of claimed) assert.ok(onScreen.has(id), `${id} is claimed but not a section`);
});

test('a staged node carries every field its screen section shows', async () => {
  const cds = require('@sap/cds');
  const model = cds.linked(await cds.load(path.join(__dirname, '..', 'db')));
  const sections = new Map(screenSections().map((section) => [section.id, section]));

  // Debt that predates the MDG tree: these sections show more of A_Customer /
  // A_Supplier than their staging entity holds, so editing one of the extra fields is
  // dropped on submit. Recorded as a ceiling rather than waved through - the count may
  // fall, and a new node that does not stage what it shows fails here.
  const KNOWN_GAPS = { Customers: 41, Suppliers: 29, CustomerCompany: 1, CustomerSalesArea: 5 };

  for (const [id, node] of Object.entries(PAYLOAD_NODES)) {
    if (id === ROOT_SECTION) continue;
    const section = sections.get(id);
    if (!section) continue;
    const elements = model.definitions[node.entity].elements;
    // The relation field is resolved from the business partner when the request is
    // posted, so it is deliberately the one screen field with no staged column.
    const missing = (section.fields || [])
      .map((field) => field.name)
      .filter((name) => name !== section.relationField && !elements[name]);
    assert.ok(
      missing.length <= (KNOWN_GAPS[id] || 0),
      `${node.entity} cannot hold ${missing.join(', ')}`
    );
  }
});

test('a node under a composite-keyed parent posts to a fully named parent URI', () => {
  const row = {
    Customer: '54', Supplier: '54', CompanyCode: '1000',
    SalesOrganization: '1710', DistributionChannel: '10', Division: '00',
    PurchasingOrganization: '1710'
  };

  assert.equal(
    businessPartnerNavigationPath(MAINTENANCE_ENTITIES.CustomerDunning, row),
    "/A_CustomerCompany(Customer='54',CompanyCode='1000')/to_CustomerDunning"
  );
  assert.equal(
    businessPartnerNavigationPath(MAINTENANCE_ENTITIES.CustomerTaxIndicators, row),
    "/A_CustomerSalesArea(Customer='54',SalesOrganization='1710',DistributionChannel='10',"
    + "Division='00')/to_SalesAreaTax"
  );
  assert.equal(
    businessPartnerNavigationPath(MAINTENANCE_ENTITIES.SupplierPartnerFunctions, row),
    "/A_SupplierPurchasingOrg(Supplier='54',PurchasingOrganization='1710')/to_PartnerFunction"
  );

  // A single-key parent keeps the positional form the existing nodes already post to.
  assert.equal(
    businessPartnerNavigationPath(MAINTENANCE_ENTITIES.CustomerCompany, row),
    "/A_Customer('54')/to_CustomerCompany"
  );
  assert.equal(
    businessPartnerNavigationPath(MAINTENANCE_ENTITIES.Addresses, { BusinessPartner: '275' }),
    "/A_BusinessPartner('275')/to_BusinessPartnerAddress"
  );
});

test('a missing parent key is refused before the request leaves', () => {
  assert.throws(
    () => businessPartnerNavigationPath(MAINTENANCE_ENTITIES.CustomerDunning, { Customer: '54' }),
    (error) => error.statusCode === 400 && /CompanyCode/u.test(error.message)
  );
  // Quoting a key that contains an apostrophe, rather than letting it close the literal.
  assert.equal(
    businessPartnerNavigationPath(
      MAINTENANCE_ENTITIES.CustomerDunning, { Customer: "O'Brien", CompanyCode: '1000' }
    ),
    "/A_CustomerCompany(Customer='O''Brien',CompanyCode='1000')/to_CustomerDunning"
  );
});

// FSBP_GENERIC/008 (2026-08-27). ADDR1_DATA-LANGU is required by S/4 and had no staged column, so
// the ABAP mapper sent a blank with the X-flag set - an instruction to clear it.
test('a staged address can hold the address language S/4 requires', async () => {
  const cds = require('@sap/cds');
  const model = cds.linked(await cds.load(path.join(__dirname, '..', 'db')));
  const elements = model.definitions['mdmlight.staging.StagedAddresses'].elements;

  assert.ok(elements.Language, 'StagedAddresses must hold ADDR1_DATA-LANGU');
  assert.equal(elements.Language.length, 2);

  // Not the same field as the root's CorrespondenceLanguage, which is BP-level and person-only on
  // an organisation (R11/336). Filling that one can never satisfy an address-level LANGU.
  const general = model.definitions['mdmlight.staging.StagedGeneral'].elements;
  assert.ok(general.CorrespondenceLanguage, 'the BP-level language is a different column');
});

test('the address screen section offers the language, so a requester can fill it', () => {
  const addresses = screenSections().find((section) => section.id === 'Addresses');
  assert.ok(addresses.fields.some((field) => field.name === 'Language'));
  // Left off the summary row: a two-letter code earns no column beside the street.
  assert.equal((addresses.summaryFields || []).includes('Language'), false);
});
