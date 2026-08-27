@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: address defaults per country'

// The address family, one row per country. Column names READ from DD03L on
// 2026-08-27, not inferred -- the first draft had XREGI and LNCMP, neither of
// which exists.
//
// SPRAS is the address language S/4 itself defaults, and a blank LANGU is what
// FSBP_GENERIC/008 costs -- see "Two messages that fired unconditionally".
define view entity Z_I_DER_ADDR_DEFAULT
  as select from t005 as Country
{
  key Country.land1 as Country,

      // The derivation this view exists for.
      Country.spras as AddressLanguage,

      // A second one, found while reading the column list rather than looked
      // for: the name format S/4 uses for this country. Not staged today.
      Country.nmfmt as NameFormat,

      // Named from the columns' OWN sap:label, read off the served $metadata on
      // 2026-08-27, not from what I hoped they meant. Both of these were first
      // written as guards for a region derivation -- `RegionIsMandatory` and
      // `AddressCheckActive` -- and neither column says anything of the kind:
      //   XREGS is "City file active"        (Flag: City file address check)
      //   XADDR is "Print C/R Name"          (print country for foreign addresses)
      // So T005 carries NO region-mandatory flag, and the region gap still has
      // no source. Kept under their real names because they are cheap and on the
      // same row, not because a derivation uses them.
      Country.xregs as CityFileActive,
      Country.xaddr as PrintCountryName,
      Country.lnplz as PostalCodeLength,
      Country.prplz as PostalCodeCheckRule,

      // Carried because tax and EU checks elsewhere already ask these two of
      // T005, and one view over one table beats two.
      Country.xegld as IsEuCountry,
      Country.intca as IsoCode
}
