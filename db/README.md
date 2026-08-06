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

`staging.cds` — `ChangeRequests` as the root, with:

- `ChangeRequestPayloads` — requested state as JSON, the source for the S/4 write
- `ChangeRequestBeforeImages` — BP state read at request creation
- `Approvals` — one row per approval step
- `CheckFindings` — duplicate and data-quality results

Two fields carry design intent worth preserving: `sourceETag` is compared
against S/4 before posting so a concurrent change is detected rather than
overwritten, and `postedBP` is the idempotency guard — a request that already
has a number must never post again.
