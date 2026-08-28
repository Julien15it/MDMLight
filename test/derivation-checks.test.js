'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createDerivationStages, invalidate, _internals } = require('../srv/checks/derivation-checks');
const { runDerivations } = require('../srv/checks/pipeline');

const {
  addressLanguageEntries, timeZoneEntries, taxCategoryEntries,
  partnerFunctionEntries, supplierFunctionEntries
} = _internals;

// T005 and TSTL as the service serves them. Column names are the view aliases, read from the live
// $metadata on 2026-08-27 rather than guessed -- see mdmlbpcheck/README.md.
const CONFIG = Object.freeze({
  countries: [
    { Country: 'BE', AddressLanguage: 'N', NameFormat: '01', IsEuCountry: true },
    { Country: 'DE', AddressLanguage: 'D', NameFormat: '01', IsEuCountry: true },
    // A country S/4 knows but has no language for: nothing to derive, and not an error.
    { Country: 'XX', AddressLanguage: '', NameFormat: '', IsEuCountry: false }
  ],
  taxCategories: [
    { Country: 'BE', SequenceNumber: '1', TaxCategory: 'MWST' },
    { Country: 'US', SequenceNumber: '1', TaxCategory: 'UTXJ' },
    { Country: 'US', SequenceNumber: '2', TaxCategory: 'UTX2' }
  ],
  timeZones: [
    { Country: 'BE', Region: 'VOV', AddressTimeZone: 'CET', IsDefault: true },
    // A region with two zones, one marked default -- what TZONEDFT is for.
    { Country: 'US', Region: 'NY', AddressTimeZone: 'EST', IsDefault: true },
    { Country: 'US', Region: 'NY', AddressTimeZone: 'UTC', IsDefault: false },
    // Two zones and NEITHER marked default: a customizing gap, not a coin toss.
    { Country: 'DE', Region: 'BY', AddressTimeZone: 'CET', IsDefault: false },
    { Country: 'DE', Region: 'BY', AddressTimeZone: 'UTC', IsDefault: false }
  ],
  // TKUPA -> TPAER -> TPAR as the view serves it. KUNA -> AG -> AG/RE/RG/WE is the real S4A chain.
  partnerFunctions: [
    { AccountGroup: 'KUNA', PartnerFunction: 'AG', DeterminationProcedure: 'AG', IsMandatory: true, SortOrder: '01', PartnerType: 'KU' },
    { AccountGroup: 'KUNA', PartnerFunction: 'RE', DeterminationProcedure: 'AG', IsMandatory: true, SortOrder: '02', PartnerType: 'KU' },
    // Not mandatory: a value help, not a derivation.
    { AccountGroup: 'KUNA', PartnerFunction: 'SB', DeterminationProcedure: 'AG', IsMandatory: false, SortOrder: '03', PartnerType: 'KU' },
    // A VENDOR function under the same procedure. NRART is what keeps it off a customer sales area.
    { AccountGroup: 'KUNA', PartnerFunction: 'LF', DeterminationProcedure: 'AG', IsMandatory: true, SortOrder: '04', PartnerType: 'LI' },
    { AccountGroup: 'DEBI', PartnerFunction: 'AG', DeterminationProcedure: 'AG', IsMandatory: true, SortOrder: '01', PartnerType: 'KU' }
  ],
  // The VENDOR side: T077K-PARGE -> TPAER -> TPAR. A different link, so its own fixture.
  supplierFunctions: [
    { AccountGroup: 'LIEF', PartnerFunction: 'LF', PurchasingOrgProcedure: '0001', IsMandatory: true, SortOrder: '01', PartnerType: 'LI' },
    { AccountGroup: 'LIEF', PartnerFunction: 'RS', PurchasingOrgProcedure: '0001', IsMandatory: true, SortOrder: '02', PartnerType: 'LI' },
    // Not mandatory.
    { AccountGroup: 'LIEF', PartnerFunction: 'BA', PurchasingOrgProcedure: '0001', IsMandatory: false, SortOrder: '03', PartnerType: 'LI' },
    // A CUSTOMER function under the same schema -- the mirror of the LF-on-a-customer case.
    { AccountGroup: 'LIEF', PartnerFunction: 'AG', PurchasingOrgProcedure: '0001', IsMandatory: true, SortOrder: '04', PartnerType: 'KU' }
  ]
});

