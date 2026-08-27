@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: partner functions per account group'

// TPAKD, TPAER and TPAR are BUSINESS PARTNER tables, not SD-only -- their real
// DDTEXTs read "Business Partner: Valid Acct Groups per Partner Function",
// "...Functions in Partner Determination Proced." and "...Functions"
// (confirmed 2026-08-27). That is why the search for a separate VENDOR partner
// determination table found nothing: there is none, these cover both sides.
// T024H and TPA3, guessed earlier, do not exist on this system.
//
// Read it as: for this account group, these partner functions are valid, and
// PARVW_OBLIG says which ones S/4 insists on. The mandatory ones are what a
// derivation should propose; the rest are a value help, not a derivation.
define view entity Z_I_CVI_PARTNER_FUNC
  as select from tpakd as AccountGroupFunction
    inner join   tpar  as PartnerFunction
      on PartnerFunction.parvw = AccountGroupFunction.parvw
    left outer join tpaer as ProcedureFunction
      on  ProcedureFunction.parvw = AccountGroupFunction.parvw
      and ProcedureFunction.parga = AccountGroupFunction.parga
{
  key AccountGroupFunction.parga     as DeterminationProcedure,
  key AccountGroupFunction.ktokd     as AccountGroup,
  key AccountGroupFunction.parvw     as PartnerFunction,
      // 'X' is a function S/4 requires, which is the only kind worth proposing
      // unasked. Everything else is a choice the requester still has to make.
      ProcedureFunction.nurpf        as IsMandatory,
      // The partner TYPE the function points at -- KU customer, LI vendor, AP
      // contact person. A derivation must not propose a vendor function onto a
      // customer sales area, and this is what tells the two apart.
      PartnerFunction.nrart          as PartnerType,
      PartnerFunction.stype          as FunctionCategory
}
