'use strict';

const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webapp = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const REUSE = path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');

test('maintenance uses one Object Page layout for create, preview and edit', () => {
  const view = fs.readFileSync(
    path.join(REUSE, 'view', 'BusinessPartnerMaintenance.view.xml'),
    'utf8'
  );

  assert.match(view, /<uxap:ObjectPageLayout/);
  assert.match(view, /title="General Information"/);
  assert.match(view, /title="Names"/);
  assert.match(view, /title="Addresses"/);
  assert.match(view, /title="Customer Data"/);
  assert.match(view, /title="Supplier Data"/);
  assert.match(view, /text="Edit Business Partner"/);
  assert.match(view, /text="Business Partners"/);
  assert.match(view, /text="Ask Assistant"/);
  assert.doesNotMatch(view, /<IconTabBar/);
});

test('primary cards stay concise while every root field remains accessible', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );

  assert.match(controller, /GENERAL_FIELDS/);
  assert.match(controller, /NAME_FIELDS/);
  assert.match(controller, /Additional Business Partner Fields/);
  assert.match(controller, /this\._rootSection\.fields\.filter/);
});

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

test('maintenance page opens the assistant with its own OData model', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );

  assert.match(controller, /BusinessPartnerAssistant\.open\(this\.getView\(\)\.getModel\(\), this\.getView\(\)\)/);
  assert.doesNotMatch(controller, /CustomActions\.openAssistant\(event\)/);
});

