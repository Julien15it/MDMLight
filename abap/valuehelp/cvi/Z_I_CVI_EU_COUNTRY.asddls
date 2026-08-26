@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'CVI Check: EU Member States'
define view entity Z_I_CVI_EU_COUNTRY
  as select from t005
{
      // T005 is client-dependent and its EU flag is the only thing SAP consults to decide whether a
      // VAT registration number is required, which is what VMD_API/043 reports at activation.
  key land1 as Country,
      xegld as IsEUMember
}