const payload = (root = {}, sections = {}) => ({ root, sections });
const read = async () => CONFIG;

const stages = () => createDerivationStages({ read }).derivations;

test.beforeEach(() => invalidate());

// --- Address language ------------------------------------------------------

// The derivation that already cost a production bug: FSBP_GENERIC/008 fires on a blank LANGU, and
// a requester has no way of knowing the right answer when S/4 has known all along.
test('the address language is derived from the country', () => {
  const entries = addressLanguageEntries(
    payload({}, { Addresses: [{ Country: 'BE' }] }),
    CONFIG
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, 'Addresses');
  assert.equal(entries[0].index, 0);
  assert.equal(entries[0].field, 'Language');
  assert.equal(entries[0].value, 'N');
  assert.equal(entries[0].label, 'Country default');
  assert.match(entries[0].message, /S\/4 requires an address language/u);
});

// Unlike the registry lookup, this is not a fact about ONE place. Every address in a country has
// that country's default language.
test('every address row is derived, not only the first', () => {
  const entries = addressLanguageEntries(
    payload({}, { Addresses: [{ Country: 'BE' }, { Country: 'DE' }] }),
    CONFIG
  );

  assert.deepEqual(entries.map((entry) => [entry.index, entry.value]), [[0, 'N'], [1, 'D']]);
});

test('a typed language is left alone, and so is a row with no country', () => {
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ Country: 'BE', Language: 'E' }] }), CONFIG),
    []
  );
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ CityName: 'Gent' }] }), CONFIG),
    []
  );
});

test('a country S/4 has no language for derives nothing, and is not an error', () => {
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ Country: 'XX' }] }), CONFIG),
    []
  );
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ Country: 'ZZ' }] }), CONFIG),
    []
  );
});

test('a row on its way out is not derived onto', () => {
  assert.deepEqual(
    addressLanguageEntries(payload({}, { Addresses: [{ Country: 'BE', action: 'D' }] }), CONFIG),
    []
  );
});

// --- Time zone -------------------------------------------------------------

test('the time zone is derived from country and region', () => {
  const entries = timeZoneEntries(
    payload({}, { Addresses: [{ Country: 'BE', Region: 'VOV' }] }),
    CONFIG
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].field, 'AddressTimeZone');
  assert.equal(entries[0].value, 'CET');
  assert.equal(entries[0].label, 'Region default');
});

// TZONEDFT is what makes this a derivation rather than a validity list.
test('a region with several zones takes the one S/4 marks default', () => {
  const entries = timeZoneEntries(
    payload({}, { Addresses: [{ Country: 'US', Region: 'NY' }] }),
    CONFIG
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 'EST');
  assert.match(entries[0].message, /the default of several/u);
});

// A customizing gap, not an invitation to pick one.
test('several zones and none marked default derives nothing', () => {
  const entries = timeZoneEntries(
    payload({}, { Addresses: [{ Country: 'DE', Region: 'BY' }] }),
    CONFIG
  );
  assert.deepEqual(entries.filter((entry) => entry.field), []);
});

// Maarten's rule, 2026-08-27: a requester never reads "you could have X if you filled in Y". They
// fill in what they know and the system completes what it can.
test('an address with no region derives nothing AND says nothing', () => {
  const entries = timeZoneEntries(
    payload({}, { Addresses: [{ Country: 'BE' }, { Country: 'US' }] }),
    CONFIG
  );
  assert.deepEqual(entries, [], 'no proposal and no strip about the missing region');
});

