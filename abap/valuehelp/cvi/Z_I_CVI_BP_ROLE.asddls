@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'CVI Check: BP Role to Role Category'
define view entity Z_I_CVI_BP_ROLE
  as select from tb003 as Role
    left outer join tb003t as RoleText
      on  RoleText.role  = Role.role
      and RoleText.spras = $session.system_language
{
  key Role.role         as BPRole,
      RoleText.rltxt    as BPRoleName,
      Role.rolecategory as BPRoleCategory,
      Role.stnd_rolecat as IsStandardRoleForCategory,
      Role.bpview       as BPView,
      Role.xsuppress    as IsHidden,
      Role.posnr        as RolePosition
}
