@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: time zone per country and region'

// TTZ5S is "Assign time zones to REGIONS" -- confirmed from its DDTEXT
// 2026-08-27, which corrects an earlier guess in this repo that it was keyed by
// postal code. 2096 rows on S4A.
//
// Two things the key dump settled, and both change the derivation:
//
//   1. The region column is BLAND (data element REGIO), not REGIO.
//   2. TZONE IS PART OF THE KEY. So one country + region can carry SEVERAL
//      time zones, and this is a validity list, not a lookup that returns one
//      answer. A derivation may therefore only propose where exactly ONE row
//      matches -- the same discipline `soleAssignment` applies in cvi-checks.js,
//      and for the same reason: deriving nothing beats picking a winner.
//
// TIME_ZONE also depends on REGION, so a request with no region has nothing to
// derive here. Region first, then this.
define view entity Z_I_DER_TIME_ZONE
  as select from ttz5s as Assignment
{
  key Assignment.land1 as Country,
  key Assignment.bland as Region,
  key Assignment.tzone as TimeZone
}
