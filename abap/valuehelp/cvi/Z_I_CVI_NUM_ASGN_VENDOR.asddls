@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'CVI Check: BP/Supplier Number Assignment'
define view entity Z_I_CVI_NUM_ASGN_VENDOR
  as select from tbc001 as Assignment
    left outer join tb001 as Grouping
      on Grouping.bu_group = Assignment.bu_group
    left outer join t077k as AccountGroup
      on AccountGroup.ktokk = Assignment.ktokk
{
  key 'BP_TO_VENDOR'         as SyncDirection,
  key Assignment.bu_group    as BPGrouping,
  key Assignment.ktokk       as SupplierAccountGroup,
      Assignment.xsamenumber as HasSameNumber,
      Grouping.nrrng         as BPNumberRange,
      AccountGroup.numkr     as SupplierNumberRange
}
union all
  select from cvic_vend_to_bp1 as Assignment
    left outer join tb001 as Grouping
      on Grouping.bu_group = Assignment.grouping
    left outer join t077k as AccountGroup
      on AccountGroup.ktokk = Assignment.account_group
{
  key 'VENDOR_TO_BP'           as SyncDirection,
  key Assignment.grouping      as BPGrouping,
  key Assignment.account_group as SupplierAccountGroup,
      Assignment.same_number   as HasSameNumber,
      Grouping.nrrng           as BPNumberRange,
      AccountGroup.numkr       as SupplierNumberRange
}