test('a typed time zone, an unknown region and a missing country all derive nothing', () => {
  const cases = [
    { Country: 'BE', Region: 'VOV', AddressTimeZone: 'UTC' },
    { Country: 'BE', Region: 'ZZZ' },
    { Region: 'VOV' }
  ];
  for (const row of cases) {
    assert.deepEqual(
      timeZoneEntries(payload({}, { Addresses: [row] }), CONFIG).filter((entry) => entry.field),
      [],
      JSON.stringify(row)
    );
  }
});

// --- Tax categories --------------------------------------------------------

test('a customer request proposes the tax category valid for its country', () => {
  const entries = taxCategoryEntries(
    payload({}, { Addresses: [{ Country: 'BE' }], Customers: [{ CustomerAccountGroup: 'KUNA' }] }),
    CONFIG
  );

  // TWO entries for one row: createsRow writes one field, so a second fills the row it made.
  assert.equal(entries.length, 2);
  assert.equal(entries[0].target, 'CustomerTaxIndicators');
  assert.equal(entries[0].field, 'CustomerTaxCategory');
  assert.equal(entries[0].value, 'MWST');
  assert.equal(entries[0].createsRow, true);
  // The classification is a decision about this customer, not something customizing knows.
  assert.match(entries[0].message, /for you to fill in/u);
  assert.equal(entries[1].field, 'DepartureCountry');
  assert.equal(entries[1].value, 'BE');
  assert.equal(entries[1].createsRow, undefined, 'the row exists by the time this one applies');
});

// Half a KNVI key would be worse than no row at all.
test('the created tax row carries both the category and the departure country', async () => {
  const request = payload({}, {
    Addresses: [{ Country: 'BE' }],
    Customers: [{ CustomerAccountGroup: 'KUNA' }]
  });
  const { derived } = await runDerivations(request, stages());

  assert.deepEqual(derived.sections.CustomerTaxIndicators, [
    { CustomerTaxCategory: 'MWST', DepartureCountry: 'BE' }
  ]);
});

// A silent partial answer would read as "these are all of them", which is the answer this codebase
// refuses everywhere else.
test('a country with several categories says how many, rather than covering one silently', () => {
  const entries = taxCategoryEntries(
    payload({}, { Addresses: [{ Country: 'US' }], Customers: [{}] }),
    CONFIG
  );

  // Three entries: the proposed category, the DepartureCountry that always rides along with it
  // (without it the row would carry a tax category and no departure country, half a KNVI key), and
  // the ambiguity statement - a silent partial answer would read as "these are all of them".
  assert.equal(entries.length, 3);
  assert.equal(entries[0].value, 'UTXJ', 'the lowest sequence number is the one proposed');
  assert.equal(entries[1].field, 'DepartureCountry');
  assert.equal(entries[1].value, 'US');
  // The third entry carries no field: a statement, not a value, so it renders as a strip.
  assert.equal(entries[2].field, undefined);
  assert.match(entries[2].message, /2 tax categories/u);
  assert.match(entries[2].message, /UTXJ, UTX2/u);
});

test('nothing is proposed without a customer, a country, or into rows somebody added', () => {
  const country = { Addresses: [{ Country: 'BE' }] };
  // Not a customer request at all.
  assert.deepEqual(taxCategoryEntries(payload({}, country), CONFIG), []);
  // No address, so no departure country.
  assert.deepEqual(taxCategoryEntries(payload({}, { Customers: [{}] }), CONFIG), []);
  // The requester already filled the section in; those rows are theirs.
  assert.deepEqual(
    taxCategoryEntries(payload({}, {
      ...country,
      Customers: [{}],
      CustomerTaxIndicators: [{ CustomerTaxCategory: 'MWST' }]
    }), CONFIG),
    []
  );
  // A country with no tax categories at all.
  assert.deepEqual(
    taxCategoryEntries(payload({}, { Addresses: [{ Country: 'DE' }], Customers: [{}] }), CONFIG),
    []
  );
});

