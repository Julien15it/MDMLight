# Persistence

Staging for MDMLight change requests, on the shared PostgreSQL instance
`sap-mcp-postgres-aidataenabler` (free plan, eu-central-1, PG 16).

## Why a shared instance

The subaccount is at its PostgreSQL instance quota, and the instance already in
use is a sandbox, not production. MDMLight therefore binds the existing
instance instead of provisioning one, and isolates itself in its own schema.

## Setup, once

1. Run `setup-schema.sql` against database `JeKIkfeREeNq` as the currently
   bound user. This creates role `mdmlight_app`, schema `mdmlight`, and pins
   the role's `search_path` to that schema.

2. Create a user-provided service holding that role's credentials — same host,
   port and database as the existing binding, but the new user and password:

   ```sh
   cf cups mdmlight-postgres -p '{
     "hostname": "<host>",
     "port": "<port>",
     "dbname": "JeKIkfeREeNq",
     "username": "mdmlight_app",
     "password": "<password>",
     "uri": "postgres://mdmlight_app:<password>@<host>:<port>/JeKIkfeREeNq"
   }'
   ```

   `mta.yaml` binds `mdmlight-postgres`, not the managed instance directly.

3. Deploy. The `mdm-businesspartner-db-deployer` task runs `cds-deploy`, which
   creates the tables and the `cds_model` table used for schema evolution.

## Why the schema is set server-side

`@cap-js/postgres` credentials are `host`, `port`, `user`, `password`,
`database` — there is no `schema` key. Setting `search_path` on the role means
every connection resolves to `mdmlight` with no client-side configuration, and
nothing in the app needs to know the schema exists.

## Local development

`db.kind` is `sqlite` by default and `postgres` only under the `production`
profile, so `cds watch` keeps working with no database service. To test against
real PostgreSQL locally, put credentials in `.env` (git-ignored) under a
profile, then `cds watch --profile pg`.

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
