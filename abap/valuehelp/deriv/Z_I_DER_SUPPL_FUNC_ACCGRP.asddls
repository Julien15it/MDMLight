@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.ignorePropagatedAnnotations: true
@EndUserText.label: 'Derivation: supplier partner functions per account group'

// The VENDOR mirror of Z_I_DER_PARTNER_FUNC_MAND, and the link is not where the customer one's is.
//
// **`T077K` carries THREE procedure columns**, one per level: `PARGE` (data element `PARGR_E`),
// `PARGT` (`PARGR_T`) and `PARGW` (`PARGR_W`). That is why the column search missed it -- it looked
// for a column typed `PARGR`, and these are `PARGR_E/T/W`. The full table dump found them.
//
// The three levels line up exactly with `StagedSupplierPartnerFunc`'s own key --
// `PurchasingOrganization` / `SupplierSubrange` / `Plant` -- and with `WYT3`'s
// (`LIFNR + EKORG + LTSNR + WERKS + PARVW + PARZA`). So vendor partner functions are configured per
// level, where the customer side has one procedure per account group.
//
// **Only `PARGE` is joined.** `E` is Einkaufsorganisation and the purchasing-organisation level is
// the one MDM Light stages a row for; the other two are EXPOSED but not joined, because whether
// `PARGT` is the supplier subrange and `PARGW` the plant is an inference from the data element
// names, not something read from the system. Naming them wrong would proposal the wrong procedure's
// functions -- the same trap the 3-of-25 name convention was. Confirm before joining either.
//
// Vendor procedures are real and do carry mandatory functions: 50 procedures contain an `NRART = 'LI'`
// function on S4A, 26 of them flag one mandatory (`0001 -> LF`, `L1 -> BA, LF, RS`, ...). So this is
// a derivation, not merely a value help.
//
// `PARVW` is CAST past its conversion exit, as everywhere else -- otherwise the V2 binding serves no
// metadata at all (`SY/530`).
define view entity Z_I_DER_SUPPL_FUNC_ACCGRP
  as select from t077k as AccountGroup
    inner join   tpaer as ProcedureFunction
      on ProcedureFunction.pargr = AccountGroup.parge
    inner join   tpar  as PartnerFunction
      on PartnerFunction.parvw = ProcedureFunction.parvw
{
  key AccountGroup.ktokk                                as AccountGroup,
  key cast( ProcedureFunction.parvw as abap.char( 2 ) ) as PartnerFunction,

      // The one this view joins on: the purchasing-organisation level.
      AccountGroup.parge                                as PurchasingOrgProcedure,
      // Exposed, not joined. See the note above before using either.
      AccountGroup.pargt                                as SecondLevelProcedure,
      AccountGroup.pargw                                as ThirdLevelProcedure,

      // 'X' = S/4 requires this function.
      ProcedureFunction.papfl                           as IsMandatory,
      ProcedureFunction.sortf                           as SortOrder,

      // 'LI' for a vendor function. Not filtered here, so the stage can apply the same guard the
      // customer side does and the two read alike.
      PartnerFunction.nrart                             as PartnerType
}
// An account group with no purchasing-org procedure derives nothing, which is correct for it. Without
// this, a blank PARGE would inner-join against whatever TPAER held under a blank PARGR.
where AccountGroup.parge <> ''
