'use strict';

const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webapp = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const REUSE = path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');

test('facade excludes fields missing in the target S/4 release', async () => {
  const model = await cds.load(path.join(__dirname, '..', 'srv'));
  const customer = model.definitions['BusinessPartnerService.Customers'];
  const supplier = model.definitions['BusinessPartnerService.Suppliers'];

  assert.ok(customer);
  assert.ok(supplier);
  assert.equal(customer.elements.BR_ICMSTaxPayerType, undefined);
  assert.equal(supplier.elements.BusinessPartnerPanNumber, undefined);
  assert.equal(supplier.elements.JP_SuplrAmtInCapitalAmount, undefined);
  assert.equal(supplier.elements.JP_SupplierCapitalAmountCrcy, undefined);

  // Asking the live service for this one answers 404 "Resource not found for the segment
  // 'CustomerStatisticsGroup'", which fails the whole Sales Area read - so the section
  // renders empty for a customer that does have sales area data. Both projections on
  // A_CustomerSalesArea must drop it, not just the one the maintenance screen reads.
  // Same story, found the same way - the startup drift check named it on 2026-08-21 while the
  // other five it reported were already excluded. Withholding Tax is a maintained section, so a
  // failing read there is a section that renders empty on the approve screen.
  const withholding = model.definitions['BusinessPartnerService.A_CustomerWithHoldingTax'];
  assert.ok(withholding, 'A_CustomerWithHoldingTax is not exposed');
  assert.equal(
    withholding.elements.RecipientType,
    undefined,
    'RecipientType is gone from the live service and must not be asked for'
  );

  for (const name of ['CustomerSalesArea', 'A_CustomerSalesArea']) {
    const salesArea = model.definitions[`BusinessPartnerService.${name}`];
    assert.ok(salesArea, `${name} is not exposed`);
    assert.equal(
      salesArea.elements.CustomerStatisticsGroup,
      undefined,
      `${name} still requests CustomerStatisticsGroup`
    );
  }

  const metadata = fs.readFileSync(
    path.join(REUSE, 'BusinessPartnerMetadata.js'),
    'utf8'
  );
  assert.doesNotMatch(metadata, /BR_ICMSTaxPayerType/);
  assert.doesNotMatch(metadata, /BusinessPartnerPanNumber/);
  assert.doesNotMatch(metadata, /JP_SuplrAmtInCapitalAmount/);
  assert.doesNotMatch(metadata, /JP_SupplierCapitalAmountCrcy/);
});

// Loads the UI5 module with stubbed dependencies so its logic can be exercised outside a browser.
function loadAssistantModule() {
  const source = fs.readFileSync(path.join(REUSE, 'BusinessPartnerAssistant.js'), 'utf8');
  let loaded;
  const sap = {
    ui: {
      define: (dependencies, factory) => {
        loaded = factory(...dependencies.map(() => function stub() {}));
      }
    }
  };
  new Function('sap', source)(sap);
  return loaded;
}

// An idle approuter answers the assistant's XHR with a bare 401 that no retry can recover.
test('an expired session is recognised however the 401 is reported', () => {
  const { _isSessionExpired } = loadAssistantModule();

  assert.equal(_isSessionExpired({ cause: { status: 401 } }), true);
  assert.equal(_isSessionExpired({ cause: { statusCode: 401 } }), true);
  assert.equal(_isSessionExpired({ status: 401 }), true);
  assert.equal(_isSessionExpired({ cause: { message: 'Communication error: 401 error' } }), true);

  assert.equal(_isSessionExpired({ cause: { status: 502 } }), false);
  assert.equal(_isSessionExpired({ message: 'S/4HANA rejected the request' }), false);
  assert.equal(_isSessionExpired({ cause: { message: 'no 4010 partners found' } }), false);
  assert.equal(_isSessionExpired(null), false);
});

/**
 * The chat used to be one growing TextArea with "You: "/"Assistant: " prefixes buried in plain
 * text - asked to be clearer about who typed what (2026-08-26). A FeedListItem per turn, coloured
 * by role through a factory (a static template cannot vary per row), replaces it.
 */

/**
 * The create route reads the suggested draft back from a single JSON `draft` query key (2026-08-27) -
 * a flat key=value transport cannot carry a child-entity array like a registry-confirmed TaxNumbers
 * row, which is what forced the redesign. Root fields still come off an explicit allowlist,
 * ROOT_DRAFT_FIELDS - CorrespondenceLanguage joined it (2026-08-26) alongside the country-inference in
 * businessPartnerCreationSuggestion, so a suggestion that knows an unambiguous business language
 * actually lands in the create form rather than being dropped.
 */

/**
 * A name field the create route fills from the AI assistant's draft never fires _onFieldCommitted -
 * that only runs on a real edit inside the form - so BusinessPartnerFullName stayed empty until the
 * requester separately touched a name field themselves, however complete the suggested name already
 * was. _onCreateRoute now recomposes it itself, right after the root fields are set (2026-08-27).
 */

