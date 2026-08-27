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
  const [countries, taxCategories] = await Promise.all([
    service.run(cds.ql.SELECT.from('DerAddressDefaults')),
    service.run(cds.ql.SELECT.from('DerTaxCategories'))
  ]);
  return {
    countries: Array.isArray(countries) ? countries : [],
    taxCategories: Array.isArray(taxCategories) ? taxCategories : []
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
 * pipeline can propose more than one row. Said out loud rather than silently dropped: see the
 * `remaining` message below.
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
            message: `The S/4 derivation settings could not be read (${error.message}), so the `
              + 'address language and tax categories were not derived.'
          }];
        }
        return [
          ...addressLanguageEntries(payload, config),
          ...taxCategoryEntries(payload, config)
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
    taxCategoryEntries,
    liveRows
  }
};
