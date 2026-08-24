# CVI in saps4amdg — what is configured, and what the app may assume

Customer-Vendor Integration is the S/4 mechanism that keeps a business partner and its
customer/vendor master in step. This app never creates a customer or vendor of its own: it
writes the BP through `API_BUSINESS_PARTNER` and CVI does the rest, inside S/4. So what CVI
is configured to do is part of this app's contract, and it is not in this repository.

Read against client 100 of `saps4amdg.alluvion.eu` on **2026-08-24**, read-only. Everything
under "Verified" was queried; everything under "Inferred" was reasoned from it and is worth
re-checking before it is relied on.

## The two stagings are not the same thing

Worth stating first, because the word collides.

- **This app's staging** is `mdmlight.staging.*` — 32 entities in **PostgreSQL on BTP**. A
  change request lives there while it is in approval. S/4 knows nothing about it.
- **MDG staging** is inside S/4. This app does not use it; nothing here writes to `USMD*`.

CVI therefore never sees a staged row. It fires when `postToS4` writes the approved request
to the real API, and not before — there is nothing in a Postgres table for it to react to.

## Verified

### Synchronisation is active in all four directions

`MDSC_CTRL_OPT_A`, all with `ACTIVE_INDICATOR = X`:

| Source | Target |
|---|---|
| BP | CUSTOMER |
| BP | VENDOR |
| CUSTOMER | BP |
| VENDOR | BP |

### It works, and it is synchronous

- `CVI_CUST_LINK`: 54 rows. `CVI_VEND_LINK`: populated.
- **0** business partners carrying `FLCU00`/`FLCU01` lack a customer link.
- **0** carrying `FLVN00`/`FLVN01` lack a vendor link.
- Link creation dates run from 2024-05 to 2026-08, spread across many days — so these were
  produced incrementally by live CVI, not by one conversion batch.
- `/SAPPO/ORDER_HDR` is **empty**: the Post Processing Office has never held a CVI error.

BP 563 (`TESTCVIBP`, grouping `0001`, role `FLVN01`) is the clearest single case:

| | |
|---|---|
| `BUT000.CRTIM` | 10:11:23 |
| `CVI_VEND_LINK.CRTIM` | 10:11:23 — **same second** |
| Vendor | `0000100118`, account group `KRED` |
| `LFA1` | name, country BE, city Gent, street copied from the BP |
| `LFB1` | none — no company code was entered |
| `CDHDR` | `BUPA_BUP` insert, **`TCODE` empty** |

An empty `TCODE` means no dialog transaction: this came in through the API. `CDHDR` logs UTC
(08:11:24) while the table timestamps are local (10:11:23, CEST) — the same moment, which is
what makes CVI synchronous here rather than queued.

**So the app does not need to wait or retry for the customer/vendor number.** It is there by
the time the next node is posted. If CVI is ever switched to asynchronous, that stops being
true and `resolveRelationNumber` returning null becomes a timing bug rather than a real
"role does not exist" answer.

### Number ranges — this is where the app has a real limit

`NRIV`, object `BU_PARTNER`:

| Range | From – To | External | Used by grouping |
|---|---|---|---|
| `01` | 1 – 999999999 (at 570) | no | `0001`, `BP02`, `COMP`, `GPIN`, `C012`, `DAR1`, `ETM`, `IMMO`, `S012`, `SRM`, `TR01` |
| `AB` | A – ZZZZZZZZZZ | **yes** | `0002`, `GPEX`, `S100`–`S160` |
| `MD` | 9000000000 – 9999999999 | **yes** | `MDM0` |

The app never sends a BP number — `BusinessPartner` is not in `CREATE_FIELDS` in
`srv/business-partner-service.js`. **A create under any grouping on `AB` or `MD` therefore
cannot work**, and the grouping value help offers them anyway. `0002` already has 14
partners; `MDM0` has none, which matters if it is meant to become the MDM grouping.

Groupings in use: `0001` (226), `0002` (14), `BP02` (79), `COMP` (1), `GPIN` (2).

Downstream ranges, for completeness:

- `DEBITOR` `01` = 1–99999 internal, at 65 → account group `DEBI`. The 54 customers are 1–54.
- `KREDITOR` `02` = 100000–199999 internal, at 100119 → account group `KRED`. Vendor 100118.
- Both objects also have an `XX` range which is external. Most vendor account groups
  (`LIEF`, `0001`–`0007`, `0100`, `CPDL`, `MNFR`) point at it; `KRED` does not.

### The account group is not derived from customizing

All four assignment tables are **empty**:

- `CVIC_CUST_TO_BP1` (account group → grouping, same-number flag)
- `CVIC_CUST_TO_BP2` (account group → BP role)
- `CVIC_VEND_TO_BP1`, `CVIC_VEND_TO_BP2`

And `TB001.KTOKD` — the grouping's account group — is blank for every grouping.

Yet every customer came out as `DEBI` and BP 563's vendor as `KRED`. So the account group
reaches CVI from the **caller**, not from a mapping. For this app that is
`CustomerAccountGroup` / `SupplierAccountGroup` on the `Customers` / `Suppliers` node, which
`MAINTENANCE_ENTITIES` already makes a required create field.

**This corrects an earlier assumption.** There is no grouping → account group mapping to
validate a requester's choice against, so a validation of that kind cannot be written from
this customizing. What can go wrong instead is an account group whose number range is
external (`XX`), which would fail the same way an external BP grouping does.

### Field mapping is configured

`CVI_BP_CV_ASSIGN` is populated for both `C` and `S`, mapping BP screen fields onto `KNA1` /
`LFA1` / `ADRC` columns. BP 563 confirms it end to end: name, country, city and street
arrived on the vendor.

## The table map

| Table | What it holds |
|---|---|
| `MDSC_CTRL_OPT_A` | which synchronisation directions are active |
| `CVI_CUST_LINK` | BP GUID ↔ customer, with created-by and timestamp |
| `CVI_VEND_LINK` | BP GUID ↔ vendor |
| `CVI_CUST_CT_LINK`, `CVI_VEND_CT_LINK` | contact-person links |
| `CVI_BP_CV_ASSIGN` | BP field → customer/vendor field mapping |
| `CVIC_CUST_TO_BP1/2`, `CVIC_VEND_TO_BP1/2` | number and role assignment (empty here) |
| `CVI_FLDGR_ASSIGN` | field group assignment |
| `CVIC_LEGFORM_LNK`, `CVIC_MARST_LINK`, `CVIC_CP1..4_LINK`, `CVIC_CCID_LINK` | value mappings for legal form, marital status, contact person, credit control area |
| `TB001` | BP groupings: number range, internal/external default, account group |
| `TB003` | BP roles |
| `BUT000` / `BUT100` | BP header / BP roles per partner |
| `T077D` / `T077K` | customer / vendor account groups and their number ranges |
| `NRIV` | the ranges themselves — `BU_PARTNER`, `DEBITOR`, `KREDITOR` |
| `/SAPPO/ORDER_HDR` | Post Processing Office: where a failed CVI run lands |

## Inferred, not verified

- **Which IMG node each empty `CVIC_*` table belongs to.** That the tables are empty is
  verified; the mapping from table to IMG path is not.
- **That `CUSTOMER → BP` would fail today.** The direction is active but its number
  assignment is empty, so creating a customer directly in FI has nothing to derive a BP
  grouping from. Nobody has tried — the PPO is empty — so this is reasoning, not a result.
- **That BP 563 came from this app** rather than another API client. `TCODE` is empty and the
  user is `GEERAERT`, which fits the app posting under principal propagation, but no
  technical user distinguishes them. There is no app-created BP that can be identified as
  such with certainty.

## What to check when something breaks

1. `/SAPPO/ORDER_HDR` — a CVI failure lands here rather than in the caller's error.
2. `CVI_CUST_LINK` / `CVI_VEND_LINK` for the partner's GUID — no row means CVI did not run.
3. `MDSC_CTRL_OPT_A` — the direction may have been switched off.
4. The grouping's range in `TB001` → `NRIV` — external means this app cannot create it.

## Making the staging anticipate CVI

CVI itself cannot run against a staged request: the request is rows in PostgreSQL, and CVI
only reacts to a real BP write. What the staging *can* do is anticipate it — so that adding
role `FLCU01` puts the Customer node into the request there and then, rather than leaving the
approver to find out at posting time that a customer is coming.

