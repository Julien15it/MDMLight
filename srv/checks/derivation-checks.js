'use strict';

/**
 * The SPRO derivations, read over `DerivationConfigService`'s remote sets
 * (`srv/derivation-config-service.cds`).
 *
 * **Why these are re-derived app-side rather than asked of S/4.** Four probe rounds established
 * that S/4 has no callable way to say what it would derive: `CL_MD_BP_MAINTAIN` is final, the only
 * two methods that hand the payload back enriched are protected and private respectively, and all
 * eight public methods take the payload as `IMPORTING`. A real `MAINTAIN` rolled back would harvest
 * everything but cannot be what a Check button does -- it creates the partner, and number
 * assignment commits outside the LUW. See `mdmlbpcheck/README.md`.
 *
 * So each derivation reads its own customizing, exactly the way `cvi_account_group` reads `TBD001`.
 * The pipeline's own guarantees carry the rest: a derivation never overwrites a typed value, and it
 * invents a row only when the section is completely empty.
 *
 * **None of these is `system: true`.** That flag says "S/4 will use this whatever anyone ticks",
 * which is true of the CVI account group and of nothing here -- a country's default language is a
 * proposal like any other, and the requester ticks it.
 */

const cds = require('@sap/cds');

const { readAllOf } = require('./config-reader');

const SERVICE = 'ZSRVB_MDMLIGHT_VH';

// Same 15-minute TTL as cvi-checks.js, rule-store.js and field-property-store.js. This is
// customizing: it changes when somebody transports, not while a form is being filled in, and
// this app cannot write it - see the note there on what the longer window costs.
const TTL_MS = 900000;

let cache = null;

function invalidate() {
  cache = null;
}

async function readConfiguration() {
  const service = await cds.connect.to(SERVICE);
  // Paged, not a bare SELECT: the remote service caps a response at 100 rows, and a first page used
  // as the whole table is what silently lost account group DEBI. See config-reader.js.
  const [countries, taxCategories, timeZones, partnerFunctions, supplierFunctions] = await readAllOf(
    service,
    ['DerAddressDefaults', 'DerTaxCategories', 'DerTimeZones',
      'DerPartnerFunctionAccGrp', 'DerSupplierFunctionAccGrp']
  );
  return {
    countries: Array.isArray(countries) ? countries : [],
    taxCategories: Array.isArray(taxCategories) ? taxCategories : [],
    timeZones: Array.isArray(timeZones) ? timeZones : [],
    partnerFunctions: Array.isArray(partnerFunctions) ? partnerFunctions : [],
    supplierFunctions: Array.isArray(supplierFunctions) ? supplierFunctions : []
  };
}

async function configuration(read = readConfiguration, now = Date.now()) {
  if (cache && cache.until > now) return cache.value;
  const value = await read();
  cache = { value, until: now + TTL_MS };
  return value;
}

const text = (value) => String(value === null || value === undefined ? '' : value).trim();

/** The rows of a section that will still exist after the request posts. */
function liveRows(payload, section) {
  const rows = payload?.sections?.[section];
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => text(row?.action || 'C').toUpperCase() !== 'D');
}

/**
 * The address language, from `T005-SPRAS`.
 *
 * This is the derivation that already cost a production bug: `ADDR1_DATA-LANGU` is required by S/4
 * (`FSBP_GENERIC/008`) and nothing filled it, so every request had to have it typed in by hand --
 * a field a requester has no way of knowing the right answer for, when S/4 has known all along.
 *
 * Every address row, not only the first: unlike the registry lookup, this is not a fact about ONE
 * place that a second address would be wrong to inherit. Every address in a country has that
 * country's default language.
 */
function addressLanguageEntries(payload, { countries }) {
  const byCountry = new Map(countries.map((row) => [text(row.Country), row]));
  const entries = [];

  liveRows(payload, 'Addresses').forEach((row, index) => {
    const country = text(row?.Country);
    if (!country) return;
    // Already answered. The pipeline would refuse to overwrite it anyway; not proposing it keeps
    // the dialog to things the requester can actually act on.
    if (text(row?.Language)) return;

    const language = text(byCountry.get(country)?.AddressLanguage);
    if (!language) return;

    entries.push({
      target: 'Addresses',
      index,
      field: 'Language',
      value: language,
      label: 'Country default',
      message: `Address language ${language} is the default for country ${country} in the S/4 `
        + 'country settings, and S/4 requires an address language.'
    });
  });

  return entries;
}

