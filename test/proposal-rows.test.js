'use strict';

// The proposals dialog, 2026-08-28: a keyed derived row is one line, and S/4's own findings wait
// until the dialog is answered. Reasoning in CLAUDE.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REUSE = path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');
const CONTROLLER = fs.readFileSync(
  path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'), 'utf8'
);

// Same loader as submit-messages.test.js: a UI5 module, exercised for its pure helpers only.
function loadController() {
  let members;
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  vm.runInNewContext(CONTROLLER, {
    sap: {
      ui: {
        define: (dependencies, factory) => {
          const base = { extend: (name, definition) => { members = definition; return definition; } };
          factory(...dependencies.map((unused, index) => (index === 0 ? base : stub)));
        }
      }
    }
  });
  return members;
}

// Rebuilt in this realm: the vm sandbox has its own Object.prototype, which deepStrictEqual rejects.
const plain = (value) => JSON.parse(JSON.stringify(value));

const SECTIONS = [
  { id: 'CustomerSalesPartnerFunctions', title: 'Customer Partner Functions' },
  { id: 'Addresses', title: 'Address Data' }
];

function context(overrides = {}) {
  const controller = loadController();
  return Object.assign(Object.create(controller), { _metadata: SECTIONS }, overrides);
}

// Exactly what runDerivations reports for one keyed row: the function, then the three entries that
// complete its sales area key. Same `index`, because the pipeline resolves it per row.
const rowEntries = (partnerFunction, index) => [
  {
    check: 'sap_derivations', target: 'CustomerSalesPartnerFunctions', index,
    field: 'PartnerFunction', value: partnerFunction, createsRow: true,
    rowKey: { PartnerFunction: partnerFunction, SalesOrganization: '1710', DistributionChannel: '10', Division: '00' },
    label: 'Mandatory function',
    message: `Partner function ${partnerFunction} is mandatory for account group DEBI under `
      + 'determination procedure AG in S/4. The row is for sales area 1710 / 10 / 00, taken from '
      + 'the sales area on this request.'
  },
  ...[['SalesOrganization', '1710'], ['DistributionChannel', '10'], ['Division', '00']]
    .map(([field, value]) => ({
      check: 'sap_derivations', target: 'CustomerSalesPartnerFunctions', index,
      field, value, label: 'Sales area',
      rowKey: { PartnerFunction: partnerFunction, SalesOrganization: '1710', DistributionChannel: '10', Division: '00' },
      message: `${field} ${value} is taken from the sales area on this request.`
    }))
];

test('four entries for one derived row become one dialog line', () => {
  const rows = context()._proposalRows(rowEntries('AG', 0), []);

  assert.equal(rows.length, 1, 'one row derived, one question asked');
  const [row] = rows;
  assert.equal(row.change, 'Row added');
  // The SECTION names the line, because the row is what is being accepted -- a field name alone
  // reads as a field somebody still has to fill.
  assert.equal(row.fieldLabel, 'Customer Partner Functions');
  assert.equal(row.proposed, 'AG', 'and the only genuinely new value is what is proposed');
  assert.equal(row.reason, 'Mandatory function');
  // Visible without hovering, asked for 2026-08-28. The full sentence is still the tooltip.
  assert.equal(row.subtext, 'Sales area 1710 / 10 / 00');
  assert.match(row.detail, /taken from the sales area on this request/u);
});

// Accepting a partner function without the sales area that keys it would stage half a key.
test('the key fields travel with the row rather than being their own questions', () => {
  const [row] = context()._proposalRows(rowEntries('AG', 0), []);

  assert.deepEqual(plain(row.extras), [
    { field: 'SalesOrganization', value: '1710' },
    { field: 'DistributionChannel', value: '10' },
    { field: 'Division', value: '00' }
  ]);
  assert.equal(row.createsRow, true);
  assert.equal(row.field, 'PartnerFunction', 'the lead field, which is the one still editable');
});

// The whole point of the change: four mandatory functions are four questions, not sixteen.
test('two derived rows are two lines, told apart by their index', () => {
  const rows = context()._proposalRows(
    [...rowEntries('AG', 0), ...rowEntries('RE', 1)], []
  );

  assert.deepEqual(plain(rows.map((row) => row.proposed)), ['AG', 'RE']);
  assert.deepEqual(plain(rows.map((row) => row.index)), [0, 1]);
  assert.deepEqual(plain(rows.map((row) => row.subtext)),
    ['Sales area 1710 / 10 / 00', 'Sales area 1710 / 10 / 00']);
});

// The regression this boundary prevents: grouping on `createsRow` alone compacted the whole address.
test('the registry address proposal stays one line per field, each editable', () => {
  const addressEntries = [
    ['StreetName', 'Koedreef'], ['StreetPrefixName', '2'],
    ['PostalCode', '9000'], ['CityName', 'Gent'], ['Country', 'BE']
  ].map(([field, value]) => ({
    check: 'registry_enrichment', target: 'Addresses', index: 0, createsRow: true,
    field, value, label: 'VIES check',
    message: `${field} was filled in as "${value}" from VIES (a new address).`
  }));

  const rows = context()._proposalRows(addressEntries, []);

  assert.equal(rows.length, 5, 'five values, five questions - not one line with four extras');
  assert.deepEqual(plain(rows.map((row) => row.fieldLabel)),
    ['StreetName', 'StreetPrefixName', 'PostalCode', 'CityName', 'Country'],
    'each named by its own field, never by the section');
  for (const row of rows) {
    assert.equal(row.change, 'Row added', 'it IS still a row being added, and says so');
    assert.deepEqual(plain(row.extras), [], 'nothing is carried along, so nothing is uneditable');
    assert.equal(row.subtext, '');
  }
  // Independently tickable, which is what a distinct `key` per line means.
  assert.equal(new Set(rows.map((row) => row.key)).size, 5);
});

