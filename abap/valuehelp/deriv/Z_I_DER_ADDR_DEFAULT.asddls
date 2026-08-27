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

      // Not derivations -- the guards a derivation needs so it can say "this
      // country has no regions" instead of deriving from nothing. XREGS, not
      // XREGI. Region matters twice over: TTZ5S is keyed by it, so a missing
      // region means no time zone either.
      Country.xregs as RegionIsMandatory,
      Country.xaddr as AddressCheckActive,
      Country.lnplz as PostalCodeLength,
      Country.prplz as PostalCodeCheckRule,

      // Carried because tax and EU checks elsewhere already ask these two of
      // T005, and one view over one table beats two.
      Country.xegld as IsEuCountry,
      Country.intca as IsoCode
}