/**
 * The address time zone, from `TTZ5S`.
 *
 * **Keyed by country AND region**, which is the whole shape of this one: `TTZ5S` assigns zones to
 * regions, not to postal codes, so an address with no region has nothing to derive — and nothing is
 * said about it.
 *
 * `AddressTimeZone` is part of the key, so a country + region may carry several zones. `IsDefault`
 * is what makes this a derivation rather than a validity list: propose the row S/4 marks default,
 * and fall silent when none is marked. That is better than "only when exactly one matches" -- a
 * region with three zones still derives.
 */
function timeZoneEntries(payload, { timeZones }) {
  const entries = [];

  liveRows(payload, 'Addresses').forEach((row, index) => {
    const country = text(row?.Country);
    if (!country) return;
    if (text(row?.AddressTimeZone)) return;

    // No region, nothing to derive, and NOTHING SAID. Maarten's rule, 2026-08-27: a requester does
    // not need to read "you could have X if you filled in Y". They fill in what they know and the
    // system completes what it can. Telling them otherwise is a strip they cannot act on and did
    // not ask for.
    const region = text(row?.Region);
    if (!region) return;

    const matches = timeZones.filter(
      (entry) => text(entry.Country) === country && text(entry.Region) === region
    );
    if (!matches.length) return;

    // The default, or nothing. A region with several zones and none marked default is a
    // customizing gap, not an invitation to pick one.
    const preferred = matches.length === 1 ? matches[0] : matches.find((entry) => entry.IsDefault);
    const zone = text(preferred?.AddressTimeZone);
    if (!zone) return;

    entries.push({
      target: 'Addresses',
      index,
      field: 'AddressTimeZone',
      value: zone,
      label: 'Region default',
      message: `Time zone ${zone} is assigned to region ${region} in country ${country} in the `
        + `S/4 time zone settings${matches.length > 1 ? ', and is the default of several' : ''}.`
    });
  });

  return entries;
}

/**
 * The customer tax classification rows, from `TSTL`.
 *
 * A genuinely multi-row derivation, and the only one here: a Belgian customer gets one
 * `CustomerTaxIndicators` row per tax category valid for BE, in S/4's own sequence. What S/4
 * proposes is the ROWS -- `DepartureCountry` + `CustomerTaxCategory`. **`CustomerTaxClassification`
 * is deliberately left empty**: it is a business decision about this customer, not something any
 * customizing table knows, so proposing a value would be inventing one.
 *
 * The pipeline creates a row only when the section is EMPTY, and only its first row, so this can
 * propose exactly one -- the lowest sequence number. A requester who has already added tax rows
 * keeps theirs untouched, and the rest of a multi-category country stays a manual add until the
 * pipeline can propose more than one row.
 *
 * **The remaining categories ARE named**, and that is not the same thing as the prerequisite
 * messages this file no longer emits: it reports what the derivation did and did not cover, not
 * what the requester should go and type first. "One of five" read as "all of them" is the wrong
 * answer; "fill in a region and you could have a time zone" is merely unasked-for advice.
 */