/**
 * Customers/Suppliers were the two sections still add-only, reported 2026-08-28. They stay `false`
 * server-side (MAINTENANCE_ENTITIES) for the LIVE full-screen maintenance flow - S/4 has no plain
 * DELETE for A_Customer/A_Supplier, a customer is retired via DeletionIndicator instead - but the
 * staged screen this test reads never reaches that call for these two `kind: "single"` nodes:
 * writeStagedNodes' singular-node branch (srv/change-request-service.js) has no `deleted[section]`
 * handling at all, so removing the row here only means nothing is (re)inserted into StagedCustomer/
 * StagedSupplier - a create simply stages no customer/supplier data, and a change leaves the live
 * record untouched. Nothing about this fix bypasses the server-side guard.
 */
test('Customer Data and Supplier Data are deletable too, not just add-only', () => {
  const metadata = fs.readFileSync(
    path.join(REUSE, 'BusinessPartnerMetadata.js'),
    'utf8'
  );
  for (const id of ['Customers', 'Suppliers']) {
    const match = metadata.match(new RegExp(`"id": "${id}"[\\s\\S]*?\\n {6}\\}`, 'u'));
    assert.ok(match, `${id} section not found in generated metadata`);
    assert.doesNotMatch(match[0], /"deletable": false/);
  }

  // The generator's own source is what a rebuild would reproduce - pinned too, so a future
  // regeneration cannot silently reintroduce `deletable: false` there.
  const generator = fs.readFileSync(
    path.join(
      __dirname, '..', 'app', 'businesspartner', 'scripts', 'generate-maintenance-metadata.js'
    ),
    'utf8'
  );
  for (const id of ['Customers', 'Suppliers']) {
    const section = generator.slice(
      generator.indexOf(`id: '${id}',`), generator.indexOf('childSections:', generator.indexOf(`id: '${id}',`))
    );
    assert.doesNotMatch(section, /deletable: false/);
  }

  // The server-side, LIVE-maintenance guard is deliberately unchanged: S/4 rejects a plain DELETE
  // against these two entities, so MAINTENANCE_ENTITIES must keep refusing it there.
  const serviceJs = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'business-partner-service.js'), 'utf8'
  );
  const { MAINTENANCE_ENTITIES } = require('../srv/business-partner-service')._internals;
  assert.equal(MAINTENANCE_ENTITIES.Customers.deletable, false);
  assert.equal(MAINTENANCE_ENTITIES.Suppliers.deletable, false);
  assert.match(serviceJs, /if \(!configuration\.deletable\) \{/u);
});

/** Evaluates the generated UI5 metadata module without a UI5 runtime. */
function loadMaintenanceMetadata() {
  const source = fs.readFileSync(path.join(REUSE, 'BusinessPartnerMetadata.js'), 'utf8');
  let exported;
  const sap = { ui: { define: (_dependencies, factory) => { exported = factory(); } } };
  new Function('sap', source)(sap);
  return exported;
}

test('Customer and Supplier carry their whole entity, grouped, behind a Details button', () => {
  const metadata = loadMaintenanceMetadata();

  for (const id of ['Customers', 'Suppliers']) {
    const section = metadata.sections.find((entry) => entry.id === id);
    assert.ok(section.fieldGroups && section.fieldGroups.length, `${id} has no fieldGroups`);

    // The point of the drill-down: the table stays at six summary columns while the
    // detail form carries the full entity, instead of the nine fields it used to show.
    assert.ok(section.fields.length > 30, `${id} exposes only ${section.fields.length} fields`);

    // generate-maintenance-metadata.js derives fieldNames from the groups, so these two
    // must agree exactly - a field in one but not the other is either fetched and never
    // rendered, or rendered from data that was never fetched.
    const grouped = section.fieldGroups.flatMap((group) => group.fields).sort();
    const fetched = section.fields.map((field) => field.name).sort();
    assert.deepEqual(grouped, fetched, `${id}: fieldGroups and fields disagree`);
  }

  // Sections without groups must keep the single flat grid.
  const addresses = metadata.sections.find((entry) => entry.id === 'Addresses');
  assert.equal(addresses.fieldGroups, undefined);

  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  assert.match(controller, /section\.fieldGroups/);
  assert.match(controller, /text: "Details"/);

  // A grouped section sits directly above the child tables in the same dialog, so its
  // fields render with the same sap.m.Table - field names as the header row, inputs as
  // the row below - rather than as a form that would look unbounded beside them.
  assert.match(controller, /_createFieldTable/);

  // That table layout is for grouped sections only. Every other dialog - Addresses,
  // Roles, Tax Numbers, Additional Fields - keeps the label-above-field cards it has
  // always had, so the flag is derived from the section rather than passed as a literal.
  assert.match(controller, /var grouped = Boolean\(section\.fieldGroups/);
  assert.doesNotMatch(controller, /isCreate, editing, true\)/);
  assert.doesNotMatch(controller, /SimpleForm/);
});