// A row-adding proposal writes its whole row at once. It used to be several ticks resolved by
// index, which breaks the moment a derivation can propose more than one row.
test('accepting a row writes the lead value and every key field with it', () => {
  const state = { root: {}, sections: { CustomerSalesPartnerFunctions: [] } };
  const controller = loadController();
  const ctx = Object.assign(Object.create(controller), {
    _metadata: SECTIONS,
    getView: () => ({ getModel: () => ({ getData: () => state }) }),
    _updatePreview() {}, _renderAll() {}, _refreshChangeSummary() {}, _refreshFullName() {}
  });

  ctx._applyProposals([{
    createsRow: true, target: 'CustomerSalesPartnerFunctions', index: 0,
    field: 'PartnerFunction', proposed: 'AG', current: '',
    extras: [
      { field: 'SalesOrganization', value: '1710' },
      { field: 'DistributionChannel', value: '10' },
      { field: 'Division', value: '00' }
    ]
  }]);

  assert.deepEqual(plain(state.sections.CustomerSalesPartnerFunctions), [{
    __state: 'new',
    PartnerFunction: 'AG',
    SalesOrganization: '1710',
    DistributionChannel: '10',
    Division: '00'
  }]);
});

// Idempotent on the whole key: AG under a second sales area is a different row, not a duplicate.
test('a row already carrying the key is not added twice, and a different key is', () => {
  const rows = [{ PartnerFunction: 'AG', SalesOrganization: '1710', DistributionChannel: '10', Division: '00' }];
  const state = { root: {}, sections: { CustomerSalesPartnerFunctions: rows } };
  const controller = loadController();
  const ctx = Object.assign(Object.create(controller), {
    _metadata: SECTIONS,
    getView: () => ({ getModel: () => ({ getData: () => state }) }),
    _updatePreview() {}, _renderAll() {}, _refreshChangeSummary() {}, _refreshFullName() {}
  });

  const proposal = (salesOrg) => ({
    createsRow: true, target: 'CustomerSalesPartnerFunctions', index: 0,
    field: 'PartnerFunction', proposed: 'AG', current: '',
    extras: [
      { field: 'SalesOrganization', value: salesOrg },
      { field: 'DistributionChannel', value: '10' },
      { field: 'Division', value: '00' }
    ]
  });

  assert.equal(ctx._applyProposals([proposal('1710')]), 0, 'the same key is already there');
  assert.equal(rows.length, 1);

  assert.equal(ctx._applyProposals([proposal('1720')]), 1, 'a second sales area is a second row');
  assert.equal(rows.length, 2);
});

// --- The standard checks wait for the dialog --------------------------------

// `refreshed` is COUNTED, not stubbed away - swallowing it is why this passed while the app broke.
function standardContext() {
  const state = { messages: [] };
  const controller = loadController();
  const ctx = Object.assign(Object.create(controller), {
    getView: () => ({
      getModel: () => ({ getData: () => state, refresh() { ctx.refreshed += 1; } })
    }),
    _renderAll() { ctx.rendered += 1; },
    _rerunStandardChecks() { ctx.reran = true; return Promise.resolve(); },
    reran: false,
    refreshed: 0,
    rendered: 0
  });
  return { ctx, state };
}

const CITY_REQUIRED = { severity: 'warning', message: 'City is required. [CVI_API/007]' };

// Nothing accepted, so the payload is unchanged - no second round trip, no second vendor number.
test('declining every proposal shows the held findings without asking S/4 again', async () => {
  const { ctx, state } = standardContext();
  await ctx._resolveStandardChecks([CITY_REQUIRED], false);

  assert.equal(ctx.reran, false, 'no second round trip');
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0].text, /City is required/u);
  assert.equal(state.messages[0].type, 'Warning');
});

// Something was accepted, so what S/4 was told is out of date. Suppressing the stale findings
// locally could never have been right: accepting a value can make a NEW message appear.
test('accepting a proposal asks S/4 again rather than filtering what it already said', async () => {
  const { ctx, state } = standardContext();
  await ctx._resolveStandardChecks([CITY_REQUIRED], true);

  assert.equal(ctx.reran, true);
  assert.deepEqual(state.messages, [], 'the held findings are replaced, never merged');
});

// The action keeps them apart so the screen CAN hold them; to a requester they are still
// validations, which is why _checkMessages puts them in one list.
test('the check action returns the standard findings separately', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );
  const check = service.slice(
    service.indexOf("this.on('checkRequest'"),
    service.indexOf("this.on('duplicateCheckRequest'")
  );
  assert.match(check, /StandardJson: JSON\.stringify\(result\.standard\)/u);
  // Filtered by identity, not re-derived: runChecks merges the same objects into `validations`.
  assert.match(check, /const isStandard = new Set\(result\.standard\)/u);
  assert.match(check, /result\.validations\.filter\(\(entry\) => !isStandard\.has\(entry\)\)/u);
});
