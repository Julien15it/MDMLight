using { ZSRVB_MDMLIGHT_VH as VH } from './external/ZSRVB_MDMLIGHT_VH';

/**
 * The CVI customizing of the connected S/4 system, read live.
 *
 * Same remote service as the value helps in BusinessPartnerService, different purpose: these five
 * sets describe how Customer/Vendor Integration is *configured*, and are read by setup and
 * diagnosis screens rather than by a form's F4 help. They are kept out of VALUE_HELP_ENTITIES for
 * that reason — nothing here backs a @Common.ValueList.
 *
 * Deliberately configuration only, not a verdict. SAP's own check report
 * (transaction CVI_FS_CHECK_CUST) reproduces its judgements in a module pool with no callable API,
 * and copying that logic means chasing it across support packages. Interpreting these rows —
 * "role X has no account group" — belongs in the UI.
 */
service CviConfigService @(path: '/service/cviconfig') {

  /** BP role categories and the BP categories each may be used for. */
  @readonly entity RoleCategories        as projection on VH.CviRoleCategories;

  /** BP role to role category assignment, with the role's description. */
  @readonly entity BusinessPartnerRoles  as projection on VH.CviBusinessPartnerRoles;

  /** One row, one flag: is contact person synchronisation active. */
  @readonly entity ContactMapping        as projection on VH.CviContactMapping;

  /** Postprocessing Office activation per synchronisation object. Off means
   *  synchronisation errors are dropped rather than queued for a human. */
  @readonly entity PostprocessingControl as projection on VH.CviPostprocessingControl;

  /** Number range intervals for BU_PARTNER, DEBITOR and KREDITOR. */
  @readonly entity NumberRanges          as projection on VH.CviNumberRanges;
}
