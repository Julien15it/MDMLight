@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: time zone per country and region'

// TTZ5S is "Assign time zones to REGIONS" -- confirmed from its DDTEXT on
// 2026-08-27, and it corrects an earlier guess in this repo that it was keyed
// by postal code. 2096 rows on S4A.
//
// The consequence for the derivation, and it is the whole reason this view is
// separate: TIME_ZONE depends on REGION, so a request with no region has no
// time zone to derive. Region first, then this.
define view entity Z_I_CVI_TIME_ZONE
  as select from ttz5s as Assignment
{
  key Assignment.land1 as Country,
  key Assignment.regio as Region,
      Assignment.tzone as TimeZone
}
