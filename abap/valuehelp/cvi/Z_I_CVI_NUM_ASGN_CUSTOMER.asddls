@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'CVI Check: BP/Customer Number Assignment'
define view entity Z_I_CVI_NUM_ASGN_CUSTOMER
  as select from tbd001 as Assignment
    left outer join tb001 as Grouping
      on Grouping.bu_group = Assignment.bu_group
    left outer join t077d as AccountGroup
      on AccountGroup.ktokd = Assignment.ktokd
{
  key 'BP_TO_CUSTOMER'       as SyncDirection,
  key Assignment.bu_group    as BPGrouping,
  key Assignment.ktokd       as CustomerAccountGroup,
      Assignment.xsamenumber as HasSameNumber,
      Grouping.nrrng         as BPNumberRange,
      AccountGroup.numkr     as CustomerNumberRange
}
union all
  select from cvic_cust_to_bp1 as Assignment
    left outer join tb001 as Grouping
      on Grouping.bu_group = Assignment.grouping
    left outer join t077d as AccountGroup
      on AccountGroup.ktokd = Assignment.account_group
{
  key 'CUSTOMER_TO_BP'         as SyncDirection,
  key Assignment.grouping      as BPGrouping,
  key Assignment.account_group as CustomerAccountGroup,
      Assignment.same_number   as HasSameNumber,
      Grouping.nrrng           as BPNumberRange,
      AccountGroup.numkr       as CustomerNumberRange
}
