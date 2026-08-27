@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: valid tax categories per country'

// TSTL is "Taxes: Valid Tax Categories for Each Country/Region" -- the source
// of the KNVI rows S/4 proposes when a customer gets a sales area. One row per
// country per sequence number, and TATYP is the tax category itself.
//
// This is a genuine multi-row derivation, unlike everything else here: a
// Belgian customer gets one CustomerTaxIndicators row per category valid for
// BE, not one value in one field. The staged node (`CustomerTaxIndicators`,
// mapping to IT_CUST_TAX_INDICATOR) already holds ALAND/TATYP/TAXKD, so the
// rows have somewhere to land -- what is missing is TAXKD, the classification
// value, which is a business decision and NOT derivable. So the derivation
// proposes the ROWS with an empty classification for the requester to fill.
//
// LFDNR is the sequence S/4 keeps them in, and it is part of the key: a country
// with three categories has three rows, numbered.
// The source alias is `Category`, not `TaxCategory`: a field alias that matches
// the data source alias is at best unreadable and at worst rejected.
define view entity Z_I_DER_TAX_CATEGORY
  as select from tstl as Category
{
  key Category.talnd as Country,
  key Category.lfdnr as SequenceNumber,
      Category.tatyp as TaxCategory,
      // STPRZ's label is "% rate from T007" -- it says the rate comes from
      // table T007, not that the category is a percentage.
      Category.stprz as RateFromTableT007
}
