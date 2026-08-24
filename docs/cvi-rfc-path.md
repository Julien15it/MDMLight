# Calling CVI from CAP — the RFC path

Goal: run CVI over a staged change request without persisting it, so the requester and the
approver see CVI's own validations and derivations before anything is created, and the same
call activates at approval. The mechanism is in [cvi.md](cvi.md); this is how the app reaches it.

Verified against `saps4amdg.alluvion.eu` client 100 on 2026-08-24, read-only.

## The target

| | |
|---|---|
| Function module | `RFC_CVI_EI_INBOUND_MAIN`, package `MD_BP_MAINTAIN` |
| Remote-enabled | yes — `TFDIR.FMODE = 'R'` |
| Dry run | `iv_docommit = ' '` (default `'X'`) |
| Also takes | `iv_create_applog`, `iv_suppress_taxjur_check` |
| Returns | BAPI messages per object |

`CVI_EI_INBOUND_MAIN` is **not** remote-enabled (`FMODE` blank) — the `RFC_` one is the entry
point.

The parameters are ~60 tables, one per node, and they line up with this app's staging almost
one for one — see the table in [cvi.md](cvi.md). Each row carries `OBJECT_TASK`, the change
indicator, which is what `action` already is in the staging entities: `C`/`U`/`D`. And a
`RUN_ID` groups the tables of one call.

`CVIS_BP_GENERAL`, for shape: `RUN_ID`, `BPARTNER`, `BPARTNERGUID`, `OBJECT_TASK`, then the BP
fields flattened — `CATEGORY`, `GROUPING`, `SEARCHTERM1/2`, `NAME1`–`NAME4`, `LEGALFORM`,
`AUTHORIZATIONGROUP`, `PARTNERLANGUAGE`, and so on.

## What the app has today

`package.json` declares HTTP destinations only:

| Service | Kind | Destination |
|---|---|---|
| `API_BUSINESS_PARTNER` | odata-v2 | `VF_S4HANA_DEST` |
| `ZSRVB_MDMLIGHT_VH` | odata-v2 | `VF_S4HANA_DEST` |
| `SBPA_DESTINATION` | rest | `sbpa-destination` |

No RFC anywhere, and CAP has no built-in RFC client.

## Two blockers on the RFC route

Both are infrastructure, not code, and both need deciding before the mapping work is worth
starting.

**1. The SAP NetWeaver RFC SDK is a licensed native library.** `node-rfc` is a native addon
that binds to it. It has to be present when `npm ci` builds the addon *and* on the runtime,
with `LD_LIBRARY_PATH` pointing at it. On Cloud Foundry that means vendoring the SDK into the
deployment — and **the SDK may not be committed to a public repository**. If
`github.com/Julien15it/MDMLight` is public, this route needs a private artifact store or a
custom buildpack instead. The app currently builds with the standard `nodejs_buildpack` and
`npm ci`; this changes that.

**2. The Cloud Connector needs RFC access control.** Today it exposes HTTP for
`VF_S4HANA_DEST`. RFC is a separate protocol with its own resource list, and
`RFC_CVI_EI_INBOUND_MAIN` has to be allow-listed by name. Plus a BTP destination of
`Type=RFC`.

## The SOAP attempt, and why it stopped

Tried on 2026-08-24: a service definition over the function group in SE80, then a binding in
SOAMANAGER. SE80 reported "Active object generated", but nothing was persisted. Verified
read-only against the repository:

| Check | Result |
|---|---|
| `TADIR`, types `WEBS` + `WEBI`, `AUTHOR <> 'SAP'` | **0 rows** — no user-created web service or virtual interface exists in this system |
| `TADIR`, type `SRVD`, names `Z%` | 7, all pre-existing (`ZPA_*`, `ZMDG*`, `ZMDML_VH_ENTITY`) |
| `TADIR`, any type, name `%CVI%` or `%INBOUND%` | only SAP objects |
| `E070`, transports since 2026-08-20 | one, by `DESMET` on the 20th — nothing on the 24th |

`WEBS` and `WEBI` are the types the wizard writes, and this system carries hundreds of
SAP-delivered ones, so their absence for a non-SAP author is meaningful rather than a gap in
where I looked. `TADIR` is client-independent, so a different client does not explain it. A
local (`$TMP`) object would still have a `TADIR` row.

So the classic SOAP wizard is not a route that works here, and it is not worth more attempts.

## The route to take instead — OData, in the package that already has one

`ZMDM_LIGHT` already contains a working ABAP-to-HTTP exposure that this app consumes:

| Object | Type | Author |
|---|---|---|
| `ZMDML_VH_ENTITY` | `SRVD` service definition | `EYLENBOSCH` |
| `ZSRVB_MDMLIGHT_VH` | `SRVB` service binding, OData V2 | `EYLENBOSCH` |
| `Z_I_BUPA_GROUPING_CDS` | `IWSV`/`IWSG`, the SEGW-style route | `GEERAERT` |

`package.json` already declares `ZSRVB_MDMLIGHT_VH` as an `odata-v2` remote service over
`VF_S4HANA_DEST`. That means the destination, the Cloud Connector allow-list on
`/sap/opu/odata/`, and the authentication are all proven for this exact path — none of it has
to be arranged again, and `/sap/bc/srt/*` never needs adding.

The shape:

1. A class in `ZMDM_LIGHT` that takes the request as **one JSON payload** shaped like the CVI
   tables, deserialises it into the typed tables, calls `RFC_CVI_EI_INBOUND_MAIN` with
   `iv_docommit = ' '`, and returns the BAPI messages as JSON.
2. A **separate** service definition and binding — not an addition to `ZMDML_VH_ENTITY`, so the
   value-help service the app already depends on is not destabilised.
3. CAP calls it as one more remote service, the way it already calls two others.

One JSON blob in, messages out, keeps the ABAP thin and written once: no ABAP work per node,
and the sixty-table mapping stays in CAP where the staged rows already are — which is what
makes it transport-independent, as below.

The cost is ABAP development rather than a wizard. But the wizard produced nothing, and this
follows a pattern the team has already made work twice in this same package.

## Whichever route, build this first

The payload mapping is the bulk of the work and it is **transport-independent**: turning
staged rows into the CVI tables is the same job whether it travels as RFC, SOAP or JSON. So
the order that wastes nothing:

1. **Prove the transport with the smallest possible call.** One `it_bp_general` row,
   `iv_docommit = ' '`, and see messages come back. That exercises the destination, the Cloud
   Connector, the library and the function module in one go. If this cannot be made to work,
   nothing else matters.
2. **Then map node by node**, starting with what a create actually needs: `it_bp_general`,
   `it_bp_role`, `it_bp_address`, `it_cust_general`.
3. **Then wire it into the pipeline** as a check stage, so CVI's messages land beside the
   app's own findings.

Step 1 is the risk. Steps 2 and 3 are volume.

## One thing to test before relying on the dry run

`finalize_ids` draws customer and vendor numbers from the number range, and a number range
draw is not generally rolled back by omitting the commit. So `iv_docommit = ' '` may still
**consume** numbers.

`KREDITOR` range `02` stood at **100119** on 2026-08-24 (`NRIV`). Run one dry call and read it
again. If it moved, a dry run costs numbers, and that has to be acceptable or avoided another
way — for example by validating without the customer/vendor tables and accepting that the
number determination is not covered.
