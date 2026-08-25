@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'CVI Check: Postprocessing Office Control'
define view entity Z_I_CVI_PPO_CONTROL
  as select from mdsc_ctrl_objppo
{
  key sync_object as SynchronizationObject,
      ppo_active  as IsPostprocessingActive
}
