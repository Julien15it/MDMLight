@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: mandatory partner functions per procedure'

// The other half of the partner function derivation, and the half that can
// actually PROPOSE something: PAPFL is the obligatory-function flag, so the
// functions a procedure marks mandatory are the ones worth filling in unasked.
// Everything else is a value help, not a derivation.
//
// **Keyed by PARGR, the determination procedure -- which nothing read so far
// links to an account group.** TPAKD holds no procedure column, so joining this
// to Z_I_DER_PARTNER_FUNC is not possible on what these tables carry. Until
// that link is found (T077D is the outstanding candidate, still unread), this
// view is exposed but not consumed -- the same way the inbound CVI direction
// rows are exposed and never read, and for the same reason: leaving half a
// table behind is how the next person re-derives where it lives.
//
// SORTF is carried because SAP orders the functions of a procedure, and a
// requester shown four proposed rows should see them in the order S/4 uses.
define view entity Z_I_DER_PARTNER_FUNC_PROC
  as select from tpaer as ProcedureFunction
    inner join   tpar  as PartnerFunction
      on PartnerFunction.parvw = ProcedureFunction.parvw
{
  key ProcedureFunction.pargr as DeterminationProcedure,
  key ProcedureFunction.parvw as PartnerFunction,

      // 'X' = S/4 requires this function. The whole point of the view.
      ProcedureFunction.papfl as IsMandatory,

      // Whether the assignment may be changed, and whether it must be unique.
      ProcedureFunction.aendb as IsChangeable,
      ProcedureFunction.parei as IsUnique,
      ProcedureFunction.sortf as SortOrder,

      PartnerFunction.nrart   as PartnerType
}
