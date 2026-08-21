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

### Configuration, not master data

`duplicate-rules.cds`, `quality-rules.cds`, `field-properties.cds` and
`workflow-rules.cds` hold the data-steward rule tables — `DuplicateRules`,
`ValidationRules`, `DerivationRules`, `WorkflowRules`, and `FieldPropertyProfiles`
with its `FieldPropertySettings`, all in namespace
`mdmlight.config`. They live in the same database but are a different kind of
thing: staging is a request in flight, these are a control that outlives every
request. All of them are served by `DuplicateConfigService` under
`/service/duplicateconfig`, behind the `Steward` scope.

`WorkflowRules` is the odd one out in what it produces: it is not a check on the
data at all, but the routing hint that becomes the `approvers` list in the
workflow context.

**Condition values are a list on every rule table** (2026-08-21), encoded by
`srv/checks/value-lists.js` — deliberately a format where a single stored value is
already a valid one-entry list, so nothing had to be migrated when the older
tables joined. The column names differ and cannot be made to agree: `cds-deploy`
refuses to rename an element, so `DuplicateRules`, `ValidationRules` and
`DerivationRules` hold their list in `conditionValue` / `conditionValue2`, while
`WorkflowRules` — written after the decision — has `conditionValues`. Only the
*conditions* are lists: a validation's compared-against value and a derivation's
filled-with value stay single.

The rule tables are **row-per-criterion decision tables**, and that is a deliberate
choice against a column-per-criterion model: adding a criterion has to be an
INSERT, because `cds-deploy` refuses to drop elements and every removed criterion
would otherwise be a failed deployment from then on. `DuplicateRules` still
carries four superseded `cond*` columns for exactly that reason — do not write to
them.

`FieldPropertySettings` follows the same rule for the same reason: one row per
entity or field the profile says something about, carrying a single `property`
(`mandatory`/`readOnly`/`hidden`/`optional`). A **null `element` means the whole
entity**, and a field with no row at all is not mentioned by the profile — which
is deliberately different from a row saying `optional`.

The validation and derivation tables address fields as **qualified payload
fields** (`General.Language`, `Addresses.Country`), generated from `staging.cds`
by `srv/checks/payload-fields.js`. So a column added here becomes a rule field for
free — and a section id renamed here breaks every stored rule that names it.

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

**A rejection is not an end.** `reject` moves a request to `reworkRequired`, not
`rejected`, and the requester edits and resubmits or withdraws it. So
`reworkRequired` is an *active* status - the partner stays locked - and `posted` is
the only terminal one. A withdrawn request is deleted outright, header and staged
rows, which is the one place this schema loses history on purpose.

**No before-image tables.** Staging holds the requested state only, as MDG
does. Concurrency is handled by `sourceETag` on the header, compared against
S/4 immediately before posting. `postedBP` is the idempotency guard — a request
that already carries a number must never post again.
