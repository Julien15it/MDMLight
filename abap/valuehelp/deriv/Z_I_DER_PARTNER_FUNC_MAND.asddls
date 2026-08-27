@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: partner functions per account group'

// **The link that was missing for four probe rounds: TKUPA.** Its key is `KTOKD` ALONE and `PARGR`
// is a plain data column, so the join is the account group and nothing else. Found by asking which
// table carries both a PARGR-shaped column and an account group -- asking by COLUMN rather than by
// name, after T024H, TPA3 and TB008 had all been wrong name guesses.
//
// Two candidates were ruled out on the way, and both are worth recording:
//   T077D  carries no procedure at all. 20 columns of field status, number range and dunning.
//   T077D-KALSM is "Output Determination Procedure" (DD04T on KALSMB) -- a different procedure
//          entirely, and blank on 23 of 25 account groups anyway.
//
// The chain this completes, end to end: grouping -> customer account group (`TBD001`, already
// derived by cvi_account_group) -> determination procedure (`TKUPA`) -> its mandatory functions
// (`TPAER-PAPFL`). Measured on S4A: grouping 0002 -> KUNA -> AG -> AG, RE, RG, WE, which is
// sold-to / bill-to / payer / ship-to in German codes -- exactly the SP/BP/PY/SH set.
//
// `PARVW` is CAST past its conversion exit, as everywhere else: the V2 binding answers
// `SY/530 Do not use conversion exit PARVW here.` and serves NO metadata at all otherwise.
//
// Every function of the procedure is exposed, mandatory or not, with the flag alongside. Only the
// mandatory ones are worth proposing unasked; the rest are a value help, and one view answering both
// beats two views disagreeing about the join.
define view entity Z_I_DER_PARTNER_FUNC_MAND
  as select from tkupa as AccountGroup
    inner join   tpaer as ProcedureFunction
      on ProcedureFunction.pargr = AccountGroup.pargr
    inner join   tpar  as PartnerFunction
      on PartnerFunction.parvw = ProcedureFunction.parvw
{
  key AccountGroup.ktokd                                as AccountGroup,
  key cast( ProcedureFunction.parvw as abap.char( 2 ) ) as PartnerFunction,

      AccountGroup.pargr                                as DeterminationProcedure,

      // 'X' = S/4 requires this function. The only thing worth filling in unasked.
      ProcedureFunction.papfl                           as IsMandatory,

      // S/4's own order, so four proposed rows appear the way S/4 lists them.
      ProcedureFunction.sortf                           as SortOrder,

      // KU customer / LI vendor / AP contact. Load-bearing: without it a vendor function could be
      // proposed onto a customer sales area, the same class of error accountGroupConflictFindings
      // already reports.
      PartnerFunction.nrart                             as PartnerType
}
// **20 of 43 TKUPA rows carry a BLANK procedure** (0012, 0140-0160, BE01, DK01, ES01, GB01, IT01,
// NO01, SE01, VVD, CPDA, RTEC...). Without this those rows would inner-join against any TPAER row
// with a blank PARGR and propose whatever it held. An account group with no procedure derives
// nothing, which is the correct answer for it.
where AccountGroup.pargr <> ''
