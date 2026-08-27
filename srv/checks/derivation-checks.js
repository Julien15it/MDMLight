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

const SERVICE = 'ZSRVB_MDMLIGHT_VH';

// Same 60s TTL as cvi-checks.js, rule-store.js and field-property-store.js. This is customizing: it
// changes when somebody transports, not while a form is being filled in.
const TTL_MS = 60000;

let cache = null;

function invalidate() {
  cache = null;
}

async function readConfiguration() {
  const service = await cds.connect.to(SERVICE);
  const [countries, taxCategories, timeZones, partnerFunctions, supplierFunctions] = await Promise.all([
    service.run(cds.ql.SELECT.from('DerAddressDefaults')),
    service.run(cds.ql.SELECT.from('DerTaxCategories')),
    service.run(cds.ql.SELECT.from('DerTimeZones')),
    service.run(cds.ql.SELECT.from('DerPartnerFunctionAccGrp')),
    service.run(cds.ql.SELECT.from('DerSupplierFunctionAccGrp'))
  ]);
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
 */
function partnerFunctionEntries(payload, { partnerFunctions }) {
  const [salesArea] = liveRows(payload, 'CustomerSalesArea');
  if (!salesArea) return [];

  const accountGroup = text(liveRows(payload, 'Customers')[0]?.CustomerAccountGroup);
  if (!accountGroup) return [];

  // Not into a section somebody has already filled: those rows are theirs.
  if (liveRows(payload, 'CustomerSalesPartnerFunctions').length) return [];

  const mandatory = partnerFunctions
    .filter((row) => text(row.AccountGroup) === accountGroup)
    .filter((row) => row.IsMandatory)
    .filter((row) => text(row.PartnerType) === 'KU')
    .sort((left, right) => text(left.SortOrder).localeCompare(text(right.SortOrder)));
  if (!mandatory.length) return [];

  // The pipeline creates only the FIRST row of an empty section, so one function is proposed and
  // the rest are named. Same shape, and the same reasoning, as the tax categories.
  const [first, ...remaining] = mandatory;
  const procedure = text(first.DeterminationProcedure);

  const entries = [{
    target: 'CustomerSalesPartnerFunctions',
    index: 0,
    createsRow: true,
    field: 'PartnerFunction',
    value: text(first.PartnerFunction),
    label: 'Mandatory function',
    message: `Partner function ${text(first.PartnerFunction)} is mandatory for account group `
      + `${accountGroup} under determination procedure ${procedure} in S/4. The partner number is `
      + 'left for S/4 to assign at post time.'
  }];

  // The sales area the row belongs to, filled from the row the requester already added -- three
  // more entries, because createsRow writes one field and these complete the key.
  for (const [field, value] of [
    ['SalesOrganization', text(salesArea.SalesOrganization)],
    ['DistributionChannel', text(salesArea.DistributionChannel)],
    ['Division', text(salesArea.Division)]
  ]) {
    if (!value) continue;
    entries.push({
      target: 'CustomerSalesPartnerFunctions',
      index: 0,
      field,
      value,
      label: 'Sales area',
      message: `${field} ${value} is taken from the sales area on this request.`
    });
  }

  if (remaining.length) {
    entries.push({
      message: `Account group ${accountGroup} has ${mandatory.length} mandatory partner functions `
        + `under procedure ${procedure} (${mandatory.map((row) => text(row.PartnerFunction)).join(', ')}). `
        + 'One row is proposed; add the others by hand if this customer needs them.'
    });
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

  if (liveRows(payload, 'SupplierPartnerFunctions').length) return [];

  const mandatory = supplierFunctions
    .filter((row) => text(row.AccountGroup) === accountGroup)
    .filter((row) => row.IsMandatory)
    // 'LI' here where the customer stage wants 'KU'. Procedure AG carries both, so without this a
    // customer function would land on a purchasing organisation.
    .filter((row) => text(row.PartnerType) === 'LI')
    .sort((left, right) => text(left.SortOrder).localeCompare(text(right.SortOrder)));
  if (!mandatory.length) return [];

  const [first, ...remaining] = mandatory;
  const procedure = text(first.PurchasingOrgProcedure);

  const entries = [{
    target: 'SupplierPartnerFunctions',
    index: 0,
    createsRow: true,
    field: 'PartnerFunction',
    value: text(first.PartnerFunction),
    label: 'Mandatory function',
    message: `Partner function ${text(first.PartnerFunction)} is mandatory for supplier account `
      + `group ${accountGroup} under partner schema ${procedure} in S/4. The partner number is left `
      + 'for S/4 to assign at post time.'
  }, {
    target: 'SupplierPartnerFunctions',
    index: 0,
    field: 'PurchasingOrganization',
    value: organisation,
    label: 'Purchasing org',
    message: `Purchasing organization ${organisation} is taken from the purchasing row on this `
      + 'request.'
  }];

  // SupplierSubrange and Plant are deliberately NOT filled: they are the lower two levels, each
  // with its own partner schema, and a purchasing-organisation row leaves them blank.
  if (remaining.length) {
    entries.push({
      message: `Supplier account group ${accountGroup} has ${mandatory.length} mandatory partner `
        + `functions under schema ${procedure} `
        + `(${mandatory.map((row) => text(row.PartnerFunction)).join(', ')}). One row is proposed; `
        + 'add the others by hand if this supplier needs them.'
    });
  }

  return entries;
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
        return [
          ...addressLanguageEntries(payload, config),
          ...timeZoneEntries(payload, config),
          ...taxCategoryEntries(payload, config),
          ...partnerFunctionEntries(payload, config),
          ...supplierFunctionEntries(payload, config)
        ];
      }
    }]
  };
}

module.exports = {
  createDerivationStages,
  invalidate,
  TTL_MS,
  _internals: {
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
