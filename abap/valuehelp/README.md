# BP value helps — OData service

One service definition exposing the SAP released value-help views behind the
fields of the Maintain Business Partner app. No Z copies of the views: all of
them are `SAP_BASIS` / `SAP_ABA` / `S4CORE`, released, clean-core level A, and
ship with every S/4 system regardless of MDG licensing.

Two names, and they are not interchangeable — the app refers to the **binding**,
never the service definition:

| | Name |
|---|---|
| Service definition (this folder) | `ZMDML_VH_ENTITY` |
| Service binding / external name | `ZSRVB_MDMLIGHT_VH` |
| URL | `/sap/opu/odata/sap/ZSRVB_MDMLIGHT_VH` |

## Create in ADT

1. Create data definition-free **service definition** `ZMDML_VH_ENTITY` from
   `ZMDML_VH_ENTITY.asrvdsrv`, assign to a Z package, activate.
2. Create a **service binding** on it — binding type **ODATA V2 – Web API**,
   external service name `ZSRVB_MDMLIGHT_VH`. Activate, then publish.
3. The service is then reachable at
   `/sap/opu/odata/sap/ZSRVB_MDMLIGHT_VH`.

The V2/V4 choice lives in the *binding*, not in the service definition — the
source file is identical either way.

## Why V2

`VF_S4HANA_DEST` points at `/sap/opu/odata/sap`, the V2 gateway root, so a V2
binding is reachable through the destination the app already has. This is the
entry in `package.json` (`csrf: false` — the app only ever reads from it, so
there is no token round trip to pay for):

```json
"ZSRVB_MDMLIGHT_VH": {
  "kind": "odata-v2",
  "model": "srv/external/ZSRVB_MDMLIGHT_VH",
  "csrf": false,
  "credentials": {
    "destination": "VF_S4HANA_DEST",
    "path": "/ZSRVB_MDMLIGHT_VH"
  }
}
```

A V4 binding would be served from `/sap/opu/odata4/sap/…`, a different root,
needing a second destination.

## How the metadata reaches the app

**The app never calls `$metadata` to serve a request.** It was imported once and
checked in, and every read runs off that copy:

```bash
npm run import:valuehelp     # and npm run import:bp for API_BUSINESS_PARTNER
```

The destination route **does not work from BAS**:

```bash
npm run import:bp                                                  # via VF_S4HANA_DEST — CF only
npm run import:bp -- --url https://<host>:44301/sap/opu/odata/sap   # S4_USER / S4_PASSWORD
```

The SAP Cloud SDK resolves destinations from `VCAP_SERVICES`. `cds bind` writes
`.cdsrc-private.json`, which CAP reads and the Cloud SDK does not, and even
`cds bind --exec` only helps once `mdm-businesspartner-destination-service` is
itself bound — plus, for an on-premise destination, the connectivity proxy, which
exists only in the CF runtime. So from BAS use `--url`, adding `--insecure` if the
gateway certificate is self-signed. The fetch is overwritten into `srv/external`
only once a document containing entity sets is in hand, so a login page or a
gateway error never lands there.

**Downloading it in a browser does not help**, which is why there is no `--file`
route: the document lands on your laptop and `cds import` runs in BAS, so that
path costs a file transfer before it costs anything else. `--url` fetches straight
into the workspace and skips the problem. (If a `$metadata` document *is* already
in the workspace, `npx cds import <file>.edmx --as cds --force --no-save` —
`--as csn` for `API_BUSINESS_PARTNER` — is the whole job and this script adds
nothing. **Not `--into`**: cds-dk 8 does not know that flag and lands the result
in `srv/external` by itself.)

Both checked-in copies got here by hand: `API_BUSINESS_PARTNER.edmx` from Julien
(`e34b94e`, 2026-07-30) and this service's from Arthur (`169418c`, 2026-08-06).
There has never been an automated path.

It writes `srv/external/ZSRVB_MDMLIGHT_VH.edmx` (the raw document) and regenerates
`ZSRVB_MDMLIGHT_VH.cds` (the CAP model, with a `checksum` header — do not
hand-edit that file, the next import overwrites it). Commit both.

`business-partner-service.cds` projects onto that model, so it has to exist at
**compile** time: `cds build` cannot fetch it, which is why the copy exists at all.