function taxCategoryEntries(payload, { taxCategories }) {
  // The departure country is the partner's own address country -- the tax country of a customer is
  // where they are, and nothing else in the payload carries one.
  const [address] = liveRows(payload, 'Addresses');
  const country = text(address?.Country);
  if (!country) return [];

  // Only a request that asks to BE a customer has tax classifications to propose.
  if (!liveRows(payload, 'Customers').length) return [];

  // A_CustomerSalesAreaTax posts UNDER a sales area, so a row without that key is refused at post
  // time -- "enter required field(s) ... SalesOrganization" on an approved request, 2026-08-28.
  // No sales area, nothing that can be keyed, and nothing said: Maarten's rule.
  const [salesArea] = liveRows(payload, 'CustomerSalesArea');
  if (!salesArea) return [];

  const forCountry = taxCategories
    .filter((row) => text(row.Country) === country)
    .sort((left, right) => text(left.SequenceNumber).localeCompare(text(right.SequenceNumber)));
  if (!forCountry.length) return [];

  // Not into a section somebody has already filled: those rows are theirs.
  if (liveRows(payload, 'CustomerTaxIndicators').length) return [];

  const [first, ...remaining] = forCountry;
  // TWO entries for one row, because `createsRow` writes exactly one field. The second finds the
  // row the first just made: runDerivations applies each entry to `derived` as it goes, so within
  // one stage a later entry sees an earlier entry's row. Without it the row would carry a tax
  // category and no departure country, which is half a KNVI key.
  const entries = [{
    target: 'CustomerTaxIndicators',
    index: 0,
    createsRow: true,
    field: 'CustomerTaxCategory',
    value: text(first.TaxCategory),
    label: 'Country tax category',
    message: `Tax category ${text(first.TaxCategory)} is valid for country ${country} in the S/4 `
      + 'tax settings. The classification itself is a decision about this customer, so it is left '
      + 'for you to fill in.'
  }, {
    target: 'CustomerTaxIndicators',
    index: 0,
    field: 'DepartureCountry',
    value: country,
    label: 'Address country',
    message: `Departure country ${country} is taken from the partner's own address — the tax `
      + 'country of a customer is where they are.'
  }];

  // The sales area the row posts under. Without these three the row stages fine and is refused at
  // post time, which is the one failure a Check cannot see: the pipeline never evaluates
  // requiredCreateFields, only postToS4 does.
  for (const [field, value] of [
    ['SalesOrganization', text(salesArea.SalesOrganization)],
    ['DistributionChannel', text(salesArea.DistributionChannel)],
    ['Division', text(salesArea.Division)]
  ]) {
    if (!value) continue;
    entries.push({
      target: 'CustomerTaxIndicators',
      index: 0,
      field,
      value,
      label: 'Sales area',
      message: `${field} ${value} is taken from the sales area on this request — the tax `
        + 'classification posts under it.'
    });
  }

  // A country with several categories: the pipeline can only create the FIRST row of an empty
  // section, so the others are named rather than dropped. A derivation that silently covered two
  // of five would read as "these are all of them", which is the answer this codebase refuses.
  if (remaining.length) {
    entries.push({
      message: `Country ${country} has ${forCountry.length} tax categories in S/4 `
        + `(${forCountry.map((row) => text(row.TaxCategory)).join(', ')}). One row is proposed; `
        + 'add the others by hand if this customer needs them.'
    });
  }

  return entries;
}

/**
 * The mandatory customer partner functions, from `TKUPA` -> `TPAER`.
 *
 * The chain, and every link of it was probed rather than assumed: grouping -> customer account
 * group (`TBD001`, already derived by `cvi_account_group`) -> determination procedure (`TKUPA`,
 * keyed by account group alone) -> the functions that procedure marks mandatory (`TPAER-PAPFL`).
 * Measured on S4A: `0002` -> `KUNA` -> `AG` -> `AG, RE, RG, WE`.
 *
 * **Only `PartnerType` = 'KU' rows.** `TPAR-NRART` says which side a function belongs to, and a
 * vendor function proposed onto a customer sales area is the same class of error
 * `accountGroupConflictFindings` reports. Filtering here rather than trusting the procedure.
 *
 * **`BPCustomerNumber` and `PartnerCounter` are left empty**, decided 2026-08-27. SAP defaults these
 * four functions to the customer itself, which on a create has no number yet; and `PartnerCounter`
 * is S/4's to assign. So the derivation proposes the FUNCTION, and S/4 fills the rest at post time.
 *
 * Needs a sales area row, because `StagedCustomerSalesPartnerFunc` is keyed by one. When there is
 * none it derives nothing **and says nothing** -- see the time zone above for why.
 *
 * **All of them since 2026-08-28**, keyed per function, and beside what a requester typed. See
 * CLAUDE.md.
 */
