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

## The lighter alternative

Expose `RFC_CVI_EI_INBOUND_MAIN` as a **SOAP service** in S/4: a service definition from the
function module and a binding in SOAMANAGER. No ABAP code — a wizard and a binding.

The app then calls it over plain HTTP through the destination and Cloud Connector path that
already works. No native library, no licence, no buildpack change, no second protocol in the
Cloud Connector.

The cost is a verbose SOAP envelope for a call with sixty table parameters, and one
configuration step in S/4 that needs someone with write access — I have read-only.

## Either way, build this first

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
