@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'CVI Check: Contact Person Mapping Active'
define view entity Z_I_CVI_CONTACT_MAPPING
  as select from cvic_map_contact
{
  key map_contact as IsContactPersonMappingActive
}
