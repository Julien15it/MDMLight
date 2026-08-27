using { ZSRVB_MDMLIGHT_VH as VH } from './external/ZSRVB_MDMLIGHT_VH';

/**
 * The SPRO customizing MDM Light derives from, read live.
 *
 * Its own service rather than more sets on `CviConfigService`, and the reason is the same one that
 * renamed the views from `Z_I_CVI_*` to `Z_I_DER_*`: none of this is Customer/Vendor Integration.
 * `T005`, `TTZ5S`, `TPAKD`/`TPAR`/`TPAER` and `TSTL` are general SAP customizing, and filing them
 * under a CVI service would mislead whoever reads it next. Nothing is deployed against this path
 * yet, so getting the name right cost nothing — unlike `/service/duplicateconfig`, which keeps its
 * name because renaming a live path buys nothing a user can see.
 *
 * Read-only by construction, like the CVI sets: this is customizing owned by S/4 and maintained in
 * SPRO, and nothing here has any business writing it back.
 *
 * **Why these are derived app-side at all.** S/4 has no callable way to tell us what it would
 * derive: `CL_MD_BP_MAINTAIN` is final, its two payload-enriching methods are protected and
 * private, and every public method takes the payload as `IMPORTING`. Four probe rounds established
 * that — see `mdmlbpcheck/README.md`. So each derivation reads its own customizing, the way
 * `cvi_account_group` reads `TBD001`.
 */
service DerivationConfigService @(path: '/service/derivationconfig') {

  /** Country defaults. `AddressLanguage` is `T005-SPRAS`, the value S/4 itself puts in
   *  `ADDR1_DATA-LANGU` — a blank one is what `FSBP_GENERIC/008` complains about. The rest are
   *  guards rather than derivations: whether a country has regions at all, so a derivation can say
   *  "no region" instead of deriving from nothing. */
  @readonly entity AddressDefaults    as projection on VH.DerAddressDefaults;

  /** Time zone per country AND region — `TTZ5S`, which assigns zones to regions, not to postal
   *  codes. `AddressTimeZone` is part of the key, so a region may carry several; `IsDefault` is
   *  what makes this a derivation rather than a validity list. */
  @readonly entity TimeZones          as projection on VH.DerTimeZones;

  /** The tax categories valid for a country, in S/4's own sequence — the `KNVI` rows it proposes
   *  when a customer gets a sales area. A multi-row derivation, unlike the others. */
  @readonly entity TaxCategories      as projection on VH.DerTaxCategories;

  /** Which partner functions an account group may carry, with the partner type each points at
   *  (KU customer, LI vendor, AP contact). A **value help, not a derivation**: nothing here says
   *  which functions are mandatory. */
  @readonly entity PartnerFunctions   as projection on VH.DerPartnerFunctions;

  /** The mandatory flag (`TPAER-PAPFL`) — the only thing worth proposing unasked. **Exposed and
   *  not consumed**: it is keyed by determination procedure and nothing found so far links a
   *  procedure to an account group, so it cannot be joined to `PartnerFunctions`. Kept exposed for
   *  the same reason the inbound CVI direction rows are — leaving half a table behind is how the
   *  next person re-derives where it lives. */
  @readonly entity PartnerFunctionProcedures as projection on VH.DerPartnerFunctionProcedures;
}