Consequences worth knowing before changing anything here:

- **Adding an `expose` line changes nothing in the app** until someone re-runs
  the import and commits both files.
- `srv/metadata-drift.js` compares the copy against the live service once at
  startup and logs the difference — a **warning** when the live service no longer
  has something the copy claims (reads may already be failing), an **info** when
  the copy is merely behind. It never edits anything; it names the command above.
  Where no destination resolves it logs at debug and stops.
- Four things have to be kept in step when a lookup is added or removed: the
  `as projection on VH.` lines in `srv/business-partner-service.cds`,
  `VALUE_HELP_ENTITIES` in `srv/business-partner-service.js`, `VALUE_HELP_FIELDS`
  in the UI's `BusinessPartnerMaintenance.controller.js`, and the
  `@Common.ValueList` annotations in `srv/annotations.cds`.
  **`test/value-help-wiring.test.js` fails if they disagree** — it also checks
  every projected entity still exists in the imported model, so a stale copy
  fails the suite rather than the app.

## The CVI views — `cvi/`

Eight Z view entities on the Customer/Vendor Integration customizing, in package
`ZMDM_LIGHT`, exposed through this same service definition. Unlike everything else
in this folder these **are** Z copies, and deliberately: `TB003A`, `TBD001`,
`CVIC_CUST_TO_BP1` and the rest have no released CDS view over them at all, so
there is nothing to expose instead. At a customer with strict ATC or clean-core
policy these direct table accesses will be flagged and become an explicit
exception.

| View | Entity set | Source tables |
|---|---|---|
| `Z_I_CVI_ROLE_CATEGORY` | `CviRoleCategories` | `TB003A` + `TBD002` + `TBC002` |
| `Z_I_CVI_BP_ROLE` | `CviBusinessPartnerRoles` | `TB003` + `TB003T` |
| `Z_I_CVI_CONTACT_MAPPING` | `CviContactMapping` | `CVIC_MAP_CONTACT` |
| `Z_I_CVI_PPO_CONTROL` | `CviPostprocessingControl` | `MDSC_CTRL_OBJPPO` |
| `Z_I_CVI_NUMBER_RANGE` | `CviNumberRanges` | `NRIV`, filtered |
| `Z_I_CVI_NUM_ASGN_CUSTOMER` | `CviCustomerNumberAssignments` | `TBD001` + `CVIC_CUST_TO_BP1` + `TB001` + `T077D` |
| `Z_I_CVI_NUM_ASGN_VENDOR` | `CviSupplierNumberAssignments` | `TBC001` + `CVIC_VEND_TO_BP1` + `TB001` + `T077K` |
| `Z_I_CVI_SYNC_DIRECTION` | `CviSyncDirections` | `MDSC_CTRL_OPT_A` |

Read by `srv/checks/cvi-checks.js` through `srv/cvi-config-service.cds`; the
reasoning behind each rule is in `CLAUDE.md`. **These files are the source as it is
activated on S4A**, fetched back out of the system on 2026-08-25 rather than typed
from memory — the only difference is that the three newest `expose` lines in the
`.asrvdsrv` are re-aligned to the column the other forty use.

Four things that cost an activation attempt each, so do not tidy them away:

- **A union needs `@Metadata.ignorePropagatedAnnotations: true`.** Without it the
  view does not activate. It applies to the two `NUM_ASGN` views.
- **The two direction literals in a union must be the same length** —
  `BP_TO_CUSTOMER`/`CUSTOMER_TO_BP` are both 14, `BP_TO_VENDOR`/`VENDOR_TO_BP`
  both 12 — otherwise they cannot share a column without a cast.
- **Casts on the flags are not needed.** `BD_SAMENUMBER` and `CVI_SAME_NUMBER` are
  both `CHAR(1)` and the union takes them as they are; casting only earns a
  "CAST CHAR to identical type" warning.
- **`POSITION` is a reserved word**, which is why `Z_I_CVI_BP_ROLE` aliases
  `posnr` as `RolePosition`.

`@EndUserText.label` over 40 characters is a **warning**, not an error:
`Z_I_CVI_NUMBER_RANGE` carries a 41-character label and activated fine. It was
worth shortening `Z_I_CVI_SYNC_DIRECTION`'s anyway rather than leaving a warning
behind.

