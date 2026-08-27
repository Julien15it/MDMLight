@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: address defaults per country'

// The address family, one row per country. T005-SPRAS is the LANGU default S/4
// itself uses, and FSBP_GENERIC/008 is what a blank LANGU costs -- see
// mdmlbpcheck/README.md, "Two messages that fired unconditionally".
//
// Country-level only, deliberately. Time zone lives on TTZ5S keyed by country
// AND region, so it is its own view: putting it here would multiply this one by
// every region and make the country default ambiguous.
define view entity Z_I_DER_ADDR_DEFAULT
  as select from t005 as Country
{
  key Country.land1 as Country,
      // The address language S/4 defaults. Confirmed as the source 2026-08-27:
      // T005 is "Countries", 249 rows on S4A.
      Country.spras as AddressLanguage,
      // Carried because a region-dependent derivation has to know whether the
      // country even has regions before it reports "no region found".
      Country.xregi as HasRegions,
      Country.xaddr as AddressCheckActive,
      // The postal-code length, so a derivation can say a code is implausible
      // rather than deriving from a bad one.
      Country.lncmp as PostalCodeLength
}
