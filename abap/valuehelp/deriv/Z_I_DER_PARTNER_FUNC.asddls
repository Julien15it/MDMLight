@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: partner functions valid per account group'

// TPAKD, TPAER and TPAR are BUSINESS PARTNER tables, not SD-only -- confirmed
// from their DDTEXTs. That is why there is no separate VENDOR partner
// determination table to find: these cover both sides. T024H and TPA3 do not
// exist here.
//
// **TPAKD is three columns and all of them are keys.** It answers exactly one
// question: which partner functions is this account group allowed to carry. It
// holds no determination procedure, so nothing here can say which functions are
// MANDATORY -- that flag is TPAER-PAPFL, and TPAER is keyed by procedure
// (PARGR), which TPAKD does not carry. See Z_I_DER_PARTNER_FUNC_PROC.
//
// NRART is the load-bearing column: it says which partner TYPE a function
// points at (KU customer, LI vendor, AP contact person). Without it a vendor
// function could be proposed onto a customer sales area, which is the same
// class of error `accountGroupConflictFindings` already reports.
define view entity Z_I_DER_PARTNER_FUNC
  as select from tpakd as AccountGroupFunction
    inner join   tpar  as PartnerFunction
      on PartnerFunction.parvw = AccountGroupFunction.parvw
{
  key AccountGroupFunction.ktokd as AccountGroup,
  key AccountGroupFunction.parvw as PartnerFunction,

      // KU / LI / AP -- which side of the partner this function belongs to.
      PartnerFunction.nrart      as PartnerType,

      // The function this one is a sub-function of, where it has one. Carried
      // because a derivation that proposes SH should not also propose its
      // higher-level SP as a second, separate row.
      PartnerFunction.uparv      as HigherLevelFunction,

      PartnerFunction.stein      as PartnerCategory,
      PartnerFunction.hityp      as HierarchyType
}
