@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'CVI Check: BP Role Category Settings'
define view entity Z_I_CVI_ROLE_CATEGORY
  as select from tb003a as RoleCategory
    left outer join tbd002 as CustomerRole
      on CustomerRole.rltyp = RoleCategory.rolecategory
    left outer join tbc002 as VendorRole
      on VendorRole.rltyp = RoleCategory.rolecategory
{
  key RoleCategory.rolecategory as BPRoleCategory,
      RoleCategory.dftyp        as DifferentiationType,
      RoleCategory.xpers        as IsAllowedForPerson,
      RoleCategory.xorg         as IsAllowedForOrganization,
      RoleCategory.xgroup       as IsAllowedForGroup,
      RoleCategory.bo_name      as BusinessObjectName,
      CustomerRole.deb          as CreatesCustomerMandatory,
      CustomerRole.deb_flag     as CreatesCustomerOptional,
      VendorRole.kred           as CreatesSupplierMandatory,
      VendorRole.kred_flag      as CreatesSupplierOptional
}
