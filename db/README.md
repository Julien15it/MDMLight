# Persistence

Staging for MDMLight change requests, on a dedicated PostgreSQL instance in the
MDMLight dev space.

## Setup

None. `mta.yaml` provisions the instance as a managed service, and the
`mdm-businesspartner-db-deployer` module runs `cds-deploy` against it as a
one-off task. There are no roles, schemas or grants to create — the app owns
the whole database, so CAP deploys into `public`.

Verify the plan name before the first deploy, since it varies by subaccount
entitlement:

```sh
cf marketplace -e postgresql-db
```

`mta.yaml` currently requests plan `free` and `engine_version: "16"`.

## Local development

`db.kind` is `sqlite` by default and `postgres` only under the `production`
profile, so `cds watch` needs no database service. To test against real
PostgreSQL locally, run one in Docker (see the CAP PostgreSQL guide) and use
`cds watch --profile pg` — not the cloud instance, which is unreachable from
outside Cloud Foundry.

## Admin access to the cloud instance

BTP PostgreSQL instances get private addresses (the previous one resolved to
`10.16.180.188`), so no client on a laptop or in BAS can connect directly, and
the instance will never appear in the BAS Database Explorer — that tool only
lists HANA anyway.

To inspect data, tunnel through an app bound to the instance:

```sh
cf ssh mdm-businesspartner-srv -L 15432:<db-host>:<db-port> -N
```

then connect a client to `localhost:15432`. Get the host and port from
`cf env mdm-businesspartner-srv`. SSH may need enabling first
(`cf enable-ssh <app>` plus a restart).

## Schema evolution

`cds-deploy` computes a delta against the model stored in `cds_model` and
applies it. It only performs non-lossy changes — adding entities and elements,
widening strings and integers. Removing an element, changing a key, or any
other type change is rejected and needs a manual migration script
(`cds deploy --script --delta-from ...`). Worth knowing before the change
request model settles.

## Model

`staging.cds` follows the MDG pattern: one typed table per Business Partner
node, mirroring the sections of the Maintain BP app.

| Staging entity | App section | S/4 entity |
|---|---|---|
| `StagedGeneral` (1:1) | General Information | `A_BusinessPartner` |
| `StagedAddresses` | Addresses | `A_BusinessPartnerAddress` |
| `StagedRoles` | Roles | `A_BusinessPartnerRole` |
| `StagedBankDetails` | Bank Details | `A_BusinessPartnerBank` |
| `StagedTaxNumbers` | Tax Numbers | `A_BusinessPartnerTaxNumber` |
| `StagedIdentifications` | Identifications | `A_BuPaIdentification` |
| `StagedIndustries` | Industries | `A_BuPaIndustry` |
| `StagedCustomer` (1:1) | Customer Data | `A_Customer` |
| `StagedSupplier` (1:1) | Supplier Data | `A_Supplier` |

`ChangeRequests` is the header; `CheckFindings` holds duplicate and
data-quality results.

### Decisions worth not undoing by accident

**Types come from the S/4 metadata.** Every column length was read out of
`srv/external/API_BUSINESS_PARTNER.csn`, so a staged value can never be
truncated on the way to S/4. If a field changes there, change it here.

**Approvals are not modelled.** SAP Process Automation owns approval state. The
header keeps `processInstanceId`, `submittedAt` and `submittedBy` to correlate
with the running process, and `status` collapses the whole approval phase into
`inApproval` regardless of how many steps SPA runs.

**Collection rows are keyed by a surrogate `ID`, not the S/4 key.** On a create
there is no `AddressID` yet — S/4 assigns it. The natural key fields stay
nullable and are filled once known. `action` (`C`/`U`/`D`) carries per-row
intent, as MDG's change indicator does.

**Derived and system fields are absent from `StagedGeneral`** — full names,
UUID, ETag, created/changed by and on. S/4 owns them; staging them would invite
writing stale values back.

**No before-image tables.** Staging holds the requested state only, as MDG
does. Concurrency is handled by `sourceETag` on the header, compared against
S/4 immediately before posting. `postedBP` is the idempotency guard — a request
that already carries a number must never post again.