// --- Partner functions -----------------------------------------------------

const customerWithSalesArea = {
  Customers: [{ CustomerAccountGroup: 'KUNA' }],
  CustomerSalesArea: [{ SalesOrganization: '1710', DistributionChannel: '10', Division: '00' }]
};

test('the mandatory partner function is proposed with its sales area', () => {
  const entries = partnerFunctionEntries(payload({}, customerWithSalesArea), CONFIG);

  const [first] = entries;
  assert.equal(first.target, 'CustomerSalesPartnerFunctions');
  assert.equal(first.field, 'PartnerFunction');
  assert.equal(first.value, 'AG', 'the lowest SortOrder mandatory function');
  assert.equal(first.createsRow, true);
  assert.equal(first.label, 'Mandatory function');
  assert.match(first.message, /left for S\/4 to assign at post time/u);

  // The sales area completes the key, from the row the requester already added.
  const byField = new Map(entries.filter((entry) => entry.field).map((e) => [e.field, e.value]));
  assert.equal(byField.get('SalesOrganization'), '1710');
  assert.equal(byField.get('DistributionChannel'), '10');
  assert.equal(byField.get('Division'), '00');
});

// Decided 2026-08-27: SAP defaults these to the customer itself, which on a create has no number,
// and PartnerCounter is S/4's to assign.
test('neither the partner number nor the counter is ever proposed', () => {
  const fields = partnerFunctionEntries(payload({}, customerWithSalesArea), CONFIG)
    .filter((entry) => entry.field)
    .map((entry) => entry.field);

  assert.equal(fields.includes('BPCustomerNumber'), false);
  assert.equal(fields.includes('PartnerCounter'), false);
});

// NRART is the guard. A vendor function on a customer sales area is the same class of error
// accountGroupConflictFindings reports.
test('a vendor function under the same procedure is never proposed onto a customer', () => {
  const entries = partnerFunctionEntries(payload({}, customerWithSalesArea), CONFIG);
  const proposed = entries.filter((entry) => entry.field === 'PartnerFunction').map((e) => e.value);

  assert.equal(proposed.includes('LF'), false, 'LF is PartnerType LI, a vendor function');
});

test('a non-mandatory function is a value help, not a derivation', () => {
  const entries = partnerFunctionEntries(payload({}, customerWithSalesArea), CONFIG);
  const proposed = entries.filter((entry) => entry.field === 'PartnerFunction')
    .map((entry) => entry.value);

  assert.equal(proposed.includes('SB'), false, 'SB is not mandatory');
  const named = entries.map((entry) => entry.message).join(' ');
  assert.equal(/\bSB\b/u.test(named), false, 'and it is never mentioned either');
});

/**
 * **ALL of them (2026-08-28).** It proposed the first and named the rest in a statement, because
 * `createsRow` could only invent a row into an empty section. `rowKey` lifted that, so every
 * mandatory function of the procedure is its own proposal -- and the statement is gone with it.
 */
test('every mandatory function is proposed, each as its own keyed row', () => {
  const entries = partnerFunctionEntries(payload({}, customerWithSalesArea), CONFIG);

  const created = entries.filter((entry) => entry.createsRow);
  assert.deepEqual(created.map((entry) => entry.value), ['AG', 'RE'], 'in SortOrder');
  for (const entry of created) {
    assert.deepEqual(entry.rowKey, {
      PartnerFunction: entry.value,
      SalesOrganization: '1710', DistributionChannel: '10', Division: '00'
    }, 'the key names the function AND the sales area it is for');
  }

  // Every entry of one row carries that row's key, which is how the three that complete the sales
  // area find the row the first one made. Nothing counts indices any more.
  const forRe = entries.filter((entry) => entry.rowKey?.PartnerFunction === 'RE');
  assert.deepEqual(forRe.map((entry) => entry.field).sort(),
    ['DistributionChannel', 'Division', 'PartnerFunction', 'SalesOrganization']);

  assert.equal(entries.some((entry) => !entry.field), false,
    'and no "add the others by hand" statement is left');
});