function partnerFunctionEntries(payload, { partnerFunctions }) {
  const [salesArea] = liveRows(payload, 'CustomerSalesArea');
  if (!salesArea) return [];

  const accountGroup = text(liveRows(payload, 'Customers')[0]?.CustomerAccountGroup);
  if (!accountGroup) return [];

  const mandatory = partnerFunctions
    .filter((row) => text(row.AccountGroup) === accountGroup)
    .filter((row) => row.IsMandatory)
    .filter((row) => text(row.PartnerType) === 'KU')
    .sort((left, right) => text(left.SortOrder).localeCompare(text(right.SortOrder)));
  if (!mandatory.length) return [];

  // The sales area every proposed row belongs to, from the row the requester already added. Part of
  // each row's key, so a function typed against a DIFFERENT sales area is not mistaken for this one.
  // Only the levels actually filled in: a blank in a key would match no row that has that level.
  const area = Object.fromEntries([
    ['SalesOrganization', text(salesArea.SalesOrganization)],
    ['DistributionChannel', text(salesArea.DistributionChannel)],
    ['Division', text(salesArea.Division)]
  ].filter(([, value]) => value));
  const areaLabel = Object.values(area).join(' / ');

  const entries = [];
  for (const row of mandatory) {
    const partnerFunction = text(row.PartnerFunction);
    if (!partnerFunction) continue;
    const procedure = text(row.DeterminationProcedure);
    // Every entry of one row carries the same key, so the pipeline resolves the index.
    const rowKey = { PartnerFunction: partnerFunction, ...area };

    entries.push({
      target: 'CustomerSalesPartnerFunctions',
      createsRow: true,
      rowKey,
      field: 'PartnerFunction',
      value: partnerFunction,
      label: 'Mandatory function',
      message: `Partner function ${partnerFunction} is mandatory for account group ${accountGroup} `
        + `under determination procedure ${procedure} in S/4.`
        + (areaLabel ? ` The row is for sales area ${areaLabel}, taken from the sales area on this `
          + 'request.' : '')
        + ' The partner number is left for S/4 to assign at post time.'
    });

    // createsRow writes exactly one field, so these complete the key.
    for (const [field, value] of Object.entries(area)) {
      entries.push({
        target: 'CustomerSalesPartnerFunctions',
        rowKey,
        field,
        value,
        label: 'Sales area',
        message: `${field} ${value} is taken from the sales area on this request.`
      });
    }
  }

  return entries;
}

/**
 * The mandatory SUPPLIER partner functions, from `T077K-PARGE` -> `TPAER`.
 *
 * **A different link from the customer side, and that asymmetry is real.** The customer procedure
 * lives on `TKUPA`; the vendor one is three columns on the account group table itself, one per
 * level -- `PARGE` purchasing organisation, `PARGT` sub-range, `PARGW` plant, confirmed from the
 * served `sap:quickinfo` rather than inferred from the names. Only `PARGE` is joined, because MDM
 * Light stages a purchasing-organisation row and nothing below it.
 *
 * Everything else mirrors the customer stage: only `PartnerType` = 'LI', only mandatory functions,
 * the partner number and counter left for S/4, silent when the purchasing-org row is absent.
 */
function supplierFunctionEntries(payload, { supplierFunctions }) {
  const [purchasingOrg] = liveRows(payload, 'SupplierPurchasingOrg');
  if (!purchasingOrg) return [];

  const organisation = text(purchasingOrg.PurchasingOrganization);
  if (!organisation) return [];

  const accountGroup = text(liveRows(payload, 'Suppliers')[0]?.SupplierAccountGroup);
  if (!accountGroup) return [];

  const mandatory = supplierFunctions
    .filter((row) => text(row.AccountGroup) === accountGroup)
    .filter((row) => row.IsMandatory)
    // 'LI' here where the customer stage wants 'KU'. Procedure AG carries both, so without this a
    // customer function would land on a purchasing organisation.
    .filter((row) => text(row.PartnerType) === 'LI')
    .sort((left, right) => text(left.SortOrder).localeCompare(text(right.SortOrder)));
  if (!mandatory.length) return [];

  // All of them, keyed per function -- the customer stage's own change (2026-08-28).
  // SupplierSubrange and Plant are deliberately NOT filled: they are the lower two levels, each
  // with its own partner schema, and a purchasing-organisation row leaves them blank.
  const entries = [];
  for (const row of mandatory) {
    const partnerFunction = text(row.PartnerFunction);
    if (!partnerFunction) continue;
    const procedure = text(row.PurchasingOrgProcedure);
    const rowKey = { PartnerFunction: partnerFunction, PurchasingOrganization: organisation };

    entries.push({
      target: 'SupplierPartnerFunctions',
      createsRow: true,
      rowKey,
      field: 'PartnerFunction',
      value: partnerFunction,
      label: 'Mandatory function',
      message: `Partner function ${partnerFunction} is mandatory for supplier account group `
        + `${accountGroup} under partner schema ${procedure} in S/4. The row is for purchasing `
        + `organization ${organisation}, taken from the purchasing row on this request. The partner `
        + 'number is left for S/4 to assign at post time.'
    }, {
      target: 'SupplierPartnerFunctions',
      rowKey,
      field: 'PurchasingOrganization',
      value: organisation,
      label: 'Purchasing org',
      message: `Purchasing organization ${organisation} is taken from the purchasing row on this `
        + 'request.'
    });
  }

  return entries;
}

