# Deployment, MTA and working alongside the other developers

<!-- paths: mta.yaml, tools/**, app/*/xs-app.json, .cdsrc*.json -->

Build and deploy: `mbt build` then
`cf deploy mta_archives/mdm-md-businesspartner-manage_<version>.mtar`.

## No approuter module — managed approuter via Work Zone

The standalone approuter was removed. `app/businesspartner/xs-app.json` is the routing config and the
only one: `build:cf` copies it into `dist/` so it ships to the HTML5 repo, and the managed approuter
applies it. That is why every `/service/*` route lives there.

Why: the BAS Workflow UI generator crashes on a project declaring both a standalone `approuter.nodejs`
module and the managed-approuter markers, and SAP's guide requires Managed Approuter for the workflow UI
template. The MTA was scaffolded for managed all along.

- The dev-space mapped route is gone; access is the Work Zone site URL.
- `mdm-businesspartner-repo-runtime` is required by no module and kept deliberately.
- If login loops after adding the app to a site, check XSUAA `redirect-uris` in `mta.yaml` —
  `https://*.${default-domain}/**` may not cover the Work Zone launchpad host.

## MTA (`mta.yaml`)

Four modules — CAP service (`mdm-businesspartner-srv`), HTML5 app-content deployer,
destination-content — plus resources (XSUAA, HTML5 repo host/runtime, destination service,
connectivity, AI Core `extended`, `mdm-businesspartner-authmgmt`, and the BPA user-provided services).

**The CAP module path is `gen/srv` (the `cds build` output), not `srv/`** — always rebuild before
assuming `mbt build` picked up service changes.

## The PostgreSQL deployer blocks on any dropped column

`mdm-businesspartner-db-deployer` runs `cds-deploy` as a one-off task, evolving the schema against the
previously deployed model CAP stores in table `cds_model`. Any removal fails with
`Error: Dropping elements is not supported`, identically on every retry (compile-time — the deployer
never reaches the database). `--auto-undeploy` is HDI-only. While staging holds nothing worth keeping
the fix is to wipe and redeploy; once it holds real requests, write a migration.

