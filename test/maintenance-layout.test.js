'use strict';

const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webapp = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');

test('maintenance uses one Object Page layout for create, preview and edit', () => {
  const view = fs.readFileSync(
    path.join(webapp, 'ext', 'view', 'BusinessPartnerMaintenance.view.xml'),
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
    path.join(webapp, 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'),
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

  const metadata = fs.readFileSync(
    path.join(webapp, 'ext', 'BusinessPartnerMetadata.js'),
    'utf8'
  );
  assert.doesNotMatch(metadata, /BR_ICMSTaxPayerType/);
  assert.doesNotMatch(metadata, /BusinessPartnerPanNumber/);
  assert.doesNotMatch(metadata, /JP_SuplrAmtInCapitalAmount/);
  assert.doesNotMatch(metadata, /JP_SupplierCapitalAmountCrcy/);
});

test('maintenance page opens the assistant with its own OData model', () => {
  const controller = fs.readFileSync(
    path.join(webapp, 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );

  assert.match(controller, /BusinessPartnerAssistant\.open\(this\.getView\(\)\.getModel\(\), this\.getView\(\)\)/);
  assert.doesNotMatch(controller, /CustomActions\.openAssistant\(event\)/);
});

test('assistant sends bounded conversation history for follow-up reasoning', () => {
  const assistant = fs.readFileSync(
    path.join(webapp, 'ext', 'BusinessPartnerAssistant.js'),
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
  const source = fs.readFileSync(path.join(webapp, 'ext', 'BusinessPartnerAssistant.js'), 'utf8');
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
    path.join(webapp, 'ext', 'BusinessPartnerAssistant.js'),
    'utf8'
  );

  assert.match(assistant, /Your session expired, so the question was not sent/);
  assert.match(assistant, /window\.location\.reload\(\)/);
  // The generic path must survive: not every failure is an expired session.
  assert.match(assistant, /transcript \+= "\\n\\nAssistant: " \+ errorMessage\(error\)/);
});

test('maintenance sends only changed root fields and shows concise entity fields', () => {
  const controller = fs.readFileSync(
    path.join(webapp, 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  const metadata = fs.readFileSync(
    path.join(webapp, 'ext', 'BusinessPartnerMetadata.js'),
    'utf8'
  );

  assert.match(controller, /record\[field\.name\] !== originalRecord\[field\.name\]/);
  assert.match(controller, /Object\.keys\(rootPayload\)\.length > 0/);
  assert.match(metadata, /"summaryFields"/);
  assert.match(metadata, /"StreetName"/);
  assert.doesNotMatch(metadata, /"AdditionalStreetPrefixName"/);
});

test('related entity forms validate required and alternative create fields', () => {
  const controller = fs.readFileSync(
    path.join(webapp, 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  const metadata = fs.readFileSync(
    path.join(webapp, 'ext', 'BusinessPartnerMetadata.js'),
    'utf8'
  );

  assert.match(controller, /_sectionRecordErrors/);
  assert.match(controller, /Enter at least one of/);
  assert.match(metadata, /"requiredCreateFields"/);
  assert.match(metadata, /"oneOfCreateFields"/);
  assert.match(metadata, /"BPTaxNumber"/);
  assert.match(metadata, /"IBAN"/);
});

test('deletable related entities expose a confirmed delete action', async () => {
  const controller = fs.readFileSync(
    path.join(webapp, 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );
  const model = await cds.load(path.join(__dirname, '..', 'srv'));

  assert.match(controller, /_confirmDeleteRecord/);
  assert.match(controller, /deleteBusinessPartnerEntity/);
  assert.match(controller, /sap-icon:\/\/delete/);
  assert.ok(model.definitions['BusinessPartnerService.deleteBusinessPartnerEntity']);
});

test('application component initializes list actions with the main OData model', () => {
  const component = fs.readFileSync(path.join(webapp, 'Component.js'), 'utf8');
  assert.match(component, /CustomActions\.setEnvironment\(this\.getModel\(\), null\)/);
});

test('a failed related section does not block root editing', () => {
  const controller = fs.readFileSync(
    path.join(webapp, 'ext', 'controller', 'BusinessPartnerMaintenance.controller.js'),
    'utf8'
  );

  assert.match(controller, /records: \[\],\s+warning:/);
  assert.match(controller, /unsupportedFieldFromError/);
  assert.match(controller, /omittedFields\.push/);
  assert.match(controller, /state\.sectionWarnings = sectionWarnings/);
});

test('list row navigation uses the supported Fiori binding context', () => {
  const extension = fs.readFileSync(
    path.join(webapp, 'ext', 'controller', 'ListReportExtension.controller.js'),
    'utf8'
  );

  assert.match(extension, /contextInfo && contextInfo\.bindingContext/);
  assert.doesNotMatch(extension, /sourceBindingContext/);
});