/**
 * `srv/business-partner-service.cds` excludes fields the imported metadata has but this on-premise
 * release does not expose (`A_Customer excluding {...}`, etc. - see CLAUDE.md, "The imported models
 * are copies, and they go stale silently"). The generator used to read the raw imported CSN only, so
 * a field added to a CDS `excluding {}` clause stayed on the create screen until someone also
 * hand-copied it into that section's own `excludedFields` in generate-maintenance-metadata.js - a
 * second copy of the same fact that drifted at least once: RecipientType was excluded from
 * A_CustomerWithHoldingTax on 2026-08-21 to fix a live 404 (CLAUDE.md), and the generator was never
 * updated to match, so it stayed on the create screen for weeks. Fixed 2026-08-27 by deriving
 * excludedFields from the compiled service instead of a hand-kept copy.
 */
test('the metadata generator derives its exclusions from the compiled CDS service, not a hand-copied list', () => {
  const generator = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'businesspartner', 'scripts', 'generate-maintenance-metadata.js'),
    'utf8'
  );
  assert.match(generator, /cds\.load\(path\.join\(projectRoot, 'srv', 'business-partner-service'\)\)/u);
  assert.match(generator, /!\(name in serviceEntity\.elements\)/u);
  assert.match(generator, /section\.excludedFields = \[\.\.\.new Set\(\[/u);

  // The concrete bug this closed: a field a fixed CDS exclusion already drops must be gone from the
  // generated file too, not just from the CDS-served OData response.
  const metadata = fs.readFileSync(path.join(REUSE, 'BusinessPartnerMetadata.js'), 'utf8');
  const section = metadata.slice(
    metadata.indexOf('"id": "CustomerWithholdingTax"'),
    metadata.indexOf('"id": "CustomerSalesAreaText"')
  );
  assert.doesNotMatch(section, /"name": "RecipientType"/u);
});

/**
 * Reported directly, with a screenshot of the S/4 standard-check warnings (CVI_API/3, FSBP_GENERIC/8):
 * a Customer Sales Area row saved fine on screen with Sales District, Cust. Pricing Procedure,
 * Customer Price Group and Currency all empty, and only failed once posted to S/4, which refuses a
 * KNVV row missing any of them. SalesDistrict had already been added to the section's own fields
 * (2026-08-28) but none of the four had been added to requiredCreateFields, so the record dialog's
 * own "Apply" validation (_sectionRecordErrors) never caught the gap before that S/4 round trip.
 */
test('a Customer Sales Area row cannot be saved without the four fields S/4 itself requires', () => {
  const generator = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'businesspartner', 'scripts', 'generate-maintenance-metadata.js'),
    'utf8'
  );
  const salesArea = generator.slice(
    generator.indexOf("id: 'CustomerSalesArea'"),
    generator.indexOf("id: 'CustomerTaxGrouping'")
  );
  assert.match(
    salesArea,
    /requiredCreateFields: \[\s*\n\s*'SalesOrganization', 'DistributionChannel', 'Division',\s*\n\s*'SalesDistrict', 'CustomerPricingProcedure', 'CustomerPriceGroup', 'Currency'\s*\n\s*\]/u
  );

  const metadata = fs.readFileSync(path.join(REUSE, 'BusinessPartnerMetadata.js'), 'utf8');
  const section = metadata.slice(
    metadata.indexOf('"id": "CustomerSalesArea"'),
    metadata.indexOf('"id": "CustomerTaxGrouping"')
  );
  for (const field of ['SalesOrganization', 'DistributionChannel', 'Division', 'SalesDistrict', 'CustomerPricingProcedure', 'CustomerPriceGroup', 'Currency']) {
    assert.match(section, new RegExp(`"requiredCreateFields": \\[[\\s\\S]*?"${field}"[\\s\\S]*?\\]`), `${field} missing from requiredCreateFields`);
  }
});

test('the generated metadata stays reproducible: re-running the generator changes nothing', () => {
  const before = fs.readFileSync(path.join(REUSE, 'BusinessPartnerMetadata.js'), 'utf8');
  const result = require('node:child_process').spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'app', 'businesspartner', 'scripts', 'generate-maintenance-metadata.js')],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  const after = fs.readFileSync(path.join(REUSE, 'BusinessPartnerMetadata.js'), 'utf8');
  assert.equal(after, before);
});

/**
 * Reported directly (2026-08-27): "Supplier and Customer no longer take over the standard address
 * from the BP - isn't that normally the case with CVI?" It never carried over as a value because
 * A_Customer/A_Supplier expose no address field to carry it into - real CVI shares the BP's own
 * address rather than duplicating it onto the Customer/Supplier master. Nothing to stage or post;
 * this is a read-only reminder on the Customers/Suppliers section of what will be shared.
 */
