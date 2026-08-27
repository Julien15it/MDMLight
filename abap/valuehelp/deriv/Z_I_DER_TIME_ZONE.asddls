@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: time zone per country and region'

// TTZ5S is "Assign time zones to REGIONS" -- not postal codes, which an earlier
// draft assumed. 2096 rows on S4A.
//
// **TZONEDFT is what makes this a derivation rather than a validity list.**
// TZONE is part of the key, so a country + region can carry several time zones;
// the fifth column flags which one is the DEFAULT. So the rule is not "propose
// only when exactly one row matches" (what this file said before the column was
// read) -- it is "propose the row SAP marks default", and fall silent when no
// row is marked. That is better: a region with three zones still derives.
//
// TIME_ZONE depends on REGION, so a request with no region has nothing to
// derive here. Region first, then this.
// `AddressTimeZone`, not `TimeZone`: TIMEZONE is a CDS reserved word and the
// view will not activate with it. Named for where the value lands -- ADRC's own
// column is TIME_ZONE, on the address.
define view entity Z_I_DER_TIME_ZONE
  as select from ttz5s as Assignment
{
  key Assignment.land1    as Country,
  key Assignment.bland    as Region,
  key Assignment.tzone    as AddressTimeZone,
      Assignment.tzonedft as IsDefault
}