// The rule again: no sales area, no derivation, and no strip telling them to add one.
test('no sales area and no account group stay silent', () => {
  const cases = [
    { Customers: [{ CustomerAccountGroup: 'KUNA' }] },
    { CustomerSalesArea: [{ SalesOrganization: '1710' }] },
    { ...customerWithSalesArea, Customers: [{}] },
    // An account group TKUPA has no procedure for.
    { ...customerWithSalesArea, Customers: [{ CustomerAccountGroup: 'VVD' }] }
  ];
  for (const sections of cases) {
    assert.deepEqual(
      partnerFunctionEntries(payload({}, sections), CONFIG),
      [],
      JSON.stringify(sections)
    );
  }
});

/**
 * A filled section used to stop the whole derivation -- "those rows are theirs". It only ever had
 * to stop it for the rows that ARE theirs: the key is per function, so what is missing is still
 * missing whether or not somebody has started the section.
 */
test('a function the requester typed is left alone, and the rest are still proposed', async () => {
  const sections = {
    ...customerWithSalesArea,
    CustomerSalesPartnerFunctions: [{ PartnerFunction: 'AG' }]
  };
  const entries = partnerFunctionEntries(payload({}, sections), CONFIG);
  assert.deepEqual(
    entries.filter((entry) => entry.createsRow).map((entry) => entry.value),
    ['AG', 'RE'],
    'the stage offers both; the pipeline is what drops the one already there'
  );

  const { derived, applied } = await runDerivations(payload({}, sections), stages());
  assert.deepEqual(derived.sections.CustomerSalesPartnerFunctions, [
    // Theirs, with the key it was missing filled in -- never duplicated.
    { PartnerFunction: 'AG', SalesOrganization: '1710', DistributionChannel: '10', Division: '00' },
    { PartnerFunction: 'RE', SalesOrganization: '1710', DistributionChannel: '10', Division: '00' }
  ]);
  assert.equal(
    applied.filter((entry) => entry.createsRow).length, 1,
    'and only the missing row is reported as added'
  );
});

test('the created rows each carry their function and the whole sales area key', async () => {
  const { derived, applied } = await runDerivations(payload({}, customerWithSalesArea), stages());

  assert.deepEqual(derived.sections.CustomerSalesPartnerFunctions, [
    { PartnerFunction: 'AG', SalesOrganization: '1710', DistributionChannel: '10', Division: '00' },
    { PartnerFunction: 'RE', SalesOrganization: '1710', DistributionChannel: '10', Division: '00' }
  ]);

  // The reported index is where the row actually landed, which is what lets the dialog group the
  // four entries of one row into one line.
  const indices = new Map();
  for (const entry of applied.filter((e) => e.target === 'CustomerSalesPartnerFunctions')) {
    if (!indices.has(entry.rowKey.PartnerFunction)) indices.set(entry.rowKey.PartnerFunction, []);
    indices.get(entry.rowKey.PartnerFunction).push(entry.index);
  }
  assert.deepEqual(indices.get('AG'), [0, 0, 0, 0]);
  assert.deepEqual(indices.get('RE'), [1, 1, 1, 1]);
});

// A blank level is not a key: matched against a row that HAS that level it would fail, and the
// section would collect a second copy of every row.
test('a sales area with no division keys on the two levels that are filled in', () => {
  const entries = partnerFunctionEntries(payload({}, {
    Customers: [{ CustomerAccountGroup: 'KUNA' }],
    CustomerSalesArea: [{ SalesOrganization: '1710', DistributionChannel: '10' }]
  }), CONFIG);

  const [first] = entries;
  assert.deepEqual(first.rowKey, {
    PartnerFunction: 'AG', SalesOrganization: '1710', DistributionChannel: '10'
  });
  assert.equal(entries.some((entry) => entry.field === 'Division'), false);
});

