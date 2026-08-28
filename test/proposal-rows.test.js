'use strict';

/**
 * The proposals dialog, 2026-08-28. Two changes, reported from the running app:
 *
 * 1. **A whole derived ROW is one line.** A created row takes several entries -- `createsRow`
 *    writes one field and the rest complete its key -- so the four mandatory partner functions
 *    would have arrived as sixteen lines, twelve of them reading the sales area back to the
 *    requester who had just typed it in. Maarten: *"to an enduser it looks like it's filling in
 *    what I just entered."*
 * 2. **S/4's own findings wait for the dialog.** They run on `systemDerived`, so a City the
 *    derivations are offering to fill is reported as missing at the same moment it is proposed.
 */

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

/**
 * Across the `vm` boundary, so `deepStrictEqual` can compare by VALUE.
 *
 * `runInNewContext` gives the sandbox its own realm, so an object or array the controller builds
 * has that realm's `Object.prototype` -- and `node:assert/strict` compares prototypes, so an
 * otherwise identical result fails with "same structure but not reference-equal". Nothing is wrong
 * with the value; it is the wrong realm. Round-tripping it rebuilds it in this one.
 */
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

// A derivation that filled a gap in a row somebody already built is unchanged: its own line, named
// by its own field, no subtext.
test('a plain filled-in field looks exactly as it did', () => {
  const rows = context()._proposalRows([{
    check: 'sap_derivations', target: 'Addresses', index: 0, field: 'Language', value: 'N',
    label: 'Country default', message: 'Country BE has address language N in S/4.'
  }], []);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].change, 'Filled in');
  assert.equal(rows[0].fieldLabel, 'Language');
  assert.equal(rows[0].subtext, '');
  assert.deepEqual(plain(rows[0].extras), []);
});

// A field derived and then reformatted is still one row -- applying both would write it twice.
test('a normalisation still merges into the derivation it reformats', () => {
  const rows = context()._proposalRows(
    [{ target: 'root', index: 0, field: 'OrganizationBPName1', value: 'alluvion bv', label: 'VIES check', message: 'VIES returned this name.' }],
    [{ target: 'root', index: 0, field: 'OrganizationBPName1', current: 'alluvion bv', proposed: 'Alluvion BV', reason: 'Legal form', detail: 'Legal forms are capitalised.' }]
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].proposed, 'Alluvion BV');
  assert.equal(rows[0].reason, 'VIES check', 'the derivation label still leads');
  assert.match(rows[0].detail, /Legal forms are capitalised/u, 'and the reformatting is in the tooltip');
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

/**
 * Idempotent on the whole key, not on the lead value: AG under a second sales area is a different
 * row, and refusing it because an AG exists somewhere else would silently drop a real proposal.
 */
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

function standardContext() {
  const state = { messages: [] };
  const controller = loadController();
  const ctx = Object.assign(Object.create(controller), {
    getView: () => ({ getModel: () => ({ getData: () => state, refresh() {} }) }),
    _renderAll() {},
    _rerunStandardChecks() { ctx.reran = true; return Promise.resolve(); },
    reran: false
  });
  return { ctx, state };
}

const CITY_REQUIRED = { severity: 'warning', message: 'City is required. [CVI_API/007]' };

/**
 * Nothing was accepted, so the payload is unchanged and the findings held back are exactly right.
 * **No second round trip, and no second vendor number** -- `i_test_run` draws one per run.
 */
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

// The message text is all there is: bp-check.js flattens every S/4 message to
// { severity, message }, formatting the class and number INTO the text and discarding S/4's own
// `field`. So nothing can know which finding a proposal would have cleared.
test('no message-to-field map was introduced to filter them instead', () => {
  const bpCheck = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'checks', 'bp-check.js'), 'utf8'
  );
  assert.match(bpCheck, /\.map\(\(message\) => \(\{ severity: cap\(message\.severity\), message: describe\(message\) \}\)\)/u);

  const resolve = CONTROLLER.slice(CONTROLLER.indexOf('_resolveStandardChecks: function'));
  const body = resolve.slice(0, resolve.indexOf('onSaveRequest: function'));
  assert.ok(body.includes('_rerunStandardChecks'), 'the slice covers both halves');
  assert.equal(/CVI_API|VMD_API|R11\/336|R1\/091/u.test(body), false, 'no curated message list');
});

// With nothing to propose there is no dialog to wait for, so they are the answer straight away and
// cost no extra call.
test('with nothing to propose the findings go up on the first press', () => {
  const check = CONTROLLER.slice(
    CONTROLLER.indexOf('onCheck: async function'),
    CONTROLLER.indexOf('onDuplicateCheck: async function')
  );
  assert.match(check, /proposals\.length \? \[\] : standard/u);
  assert.match(check, /this\._offerProposals\(proposals, standard\)/u);
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
