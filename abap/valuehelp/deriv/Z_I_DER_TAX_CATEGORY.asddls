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
define view entity Z_I_DER_TAX_CATEGORY
  as select from tstl as TaxCategory
{
  key TaxCategory.talnd as Country,
  key TaxCategory.lfdnr as SequenceNumber,
      TaxCategory.tatyp as TaxCategory,
      TaxCategory.stprz as IsPercentage
}