// --- Supplier partner functions --------------------------------------------

const supplierWithPurchasingOrg = {
  Suppliers: [{ SupplierAccountGroup: 'LIEF' }],
  SupplierPurchasingOrg: [{ PurchasingOrganization: '1710' }]
};

test('the mandatory supplier function is proposed with its purchasing organisation', () => {
  const entries = supplierFunctionEntries(payload({}, supplierWithPurchasingOrg), CONFIG);

  const [first] = entries;
  assert.equal(first.target, 'SupplierPartnerFunctions');
  assert.equal(first.field, 'PartnerFunction');
  assert.equal(first.value, 'LF', 'the lowest SortOrder mandatory vendor function');
  assert.equal(first.createsRow, true);
  assert.match(first.message, /partner schema 0001/u);

  const byField = new Map(entries.filter((entry) => entry.field).map((e) => [e.field, e.value]));
  assert.equal(byField.get('PurchasingOrganization'), '1710');
});

// The mirror of the customer guard: procedure 0001 carries AG (a customer function) too.
test('a customer function under the same schema is never proposed onto a supplier', () => {
  const proposed = supplierFunctionEntries(payload({}, supplierWithPurchasingOrg), CONFIG)
    .filter((entry) => entry.field === 'PartnerFunction')
    .map((entry) => entry.value);

  assert.equal(proposed.includes('AG'), false, 'AG is PartnerType KU, a customer function');
});

// The lower two levels each have their own partner schema; a purchasing-org row leaves them blank.
test('the subrange and plant are never filled by the purchasing-org derivation', () => {
  const fields = supplierFunctionEntries(payload({}, supplierWithPurchasingOrg), CONFIG)
    .filter((entry) => entry.field)
    .map((entry) => entry.field);

  assert.equal(fields.includes('SupplierSubrange'), false);
  assert.equal(fields.includes('Plant'), false);
  assert.equal(fields.includes('PartnerCounter'), false);
  assert.equal(fields.includes('ReferenceSupplier'), false);
});

test('no purchasing org and no account group stay silent', () => {
  const cases = [
    { Suppliers: [{ SupplierAccountGroup: 'LIEF' }] },
    { SupplierPurchasingOrg: [{ PurchasingOrganization: '1710' }] },
    { ...supplierWithPurchasingOrg, Suppliers: [{}] },
    { ...supplierWithPurchasingOrg, Suppliers: [{ SupplierAccountGroup: 'ZZZZ' }] }
  ];
  for (const sections of cases) {
    assert.deepEqual(
      supplierFunctionEntries(payload({}, sections), CONFIG),
      [],
      JSON.stringify(sections)
    );
  }
});

// The customer stage's own change, mirrored: all of them, keyed per function, and a function the
// requester typed is filled rather than duplicated.
test('every mandatory supplier function is proposed, keyed on its purchasing organisation', async () => {
  const entries = supplierFunctionEntries(payload({}, supplierWithPurchasingOrg), CONFIG);
  assert.deepEqual(
    entries.filter((entry) => entry.createsRow).map((entry) => entry.value),
    ['LF', 'RS']
  );
  assert.deepEqual(entries[0].rowKey, { PartnerFunction: 'LF', PurchasingOrganization: '1710' });
  assert.equal(entries.some((entry) => !entry.field), false, 'and nothing is merely named');

  const { derived } = await runDerivations(payload({}, {
    ...supplierWithPurchasingOrg,
    SupplierPartnerFunctions: [{ PartnerFunction: 'LF' }]
  }), stages());
  assert.deepEqual(derived.sections.SupplierPartnerFunctions, [
    { PartnerFunction: 'LF', PurchasingOrganization: '1710' },
    { PartnerFunction: 'RS', PurchasingOrganization: '1710' }
  ]);
});