**Diagnose a deploy failure from the MTA operation log, not the `cf deploy` console output**, which only
says a task failed: `cf mta-ops` lists every operation on an MTA ID (including other developers'), and
`cf dmol -i <operation-id> -d <dir>` downloads the per-module logs.

Before the first deploy of a subaccount, verify `postgresql-db`'s plan name — it varies by entitlement
and `mta.yaml` requests `free`: `cf marketplace -e postgresql-db`.

`tools/wipe-staging.js` does the wipe (lists what it would drop, stops without `--yes`). Two BTP
constraints it already handles: the bound role does **not** own schema `public` (so it drops objects
individually) and `public` contains extension objects owned by someone else.

The endpoint is private — nothing connects from a laptop or BAS, and the BAS Database Explorer only
lists HANA. Two ways in:

```bash
# in CF, where the address routes - no tunnel
cf set-env mdm-businesspartner-db-deployer WIPE_JS "$(base64 -w0 tools/wipe-staging.js)"
cf run-task mdm-businesspartner-db-deployer --name peek \
  --command 'cd /home/vcap/app && printf %s "$WIPE_JS" | base64 -d > w.js && node w.js'
cf logs mdm-businesspartner-db-deployer --recent
cf unset-env mdm-businesspartner-db-deployer WIPE_JS

# or tunnel and use any client
cf ssh mdm-businesspartner-srv -L 15432:<hostname>:<port> -N &
```

**Pass the payload through an env var rather than inlining it in `--command`** — long single-token
commands get line-wrapped in transit and bash executes the fragments separately. (The same
env-var-passthrough `cf run-task` trick is how the BTP API shapes in `workflow.md` were diagnosed.)

For reading staged data, prefer OData over SQL:
`<srv-url>/service/changerequest/ChangeRequests?$expand=general,addresses,roles,findings`

`cds build` also materialises all 65 imported `API_BUSINESS_PARTNER` entity sets as physical tables and
views despite nothing reading them. Empty noise, not state — do not "fix" bugs by looking at them.

## Configuration notes

- `.cdsrc.json` — checked in; CAP build target (`gen`), `xsuaa` auth in production.
- `.cdsrc-private.json` — gitignored; hybrid-profile bindings tied to a specific CF org/space.
  Regenerate with `cds bind` rather than hand-editing paths from another environment.
- Local secrets (`.env`, `default-env.json`, `credentials.json`) are gitignored — **never commit S/4 or
  BPA credentials** into `mta.yaml`, `.cdsrc-private.json`, or source.
- Hybrid testing needs service keys bound with `cds bind`. The destination must be named
  `VF_S4HANA_DEST`, URL ending at `/sap/opu/odata/sap` — CAP appends `/API_BUSINESS_PARTNER` or
  `/ZSRVB_MDMLIGHT_VH`. On-premise needs `ProxyType=OnPremise` via Cloud Connector and `csrf: true`.

## Working alongside the other developers

Several people push to `main` in the same CF space, so a failure is often someone else's build.

**Check what you are deploying before assuming a bug.** MTA deploys take a per-MTA-ID, per-space lock; a
second `cf deploy` while one is in flight aborts with a conflicting-process error that reads like a
broken deployment. Check `cf mta-ops` for a colleague's `RUNNING` operation before deploying or
retrying.

**Do not revert the staging feature to unblock a deploy.** It has been reverted once already when the
real cause was elsewhere, and reverting has a trap: once a commit is reverted on `main`, git considers
it merged, so re-merging the feature branch brings back *nothing* — the feature only returns if the
revert is itself reverted.

**Watch merges of long-lived branches.** One merge auto-merged by concatenating both sides rather than
conflicting, producing a `package-lock.json` with two complete lockfile documents and a test file with
two tests joined without the closing `});`. After merging a drifted branch, sanity-check
`package-lock.json` and run `npm test` before concluding anything about a deploy failure.

## The database pool (2026-09-04)

`cds.requires.db.[production].pool` carries `acquireTimeoutMillis: 10000` and `min: 1`. The default
1000 ms acquire timeout answered a concurrent Check with `500 TimeoutError: ResourceRequest timed
out` from `generic-pool`: a check holds its connection for the 4-7s it spends in S/4, and a free-plan
connection can take longer than a second to open. `max` is deliberately left at the CAP default -
naming a number here could only lower it.

This raises the ceiling; it does not remove the coupling. The connection is still held across the
remote call. Releasing it around the S/4 call is the actual fix and is not done.

## The srv module installs from the lockfile (2026-09-04)

`mdm-businesspartner-srv` uses `builder: custom` rather than `builder: npm`. The npm builder runs a
bare `npm install --production`, which re-resolves all 94 packages from version ranges on every
build - measured at **5 minutes** for 8 direct dependencies, most of the tree being `@sap/cds` and
the three `@sap-cloud-sdk` packages.

Both commands fall back instead of failing, and that is the point: `cp -n` supplies the root
lockfile only if `cds build` did not already copy one into `gen/srv`, and `npm ci` refuses outright
if the generated `package.json` does not satisfy the lockfile, in which case `npm install` runs
exactly as it did before. **Do not remove either `||`** - a slow build is recoverable, a build
nobody can run is not.

Unverified when written: whether `cds build` copies `package-lock.json` into `gen/srv` at this
cds-dk version, and whether `npm ci` accepts the generated `package.json`. The build log answers
both - it names the command it ran. If it says `npm ci`, this worked; if it fell through to
`npm install`, the lockfile and the generated manifest disagree and that is the thing to fix next.

`mdm-businesspartner-db-deployer` (`gen/pg`) is a second nodejs module with its own install and is
deliberately untouched until this one is proven.