That needs **no code**. Two derivation rules do it, because a rule whose target section holds
no rows proposes the row, and one whose section has rows fills its gaps:

| | Customer | Supplier |
|---|---|---|
| Condition 1 Field | `BusinessPartnerRoles.BusinessPartnerRole` | `BusinessPartnerRoles.BusinessPartnerRole` |
| Condition 1 Value | `FLCU00\|FLCU01` | `FLVN00\|FLVN01` |
| Field | `Customers.CustomerAccountGroup` | `Suppliers.SupplierAccountGroup` |
| Value | `DEBI` | `KRED` |

A condition on another section is an "any row" test, so this reads as *this partner has a
customer role*. `DEBI` and `KRED` are what CVI actually assigns in this system — read off the
existing masters, not off customizing, because there is no grouping → account group mapping
here to read.

Verified against the engine, all eight cases:

- either customer role stages `Customers` with `DEBI`; either supplier role stages
  `Suppliers` with `KRED`; both roles stage both
- no role stages nothing
- a requester who already filled the account group in is left alone
- a row that exists but has no account group gets one filled

Two things to know. It is a **proposal**: the requester presses Check and ticks it, the same
as every other derivation - nothing is written behind their back. And staging the node is
what makes the company code, sales area and dunning sections reachable, which is the real
point: they hang off the Customer/Supplier record.

## MDG staging — the other place CVI can work, and it is reachable

Read 2026-08-24. This is a different route from everything above and is not what the app does
today; it is written down because it turned out to be possible, which was not obvious.

MDG is live in this system, not dormant:

| | |
|---|---|
| Data model `BP` | active, active area `PARTNER` |
| MDG change requests in `USMD120C` | **876** |
| BP request types in use | `BP1P1` (148), `BP2P1` (80), `BP5P1` (16), `BP6P1` (6), `BPF1P1` (7) |
| MDG staging area | ~2200 generated `/SMD/` tables |

In MDG a change request's ERP Customer / ERP Supplier data sits in that staging, and CVI
writes it to `KNA1` / `LFA1` at activation. So CVI *does* work on staged data — just not on
this app's staging, which is PostgreSQL and outside S/4 entirely.

### It can be written over OData

`MDG_BP_SRV` is registered and **active**. Its entity sets are writable — read out of
`CL_MDG_BP_MPC`, which is generated from the service model:

| Entity set | creatable | updatable | deletable |
|---|---|---|---|
| `ChangeRequests` | X | X | X |
| `BusinessPartners` | X | X | X |

`ChangeRequests` carries `ChangeRequestId`, `ChangeRequestType`, `AdditionalInformation`,
`RequestReason`. `BusinessPartners` binds `/MDGBP/_S_BP_PP_BP_HEADER`, a generated MDG
structure, so a write lands in staging rather than in `BUT000`. The service also models
`CentralData`, `Address`, `Role`, `BankDetail`, `TaxNumber`, `Identification`, `Relation` and
the contact-person entities.

**So no ABAP is needed to reach MDG staging.** That was the open question and the answer is no.

### Three things to weigh before using it

- **`MDG_BP_SRV` is `NOT_RELEASED`.** It is the backend of SAP's own MDG Fiori app, not a
  released API. SAP may change it in an upgrade without notice, and nothing obliges them to
  keep it compatible. `MDG_CUSTOMER_SRV` and `MDG_SUPPLIER_SRV` are the same.
- **It is a different model.** `BP_HEADER`, `BU_TYPE`, `TXTLG` — not `A_BusinessPartner`. Every
  field this app maps today would need a second mapping to reach it.
- **It brings MDG's lifecycle with it.** A CR in MDG staging is governed by MDG: its own
  change request types, its own workflow, its own activation. That is the machinery this app
  was built to replace, so adopting it is an architecture decision rather than a feature.

### What was checked and found not to work

- `ZUI_MDG_CHANGEREQUEST_O2` — the custom service here — is read-only reporting:
  `ZC_MDG_ChangeRequest` over `ZI_MDG_ChangeRequest` joined to workflow agents, with no
  behavior definition. It lists change requests and cannot create one. It also sits in `$TMP`.
- The `MDG_BS_BP*` objects are DDIC structures and access classes, not a callable interface.
