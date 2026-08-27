@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: partner functions valid per account group'

// TPAKD, TPAER and TPAR are BUSINESS PARTNER tables, not SD-only -- their real
// DDTEXTs read "Business Partner: Valid Acct Groups per Partner Function",
// "...Functions in Partner Determination Proced." and "...Functions". That is
// why the search for a separate VENDOR partner determination table found
// nothing: there is none, these cover both sides. T024H and TPA3 do not exist.
//
// **TPAKD carries NO determination procedure.** Its whole key is MANDT + PARVW
// + KTOKD and it has three columns, so it answers exactly one question: which
// partner functions are valid for this account group. An earlier draft of this
// view joined it on a PARGA column that does not exist.
//
// TPAER is therefore NOT joined here. Its key is MANDT + PARGR + PARVW -- the
// procedure, spelled PARGR and not PARGA -- and nothing in TPAKD says which
// procedure an account group uses, so the two cannot be joined on what these
// tables hold. The mandatory flag lives in TPAER's other 16 columns and needs
// its own view once the procedure's source is known.
//
// So this view supports the SAFE half of the derivation: it says which
// functions an account group may carry. Proposing one unasked needs the
// mandatory flag, which is still open.
define view entity Z_I_DER_PARTNER_FUNC
  as select from tpakd as AccountGroupFunction
    inner join   tpar  as PartnerFunction
      on PartnerFunction.parvw = AccountGroupFunction.parvw
{
  key AccountGroupFunction.ktokd as AccountGroup,
  key AccountGroupFunction.parvw as PartnerFunction
  // TPAR's remaining 8 columns are not selected yet: the partner TYPE a
  // function points at (KU customer, LI vendor, AP contact) is what stops a
  // vendor function being proposed onto a customer sales area, and the column
  // name has not been read. See ZMDML_FIELDS_PROBE with P_ALL.
}