Every flag in these sets arrives over OData as `Edm.Boolean`, never `'X'`. That is
not a detail — it made the role category rule wrong twice. See `CLAUDE.md`.

## Known drift, 2026-08-13

This file exposes **41** sets; the imported metadata carries **26**. Missing from
the metadata are all fourteen `*Texts` sets — `LanguageTexts`,
`FormOfAddressTexts`, `BusinessPartnerCategoryTexts`,
`BusinessPartnerGroupingTexts`, `BusinessPartnerTypeTexts`, `LegalFormTexts`,
`OccupationTexts`, `PrintFormatTexts`, `MaritalStatusTexts`,
`BirthDateStatusTexts`, `IndustryCodeTexts`, `IndustrySectorTexts`,
`IndustrySystemTexts`, `CustomerClassificationTexts`.

Either the binding was never republished after they were added here, or they were
dropped from the activated service and this file was not updated. Nothing depends
on them — see the note under the table — so it is cosmetic, but it means **this
file is not evidence of what the service actually exposes.** The `.edmx` is.

Of the 26 that do exist, 18 are projected into `BusinessPartnerService`. The
eight that are not: `Banks`, `BirthDateStatuses`, `BusinessPartnerTypes`,
`MaritalStatuses`, `Occupations`, `PrintFormats`, `TaxTypes`, `TradingPartners`.

## Field → entity set

| Maintain BP field | Section | Entity set | SAP view |
|---|---|---|---|
| `Country`, `NameCountry`, `BusPartNationality`, `BankCountryKey` | General, Addresses, Identifications, Bank | `Countries` | `I_CountryVH` |
| `Region` | Addresses, Identifications | `Regions` | `I_RegionVH` |
| `CorrespondenceLanguage`, `Language` | General | `Languages` (+ `LanguageTexts`) | `I_Language` |
| `AcademicTitle` | General | `AcademicTitles` | `I_AcademicTitleVH` |
| `FormOfAddress` | General | `FormsOfAddress` (+ `FormOfAddressTexts`) | `I_FormOfAddress` |
| `BusinessPartnerCategory` | General | `BusinessPartnerCategories` (+ texts) | `I_BusPartCategory` |
| `BusinessPartnerGrouping` | General | `BusinessPartnerGroupings` (+ texts) | `I_BusinessPartnerGrouping` |
| `BusinessPartnerRole` | Roles | `BusinessPartnerRoles` | `I_BusinessPartnerRoleStdVH` |
| `BusinessPartnerType` | General | `BusinessPartnerTypes` (+ texts) | `I_BusinessPartnerType` |
| `LegalForm` | General | `LegalForms` (+ texts) | `I_BusinessPartnerLegalForm` |
| `BusinessPartnerOccupation` | General | `Occupations` (+ texts) | `I_BusinessPartnerOccupation` |
| `BusinessPartnerPrintFormat` | General | `PrintFormats` (+ texts) | `I_BusinessPartnerPrintFormat` |
| `BusPartMaritalStatus` | General | `MaritalStatuses` (+ texts) | `I_BusPartMaritalStatus` |
| `BusinessPartnerBirthDateStatus` | General | `BirthDateStatuses` (+ texts) | `I_BusPartBirthDateStatus` |
| `IsFemale`, `IsMale`, `IsSexUnknown`, `GenderCodeName` | General | `Genders` | `I_BPGenderValueHelp` |
| `TradingPartner` | General | `TradingPartners` | `I_BPTradingPartner` |
| `Industry` | General | `IndustryCodes` (+ texts) | `I_BusPartIndustryCode` |
| `BPIdentificationType` | Identifications | `IdentificationTypes` | `I_BuPaIdentificationType` |
| `BPTaxType` | Tax Numbers | `TaxTypes` | `I_BusPartTaxTypeText` |
| `BPTaxType` (address-dependent) | Tax Numbers | `AddressDependentTaxTypes` | `I_BusPartAddrDepdntTaxTypeVH` |
| `IndustrySystemType` | Industries | `IndustrySystems` (+ texts) | `I_BusPartIndustrySystem` |
| `IndustrySector` | Industries | `IndustrySectors` (+ texts) | `I_BusPartIndustryKey` |
| `BankNumber`, `BankName`, `SWIFTCode` | Bank Details | `Banks` | `I_BusinessPartnerBank` |
| `CustomerAccountGroup` | Customer Data | `CustomerAccountGroups` | `I_CustomerAccountGroupStdVH` |
| `CustomerClassification` | Customer Data | `CustomerClassifications` (+ texts) | `I_CustomerClassification` |
| `SupplierAccountGroup` | Supplier Data | `SupplierAccountGroups` | `I_SupplierAccountGroupStdVH` |