test('assistant sends bounded conversation history for follow-up reasoning', () => {
  const assistant = fs.readFileSync(
    path.join(REUSE, 'BusinessPartnerAssistant.js'),
    'utf8'
  );

  assert.match(assistant, /var conversationHistory = \[\]/);
  assert.match(assistant, /Ask me a free-form question about Business Partners/);
  assert.doesNotMatch(assistant, /Examples:/);
  assert.match(assistant, /setParameter\("ConversationJson", JSON\.stringify\(conversationHistory\.slice\(-10\)\)\)/);
  assert.match(assistant, /conversationHistory\.push/);
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

test('the assistant offers a reload instead of a dead dialog when the session expires', () => {
  const assistant = fs.readFileSync(
    path.join(REUSE, 'BusinessPartnerAssistant.js'),
    'utf8'
  );

  assert.match(assistant, /Your session expired, so the question was not sent/);
  assert.match(assistant, /window\.location\.reload\(\)/);
  // The generic path must survive: not every failure is an expired session.
  assert.match(assistant, /pushMessage\("assistant", "Assistant", errorMessage\(error\)\)/);
});

/**
 * The chat used to be one growing TextArea with "You: "/"Assistant: " prefixes buried in plain
 * text - asked to be clearer about who typed what (2026-08-26). A FeedListItem per turn, coloured
 * by role through a factory (a static template cannot vary per row), replaces it.
 */
test('the assistant chat is a coloured list of turns, not a plain-text transcript', () => {
  const assistant = fs.readFileSync(path.join(REUSE, 'BusinessPartnerAssistant.js'), 'utf8');

  assert.match(assistant, /new List\(\{/u);
  assert.match(assistant, /new FeedListItem\(\{/u);
  assert.match(assistant, /factory: function \(id, context\)/u);
  // Three distinct style classes, one per role - the colours the CSS keys off.
  assert.match(assistant, /entry\.role === "user" \? "bpChatUser"/u);
  assert.match(assistant, /"bpChatSystem" : "bpChatAssistant"/u);
  // The old plain-text transcript is gone entirely, not left dormant beside the new model.
  assert.equal(/\btranscript\b/u.test(assistant), false, 'no leftover transcript variable');
  assert.equal(/TextArea/u.test(assistant), false, 'the conversation is no longer a TextArea');
});

test('every message goes through one pushMessage helper, so screen and colour cannot drift', () => {
  const assistant = fs.readFileSync(path.join(REUSE, 'BusinessPartnerAssistant.js'), 'utf8');

  assert.match(assistant, /function pushMessage\(role, sender, text\)/u);
  // The intro is a system-role turn - its own colour, not counted as either side's turn.
  assert.match(assistant, /pushMessage\(\s*"system", "Assistant"/u);
  // The user's own question, then a transient placeholder while the call is in flight.
  assert.match(assistant, /pushMessage\("user", "You", value\)/u);
  assert.match(assistant, /pushMessage\("assistant", "Assistant", "Looking up live S\/4HANA data\.\.\."\)/u);
  // The placeholder is removed once the real answer (or an error) is known, not stacked on top of it.
  assert.match(assistant, /function popMessage\(\)/u);
  assert.equal((assistant.match(/popMessage\(\);/gu) || []).length, 2, 'success path and error path both pop it');
});

test('the chat auto-scrolls to the newest turn, and the three roles are styled by theme tokens', () => {
  const assistant = fs.readFileSync(path.join(REUSE, 'BusinessPartnerAssistant.js'), 'utf8');
  assert.match(assistant, /function scrollToBottom\(\)/u);
  assert.match(assistant, /dom\.scrollTop = dom\.scrollHeight/u);

  const css = fs.readFileSync(path.join(REUSE, 'css', 'maintenance.css'), 'utf8');
  assert.match(css, /\.bpChatUser\s*\{[\s\S]*?background-color:\s*var\(--sapInformationBackground/u);
  assert.match(css, /\.bpChatAssistant\s*\{[\s\S]*?background-color:\s*var\(--sapSuccessBackground/u);
  assert.match(css, /\.bpChatSystem\s*\{[\s\S]*?background-color:\s*var\(--sapWarningBackground/u);
  // The old TextArea-specific rule is gone with the control it styled.
  assert.equal(/bpAssistantConversation/u.test(css), false);
});

/**
 * The create route reads the suggested draft back from a single JSON `draft` query key (2026-08-27) -
 * a flat key=value transport cannot carry a child-entity array like a registry-confirmed TaxNumbers
 * row, which is what forced the redesign. Root fields still come off an explicit allowlist,
 * ROOT_DRAFT_FIELDS - CorrespondenceLanguage joined it (2026-08-26) alongside the country-inference in
 * businessPartnerCreationSuggestion, so a suggestion that knows an unambiguous business language
 * actually lands in the create form rather than being dropped.
 */
test('the create route reads the JSON draft, root fields off an allowlist and sections by id', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  assert.match(
    controller,
    /var ROOT_DRAFT_FIELDS = \[\s*\n\s*"BusinessPartnerCategory", "BusinessPartnerGrouping", "OrganizationBPName1", "SearchTerm1",\s*\n\s*"CorrespondenceLanguage"\s*\n\s*\];/u
  );
  const create = controller.slice(controller.indexOf('_onCreateRoute:'), controller.indexOf('_onDisplayRoute:'));
  assert.match(create, /draft = JSON\.parse\(query\.draft\)/u);
  assert.match(create, /ROOT_DRAFT_FIELDS\.forEach/u);
  assert.match(create, /draft\.sections/u);
});

/**
 * A name field the create route fills from the AI assistant's draft never fires _onFieldCommitted -
 * that only runs on a real edit inside the form - so BusinessPartnerFullName stayed empty until the
 * requester separately touched a name field themselves, however complete the suggested name already
 * was. _onCreateRoute now recomposes it itself, right after the root fields are set (2026-08-27).
 */
test('the create route recomposes the full name from whatever the draft filled in', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  const create = controller.slice(controller.indexOf('_onCreateRoute:'), controller.indexOf('_onDisplayRoute:'));
  const setDataIndex = create.indexOf('.setData(state);');
  const refreshIndex = create.indexOf('this._refreshFullName(true);');
  assert.ok(setDataIndex !== -1 && refreshIndex !== -1, 'both calls must be present in _onCreateRoute');
  assert.ok(refreshIndex > setDataIndex, 'the model must hold the draft root fields before recomposing');
});

// The changed-field diff went with the direct write: a change request stages the whole partner so
// the approver sees it in full, and postToS4 replays it. Nothing is diffed on the client any more.
test('maintenance stages the whole payload and shows concise entity fields', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  const metadata = fs.readFileSync(
    path.join(REUSE, 'BusinessPartnerMetadata.js'),
    'utf8'
  );

  assert.match(controller, /DataJson: this\._requestDataJson\(state\)/);
  assert.equal(/originalRecord\[field\.name\]/.test(controller), false, 'no client-side diffing');
  assert.match(metadata, /"summaryFields"/);
  assert.match(metadata, /"StreetName"/);
  assert.doesNotMatch(metadata, /"AdditionalStreetPrefixName"/);
});

test('related entity forms validate required and alternative create fields', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  const metadata = fs.readFileSync(
    path.join(REUSE, 'BusinessPartnerMetadata.js'),
    'utf8'
  );

  assert.match(controller, /_sectionRecordErrors/);
  assert.match(controller, /Enter at least one of/);
  assert.match(metadata, /"requiredCreateFields"/);
  assert.match(metadata, /"oneOfCreateFields"/);
  assert.match(metadata, /"BPTaxNumber"/);
  assert.match(metadata, /"IBAN"/);
});

// The delete UI is unchanged; where the delete happens is not. The client stages the row and only
// postToS4 calls the action, so a deletion now waits for approval like everything else.
test('deletable related entities expose a confirmed delete action', async () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  const changeRequestService = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'),
    'utf8'
  );
  const model = await cds.load(path.join(__dirname, '..', 'srv'));

  assert.match(controller, /_confirmDeleteRecord/);
  assert.match(controller, /sap-icon:\/\/delete/);
  assert.match(controller, /state\.deletedRecords\[section\.id\]\.push\(record\)/);
  assert.equal(
    /deleteBusinessPartnerEntity/.test(controller), false,
    'the client never deletes in S/4 itself'
  );
  assert.match(changeRequestService, /deleteBusinessPartnerEntity/);
  assert.ok(model.definitions['BusinessPartnerService.deleteBusinessPartnerEntity']);
});

test('date pickers write back a full datetime, not a bare date, and roles stay deletable', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  const metadata = fs.readFileSync(
    path.join(REUSE, 'BusinessPartnerMetadata.js'),
    'utf8'
  );

  // ValidFrom/ValidTo (and any other date field) are typed cds.Date/cds.DateTime
  // in the model — DatePicker only edits the date part, but the value written
  // back to the record must still be a full ISO datetime.
  assert.match(controller, /function toDateTimeValue/);
  assert.match(controller, /record\[field\.name\] = toDateTimeValue\(event\.getParameter\("value"\)\)/);

  // cds.DateTime fields (ValidFrom/ValidTo, ValidityStartDate/EndDate, ...)
  // need a date+time picker, not just a date picker — cds.Date fields keep
  // the plain DatePicker.
  assert.match(controller, /"sap\/m\/DateTimePicker"/);
  assert.match(controller, /function isDateTime\(field\)/);
  assert.match(controller, /isDateTimeField \? DateTimePicker : DatePicker/);

  // BusinessPartnerRoles used to be add-only; it must be deletable like every
  // other creatable section (server-side gate lives in MAINTENANCE_ENTITIES).
  const rolesSectionMatch = metadata.match(/"id": "BusinessPartnerRoles"[\s\S]*?\n {6}\}/u);
  assert.ok(rolesSectionMatch, 'BusinessPartnerRoles section not found in generated metadata');
  assert.doesNotMatch(rolesSectionMatch[0], /"deletable": false/);
});

test('application component initializes list actions with the main OData model', () => {
  const component = fs.readFileSync(path.join(webapp, 'Component.js'), 'utf8');
  assert.match(component, /CustomActions\.setEnvironment\(this\.getModel\(\), null\)/);
});

test('a failed related section does not block root editing', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );

  assert.match(controller, /records: \[\],\s+warning:/);
  assert.match(controller, /unsupportedFieldFromError/);
  assert.match(controller, /omittedFields\.push/);
  assert.match(controller, /state\.sectionWarnings = sections/);
});

test('list row navigation uses the supported Fiori binding context', () => {
  const extension = fs.readFileSync(
    path.join(webapp, 'ext', 'controller', 'ListReportExtension.controller.js'),
    'utf8'
  );

  assert.match(extension, /contextInfo && contextInfo\.bindingContext/);
  assert.doesNotMatch(extension, /sourceBindingContext/);
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

test('company code, sales area and purchasing org live inside their role Details dialog', () => {
  const metadata = loadMaintenanceMetadata();
  const view = fs.readFileSync(
    path.join(REUSE, 'view', 'BusinessPartnerMaintenance.view.xml'),
    'utf8'
  );

  // The full MDG "ERP Customer" / "ERP Supplier" tree, in the order MDG lists it: the
  // role's own node first, then Company Code and everything under it, then Sales Area /
  // Purchasing Organization and everything under those.
  const expected = {
    Customers: [
      'CustomerText', 'CustomerAddressExtIdentifier', 'CustomerAddressInfo',
      'CustomerTaxGrouping', 'CustomerCompany', 'CustomerCompanyText',
      'CustomerDunning', 'CustomerWithholdingTax', 'CustomerSalesArea',
      'CustomerTaxIndicators', 'CustomerSalesAreaText',
      'CustomerSalesPartnerFunctions', 'CustomerSalesAreaAddressInfo',
      'CustomerUnloadingPoint', 'CustomerUnloadingPointAddressInfo'
    ],
    Suppliers: [
      'SupplierText', 'SupplierCompany', 'SupplierCompanyText', 'SupplierDunning',
      'SupplierWithholdingTax', 'SupplierPurchasingOrg', 'SupplierPurchasingOrgText',
      'SupplierPartnerFunctions'
    ]
  };

  for (const [parentId, childIds] of Object.entries(expected)) {
    const parent = metadata.sections.find((entry) => entry.id === parentId);
    assert.deepEqual(parent.childSections, childIds);

    for (const childId of childIds) {
      // Still a real section: it is loaded, staged and posted exactly as before - only
      // where it renders has moved.
      const child = metadata.sections.find((entry) => entry.id === childId);
      assert.ok(child, `${childId} is no longer a section`);

      // ...but it must not also keep an Object Page block, or it would render twice and
      // the page would be back to three blocks per role.
      assert.doesNotMatch(
        view,
        new RegExp(`id="${childId}Content"`),
        `${childId} still has its own Object Page block`
      );
    }
  }

  // One block per role is the whole point.
  assert.match(view, /id="CustomersContent"/);
  assert.match(view, /id="SuppliersContent"/);

  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  // The dialog registers a container per child so the ordinary re-render paths reach it.
  assert.match(controller, /_hostedSectionContainers/);
  assert.match(controller, /section\.childSections/);
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

// The Why column is a three-word label with the full explanation on hover, and the dialog is big
// enough to read the table in (2026-08-27).
test('the proposal dialog shows a short reason and hides the sentence in its tooltip', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );

  assert.match(controller, /text: "\{reason\}", wrapping: false, tooltip: "\{detail\}"/);
  // The derivation's short label leads, never its message: that is what the tooltip carries.
  assert.match(controller, /reason: entry\.label \|\| "Derived value"/);
  assert.match(controller, /detail: entry\.message \|\|/);
  assert.doesNotMatch(controller, /reason: entry\.message/);
  assert.match(controller, /contentWidth: "76rem"/);
  assert.match(controller, /contentHeight: "40rem"/);
});

/**
 * Reported directly (2026-08-27): "Supplier and Customer no longer take over the standard address
 * from the BP - isn't that normally the case with CVI?" It never carried over as a value because
 * A_Customer/A_Supplier expose no address field to carry it into - real CVI shares the BP's own
 * address rather than duplicating it onto the Customer/Supplier master. Nothing to stage or post;
 * this is a read-only reminder on the Customers/Suppliers section of what will be shared.
 */
test('Customers and Suppliers show a read-only reminder that they share the BP\'s own address', () => {
  const controller = fs.readFileSync(
    path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );

  assert.match(controller, /function addressPreview\(address\)/u);
  const renderSection = controller.slice(
    controller.indexOf('_renderSection: function'),
    controller.indexOf('_openNewRecord: function')
  );
  assert.match(renderSection, /section\.id === "Customers" \|\| section\.id === "Suppliers"/u);
  assert.match(renderSection, /Shares the Business Partner's own address/u);
  // Nothing is staged for it - the metadata has no address field on either entity to write one into.
  const metadata = fs.readFileSync(path.join(REUSE, 'BusinessPartnerMetadata.js'), 'utf8');
  const customers = metadata.slice(
    metadata.indexOf('"id": "Customers"'),
    metadata.indexOf('"id": "CustomerCompany"')
  );
  const suppliers = metadata.slice(
    metadata.indexOf('"id": "Suppliers"'),
    metadata.indexOf('"id": "SupplierCompany"')
  );
  assert.doesNotMatch(customers, /"name": "AddressID"/u);
  assert.doesNotMatch(suppliers, /"name": "AddressID"/u);
});