/**
 * Why a derivation produced nothing, to `cf logs`. Not a message: staying silent about unmet
 * preconditions is Maarten's rule and it is right for requesters, but it also makes "the config is
 * there and nothing was proposed" undiagnosable from the screen. One line, everything the five
 * builders branch on, so the answer is in the log rather than in a guess.
 */
function diagnose(payload, config, entries) {
  const addresses = liveRows(payload, 'Addresses');
  console.log('[sap-derivations] ' + JSON.stringify({
    entries: entries.length,
    // Row counts, because an empty read looks exactly like customizing that says nothing.
    config: {
      countries: config.countries.length,
      taxCategories: config.taxCategories.length,
      timeZones: config.timeZones.length,
      partnerFunctions: config.partnerFunctions.length,
      supplierFunctions: config.supplierFunctions.length
    },
    payload: {
      addresses: addresses.length,
      addressCountry: text(addresses[0]?.Country),
      addressRegion: text(addresses[0]?.Region),
      addressLanguage: text(addresses[0]?.Language),
      customers: liveRows(payload, 'Customers').length,
      customerAccountGroup: text(liveRows(payload, 'Customers')[0]?.CustomerAccountGroup),
      salesAreas: liveRows(payload, 'CustomerSalesArea').length,
      taxIndicatorRows: liveRows(payload, 'CustomerTaxIndicators').length,
      customerFunctionRows: liveRows(payload, 'CustomerSalesPartnerFunctions').length,
      suppliers: liveRows(payload, 'Suppliers').length,
      supplierAccountGroup: text(liveRows(payload, 'Suppliers')[0]?.SupplierAccountGroup),
      purchasingOrgs: liveRows(payload, 'SupplierPurchasingOrg').length,
      supplierFunctionRows: liveRows(payload, 'SupplierPartnerFunctions').length
    }
  }));
}

/**
 * One stage, not two, and the reason is the pipeline's own: every rule in a single stage sees the
 * same payload, because entries are applied only after the stage returns. These two touch different
 * sections and neither reads what the other writes, so they can share one -- unlike the configured
 * rules, where a gap-filler has to run after the rule that adds its row.
 */
function createDerivationStages({ read = readConfiguration } = {}) {
  return {
    derivations: [{
      name: 'sap_derivations',
      async run(payload) {
        let config;
        try {
          config = await configuration(read);
        } catch (error) {
          // An improvement, not a gate -- the same discipline cvi-checks.js applies. The pipeline
          // turns a thrown derivation into an info line and carries on, but naming the lookup that
          // failed beats a bare stack message.
          return [{
            // The one message this file DOES emit unprompted, and it earns it: a derivation that
            // silently did nothing is indistinguishable from one that had nothing to do.
            message: `The S/4 derivation settings could not be read (${error.message}), so nothing `
              + 'was derived from them.'
          }];
        }
        const entries = [
          ...addressLanguageEntries(payload, config),
          ...timeZoneEntries(payload, config),
          ...taxCategoryEntries(payload, config),
          ...partnerFunctionEntries(payload, config),
          ...supplierFunctionEntries(payload, config)
        ];
        diagnose(payload, config, entries);
        return entries;
      }
    }]
  };
}

/**
 * Fill the cache without running a derivation, for warmup.js. Nothing else may call this.
 *
 * Reads FIRST and swaps after, so a refresh never leaves a window where the cache is empty
 * and a concurrent request pays the cold read itself; a failed refresh keeps whatever was
 * already working, the same way rule-store.js's load does. A plain `configuration()` would
 * not do: called before the TTL is up it returns the cached value and refreshes nothing.
 */
async function prime() {
  const value = await readConfiguration();
  cache = { value, until: Date.now() + TTL_MS };
  return value;
}

module.exports = {
  createDerivationStages,
  invalidate,
  prime,
  TTL_MS,
  _internals: {
    diagnose,
    configuration,
    readConfiguration,
    addressLanguageEntries,
    timeZoneEntries,
    taxCategoryEntries,
    partnerFunctionEntries,
    supplierFunctionEntries,
    liveRows
  }
};