**Ignore the `(+ texts)` notes above — the texts come free and the separate sets
are not in the service.** Every key set exposes a language-resolved `<Key>_Text`
property via `sap:text`, which survives the import as `@sap.text` on the key.
So `Countries` already carries `Country_Text` and no `Language` filter is needed
anywhere. This corrects an earlier note here that said the opposite.

Two exceptions to know about:

- `IdentificationTypes` has **no** description property at all — codes only.
- `Banks` (`I_BusinessPartnerBank`) lists banks already assigned to a business
  partner, not a bank directory, so a create form cannot offer an unused bank.

**`BPTaxType` uses `TaxTypes`, not `AddressDependentTaxTypes`** — reversed
2026-08-13. The flat key was the nicer shape, but `I_BusPartAddrDepdntTaxTypeVH`
is the address-*dependent* subset and returns exactly **one row (`FR1`)** on this
system, so `BE0`/`BE1`/`BE2` could never be picked even though partners here carry
all three. Coverage beats key shape.

The cost is the `Language` in the `TaxTypes` key: the catalogue arrives once per
installed language. `oneRowPerTaxType` in `srv/business-partner-service.js`
collapses it to one row per category, preferring the caller's locale and falling
back to English. It matches the language by **prefix**, because the metadata says
`String(2)` and that covers both the ISO code (`EN`) and the SAP key (`E`) —
guessing the wrong literal would filter the list to nothing.

`AddressDependentTaxTypes` stays exposed and projected; nothing points at it.

### Fields with no released value-help view

| Field | Check table | Note |
|---|---|---|
| `NameFormat` | `TSADFMT` | No released CDS view found. |
| `AuthorizationGroup` | `TBRG` | No BP-specific released CDS view found. |
| `SupplierProcurementBlock` | domain fixed values | Small fixed list. |

## If a view refuses to expose

Two things can block activation of the binding, both fixable per view:

- **No key / unsuitable key.** Some VDM views are not keyed for OData.
- **Input parameters.** Parameterised views can't be exposed as a plain set.

The fix in either case is a thin Z projection over that one view (declaring the
key, or supplying the parameter), exposed in place of the SAP view. Only needed
for the views that actually complain.

**Or the view simply is not in this release.** The SAP API release repository is
not an existence oracle for a given system. ADT rejected two, both already
replaced in the `.asrvdsrv`:

| Wanted | Not in this release | Used instead |
|---|---|---|
| Language | `I_LanguageVH` | `I_Language` (+ `I_LanguageText`) |
| Bank | `I_BankVH` | `I_BusinessPartnerBank` |

The pattern is that the `…VH` convenience views are the ones missing while the
plain key and text views resolve fine. If another fails, fall back to that pair
before writing a Z projection.

## Do not copy the SAP views

Every view above is `SAP_BASIS` / `SAP_ABA` / `S4CORE`, application components
`BC-SRV-ADR`, `BC-DOC-TTL`, `AP-MD-BP(-RAP)`, `LO-MD-BP`, `CA-GTF-CSC`,
`CA-BK-BNK`, `SD-MD-MM` — all released at clean-core level A. They sit in package
`MDC_BP_BO`, which reads like MDG but is not a licence boundary; MDG objects
carry `CA-MDG-*`.

This cost two dead ends before it was established, so it is worth stating: 26 `Z*`
copies were written that only copied the *names* and so still depended on the SAP
views existing, and a full transitive copy down to DDIC tables was then attempted
and is **not possible from here** — no available tool returns the DDL source of a
released view. To add a value help, add one `expose` line and transport.