// Both sides fire on one request, into their own sections, without crossing over.
test('a request that is both a customer and a supplier derives both, separately', async () => {
  const request = payload({}, {
    ...customerWithSalesArea,
    Suppliers: [{ SupplierAccountGroup: 'LIEF' }],
    SupplierPurchasingOrg: [{ PurchasingOrganization: '1710' }]
  });
  const { derived } = await runDerivations(request, stages());

  assert.deepEqual(derived.sections.CustomerSalesPartnerFunctions, [
    { PartnerFunction: 'AG', SalesOrganization: '1710', DistributionChannel: '10', Division: '00' },
    { PartnerFunction: 'RE', SalesOrganization: '1710', DistributionChannel: '10', Division: '00' }
  ]);
  assert.deepEqual(derived.sections.SupplierPartnerFunctions, [
    { PartnerFunction: 'LF', PurchasingOrganization: '1710' },
    { PartnerFunction: 'RS', PurchasingOrganization: '1710' }
  ]);
});

// --- Through the pipeline --------------------------------------------------

test('the stage reaches the payload through the pipeline, as a proposal', async () => {
  const request = payload({}, { Addresses: [{ Country: 'BE', Region: 'VOV', CityName: 'Gent' }] });
  const { derived, applied } = await runDerivations(request, stages());

  assert.equal(derived.sections.Addresses[0].Language, 'N');
  assert.equal(derived.sections.Addresses[0].AddressTimeZone, 'CET');
  assert.equal(applied.length, 2);
  assert.equal(applied.every((entry) => entry.check === 'sap_derivations'), true);
  assert.deepEqual(applied.map((entry) => entry.label), ['Country default', 'Region default']);
});

// The flag says "S/4 will use this whatever anyone ticks" -- true of the CVI account group and of
// nothing here. A country default is a proposal like any other.
test('nothing here is a system derivation, so the standard checks never see it unaccepted', async () => {
  const request = payload({}, { Addresses: [{ Country: 'BE', Region: 'VOV' }] });
  const { applied, systemDerived } = await runDerivations(request, stages());

  // Only the entries that write: a field-less statement carries no `system` flag at all, because
  // the pipeline shapes it as a plain info message.
  const written = applied.filter((entry) => entry.field);
  assert.equal(written.length, 2);
  assert.equal(written.every((entry) => entry.system === false), true);
  assert.equal(systemDerived.sections.Addresses[0].Language, undefined);
  assert.equal(systemDerived.sections.Addresses[0].AddressTimeZone, undefined);
});

test('the payload the requester typed is never mutated', async () => {
  const request = payload({}, { Addresses: [{ Country: 'BE' }] });
  await runDerivations(request, stages());
  assert.equal(request.sections.Addresses[0].Language, undefined);
});

// An improvement, not a gate -- the same discipline cvi-checks.js applies to an unreadable config.
test('settings that cannot be read report themselves and never block', async () => {
  const failing = createDerivationStages({
    read: async () => { throw new Error('destination is away'); }
  }).derivations;

  const { applied, derived } = await runDerivations(
    payload({}, { Addresses: [{ Country: 'BE' }] }),
    failing
  );

  assert.equal(applied.length, 1);
  assert.equal(applied[0].severity, 'info');
  assert.match(applied[0].message, /could not be read \(destination is away\)/u);
  assert.equal(derived.sections.Addresses[0].Language, undefined);
});

test('the settings are read once and cached across runs', async () => {
  let reads = 0;
  const counting = createDerivationStages({
    read: async () => { reads += 1; return CONFIG; }
  }).derivations;

  await runDerivations(payload({}, { Addresses: [{ Country: 'BE' }] }), counting);
  await runDerivations(payload({}, { Addresses: [{ Country: 'DE' }] }), counting);
  assert.equal(reads, 1);
});

// --- Wiring ----------------------------------------------------------------

