@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'CVI Check: BP and Cust/Supp Number Ranges'
define view entity Z_I_CVI_NUMBER_RANGE
  as select from nriv
{
  key object     as NumberRangeObject,
  key subobject  as NumberRangeSubobject,
  key nrrangenr  as NumberRangeNumber,
  key toyear     as ToFiscalYear,
      fromnumber as FromNumber,
      tonumber   as ToNumber,
      externind  as IsExternalNumberRange
}
where
     object = 'BU_PARTNER'
  or object = 'DEBITOR'
  or object = 'KREDITOR'
