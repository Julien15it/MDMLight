@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'CVI Check: Active Sync Directions'
define view entity Z_I_CVI_SYNC_DIRECTION
  as select from mdsc_ctrl_opt_a
{
  key sync_obj_source  as SourceObject,
  key sync_obj_target  as TargetObject,
      active_indicator as IsActive
}