test('the stage runs on Check and Duplicate Check, and still not on submit', () => {
  const serviceJs = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
  );

  assert.match(serviceJs, /createDerivationStages\(\)\.derivations/u);
  // LAST in the list: the pipeline never overwrites, so a steward's rule and a register lookup
  // both outrank a country default.
  assert.match(
    serviceJs,
    /createCviStages\(\)\.derivations, \.\.\.createDerivationStages\(\)\.derivations\]/u
  );
  // Submit still validates without deriving, unchanged since 2026-08-13.
  const submit = serviceJs.slice(serviceJs.indexOf("this.on('submitRequest'"));
  assert.equal(/createDerivationStages/u.test(submit), false);
});


// --- Diagnostics -----------------------------------------------------------

/**
 * Maarten, 2026-08-27: account group `DEBI`, one sales area row, no partner-function rows, and the
 * customizing confirmed by hand -- `DEBI` -> `AG` -> `AG, RE, RG, WE` mandatory, `PartnerType` KU.
 * Nothing was proposed, and because the stage says nothing about unmet preconditions there was no
 * way to tell WHICH guard stopped it. Two wrong guesses later, this is the instrumentation.
 *
 * The first half is the case itself, pinned as a regression: that payload against that config must
 * produce the AG proposal.
 */
test('the DEBI case proposes AG, and the stage logs what it saw', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));

  let entries;
  try {
    entries = await stages()[0].run(payload(
      { BusinessPartnerCategory: '2', BusinessPartnerGrouping: '0001' },
      {
        Addresses: [{ Country: 'BE', Language: 'N', CityName: 'Destelbergen' }],
        Customers: [{ CustomerAccountGroup: 'DEBI' }],
        CustomerSalesArea: [{ SalesOrganization: '0001', DistributionChannel: '01', Division: '01' }],
        CustomerTaxIndicators: [{ CustomerTaxCategory: 'MWST', DepartureCountry: 'BE' }],
        CustomerSalesPartnerFunctions: []
      }
    ));
  } finally {
    console.log = original;
  }

  const proposed = entries.filter((entry) => entry.target === 'CustomerSalesPartnerFunctions');
  assert.equal(proposed[0].field, 'PartnerFunction');
  assert.equal(proposed[0].value, 'AG');
  assert.equal(proposed[0].createsRow, true);

  const [diagnostic] = lines.filter((line) => line.startsWith('[sap-derivations] '));
  assert.ok(diagnostic, 'the stage logged one diagnostic line');
  const seen = JSON.parse(diagnostic.slice('[sap-derivations] '.length));

  // The row counts, because an empty read looks exactly like customizing that says nothing -- which
  // is the ambiguity that cost two rounds.
  assert.equal(seen.config.partnerFunctions, CONFIG.partnerFunctions.length);
  assert.equal(seen.config.taxCategories, CONFIG.taxCategories.length);
  // And every field the five builders branch on.
  assert.equal(seen.payload.customerAccountGroup, 'DEBI');
  assert.equal(seen.payload.salesAreas, 1);
  assert.equal(seen.payload.customerFunctionRows, 0);
  assert.equal(seen.payload.addressLanguage, 'N');
  assert.equal(seen.payload.addressRegion, '', 'no region is why the time zone stayed silent');
  assert.equal(seen.payload.taxIndicatorRows, 1, 'and rows already there are why tax did');
  assert.equal(seen.entries, entries.length);
});

// A derivation that had nothing to do must still say so: the whole point is telling that apart from
// a read that came back empty.
test('the diagnostic is logged even when nothing was derived', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await stages()[0].run(payload({}, {}));
  } finally {
    console.log = original;
  }
  const [diagnostic] = lines.filter((line) => line.startsWith('[sap-derivations] '));
  assert.ok(diagnostic);
  const seen = JSON.parse(diagnostic.slice('[sap-derivations] '.length));
  assert.equal(seen.entries, 0);
  assert.equal(seen.payload.addresses, 0);
  assert.equal(seen.payload.customerAccountGroup, '');
});
