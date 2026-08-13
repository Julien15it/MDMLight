# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CAP (Node.js) + SAP Fiori Elements (OData V4) recreation of the standard SAP app
`mdm.md.businesspartner.manage` (F3163). There is **no local business-partner
database** — the CAP service is a live facade that delegates every request to an
S/4HANA system's OData V2 `API_BUSINESS_PARTNER` service through the BTP
destination `VF_S4HANA_DEST`. Deletion of Business Partners is deliberately
disabled throughout the facade.

Reads are still pure facade, but **creates no longer go straight to S/4** — they
are staged in PostgreSQL and posted only once an approver accepts them. Read
"Change request staging" below before touching `db/staging.cds`,
`srv/change-request-service.*`, or the maintenance controller.

## Commands

Root (CAP service):
```bash
npm ci                 # install
npm run watch           # cds watch — dev server with auto-reload, http://localhost:4004
npm start                # cds-serve (no watch)
npm test                 # node --test test/*.test.js — runs all tests
node --test test/business-partner-service.test.js   # run a single test file
npm run local            # cds watch --profile hybrid (uses live BTP-bound destinations, see below)
npm run build            # cds build --production
npm run deploy           # cds deploy
```

Run a single `node:test` case by name: `node --test --test-name-pattern="<pattern>" test/business-partner-service.test.js`.

UI (`app/businesspartner`, separate npm project):
```bash
cd app/businesspartner
npm install
npm start                # fiori run against the live/mocked backend, opens flpSandbox
npm run start-mock        # fiori run against local mock data (ui5-mock.yaml)
npm run generate:metadata # regenerate maintenance metadata used by the full-screen create/edit UI
npm run unit-tests        # QUnit unit tests via fiori run
npm run int-tests         # OPA5 integration tests via fiori run
npm run build:cf          # generate metadata + ui5 build preload for Cloud Foundry
npm run package:cf        # zip the built app for HTML5 repo deployment
```

Deployment (multi-target app):
```bash
mbt build
cf deploy mta_archives/mdm-md-businesspartner-manage_<version>.mtar
```

### Local hybrid testing against live BTP services

`npm run local` (`cds watch --profile hybrid`) requires service keys bound via
`cds bind`, configured in `.cdsrc-private.json` (gitignored) under
`requires.[hybrid]`. To (re-)bind a service (e.g. after the AI Core instance is
created in Cloud Foundry):
```bash
cds bind -2 mdm-businesspartner-aicore
cds watch --profile hybrid
```
Without a working destination binding, CAP still compiles and `npm test` still
runs, but any live S/4HANA call will fail.

## Architecture

### Facade, not a data model
`srv/business-partner-service.cds` defines `BusinessPartnerService`, a
projection over the imported `API_BUSINESS_PARTNER` model
(`srv/external/API_BUSINESS_PARTNER.{csn,edmx}` — imported from S/4HANA's
`$metadata`, all 65 entity sets). Almost every entity is `@readonly`; only
`BusinessPartners` and a small set of maintenance **actions** allow writes.
Two exclusion lists (`A_Customer excluding {...}`, `A_Supplier excluding {...}`)
work around fields present in the imported metadata but not exposed by this
particular on-premise S/4 release — if a section read fails with "Resource not
found for the segment", check whether a field needs to move into one of these
excludes rather than assuming a bug.

If the target S/4 system exposes different metadata (different release/config),
re-import `$metadata` for `API_BUSINESS_PARTNER` and rebuild — don't hand-edit
the generated `.edmx`/`.csn`.

### The imported models are copies, and they go stale silently

Both remote services (`API_BUSINESS_PARTNER` and the value-help service
`ZSRVB_MDMLIGHT_VH`) are compiled from files in `srv/external`. Nothing reads
`$metadata` to serve a request, and nothing can: `as projection on` is resolved
by the CDS compiler and `mbt build` runs offline. The exclusion lists above exist
because of exactly this — the copy carries fields this release does not expose.

```bash
npm run import:bp          # re-import API_BUSINESS_PARTNER
npm run import:valuehelp   # re-import ZSRVB_MDMLIGHT_VH
```

The bare form goes through `VF_S4HANA_DEST` and **only works in Cloud Foundry**.
The SAP Cloud SDK resolves destinations from `VCAP_SERVICES`; `cds bind` writes
`.cdsrc-private.json`, which CAP reads and the Cloud SDK does not, and
`cds bind --exec` still needs `mdm-businesspartner-destination-service` bound plus
the connectivity proxy, which exists only in the CF runtime. Expect
`Could not find service binding of type 'destination'` in BAS — that is the
environment, not a bug. Same trap for any other Cloud SDK script added here.

From BAS, fetch it directly instead — `--insecure` if the gateway certificate is
self-signed:

```bash
npm run import:bp -- --url https://<host>:44301/sap/opu/odata/sap   # S4_USER / S4_PASSWORD
```

`--url` is the only route that works from BAS, and there is no `--file` route on
purpose: a browser download lands on the developer's laptop while `cds import`
runs in BAS, so it costs a file transfer before it costs anything else. (For a
document already in the workspace, `cds import <file> --as csn --into srv/external`
— `--as cds` for the value-help service — is the whole job.)

Both checked-in copies got here by hand, from Julien and Arthur respectively.
There has never been an automated path, so treat a re-import as a manual step
someone performs, not as something the app can do for itself.

`srv/metadata-drift.js` runs once at startup and reports the difference against
the live services, scoped to the entity sets the app actually reads (nine of the
65 in `API_BUSINESS_PARTNER`). A property the live service **dropped** is a
warning, because that read is already failing; one it **gained** is an info,
because the copy is only behind. It is best-effort by construction — an
unreachable S/4 logs at debug and never delays or fails startup — so treat a
silent log as "no destination here", not as "in step".

### Change request staging (approve-then-create)

The whole point of the staging layer: **nothing reaches S/4 until it is
approved.** Before it existed, `saveBusinessPartner` wrote the BP to S/4
immediately and started the workflow afterwards, so the approver was reviewing
something already live. Do not reintroduce that order.

The flow, with create as the example:

1. User fills the create form. **Preview was removed 2026-08-13** — it was a step
   between wanting a partner and asking for one, and the validation it gated on
   runs on submit anyway. Check, Save Request and Submit Request are all live on
   the empty form.
2. **Submit Request** writes everything to the staging tables (and **Save
   Request** stores a draft without starting anything).
3. The SPA workflow starts and the task lands in the approver inbox.
4. The approver opens the same Maintain BP screen in approve mode, data read
   back from staging, with Approve / Reject in place of save/submit.
5. On approve, CAP posts to `API_BUSINESS_PARTNER` — the SPA never writes to
   S/4 itself.

### The check pipeline — `srv/checks/pipeline.js`

**validate → derive → duplicate check**, and the order is the design. Data that
fails validation cannot be a duplicate of anything, so a blocking validation
stops the rest. Data that is merely incomplete may be missing the very fields a
duplicate rule needs, so derivation runs *before* the duplicate check.

Stages run over the **request payload** (`{ root, sections }`), not a flattened
candidate, because a derivation has to be able to say "the street of the first
address" and the screen has to write it back to that field.

`VALIDATIONS` and `DERIVATIONS` are the default registries and are empty; the
stages actually in use are built per request by
`srv/checks/registry-checks.js` — **VIES and GLEIF**, as one validation and one
derivation sharing a single lookup (VIES throttles per member state).

- **Validation**: a VAT number VIES does not know blocks; a name that disagrees
  with the register blocks (`NAME_MISMATCH_SEVERITY`, one line to soften to a
  warning — `registry.js` treats a legal/trading-name difference as legitimate,
  so this may prove too strict on real data).
- **Never block on an outage.** `registry.js` uses check name `vat_registered`
  for *both* "not registered" (error) and "could not confirm" (info, because VIES
  answers `isValid: false` when merely throttled). Re-grade by severity, not by
  check name — `severityOf` exists for exactly this.
- **Derivation**: fills empty address fields on the *first* address row from VIES
  first, then GLEIF. A row that does not exist is never invented, but the value is
  still reported with no `field`, so the screen says so and writes nothing.

Three behaviours worth not "simplifying" away: a validation that throws blocks
(a rule that silently skipped would defeat the ordering); a derivation that
throws only reports (an improvement, not a gate); and a duplicate check that
could not run is reported rather than folded into an empty result, because "no
duplicates found" from a check that never ran is the one wrong answer here.

The **Check** button (`checkRequest`) runs the pipeline over the payload on
screen and **stages nothing** — pressing it can never leave a row behind. Submit
runs the duplicate check regardless, so Check is a convenience, never a gate.

`db/staging.cds` holds `ChangeRequests` plus one `Staged*` node per section of
the object page, mirroring the MDG node structure, plus `CheckFindings`.
`srv/change-request-service.cds` exposes `ChangeRequests`/`CheckFindings` as
`@readonly` and does every write through actions (`saveRequest`,
`submitRequest`, `getRequestPayload`, `decideRequest`) so a status can never be
forged from the client. `srv/change-request-service.js` never talks to S/4
directly — posting is delegated to `BusinessPartnerService`, which already owns
the connection, payload sanitizing and maintenance config.

Every child node carries an explicit `request` backlink, so **the to-one
compositions (`general`, `customer`, `supplier`) need an `ON` condition too**.
Without it CAP puts a foreign key on the header instead of using the backlink,
which both duplicates the link and creates a schema that later fails to migrate.

A partner with an in-flight change request is hidden from the Business Partner
list, so two people cannot edit it at once (`applyChangeRequestExclusion` in
`srv/business-partner-service.js`). `ACTIVE_REQUEST_STATUSES` decides what
counts as in-flight; `failed` is in that list on purpose, because a failed post
is not atomic and may have left the partner half-written. The exclusion is a
filter on the remote query, not post-filtering, so `$top`/`$skip`/`$count` stay
correct — but it is capped at `MAX_EXCLUDED_PARTNERS` to keep the OData URL
sane, and logs a warning rather than silently under-hiding.

Change requests have their own list (`ext/view/ChangeRequestList.view.xml`),
reached from the Change Requests button on the list report. A `draft` opens
editable via the `ChangeRequestEdit` route; anything further along opens
read-only in the approve view.

Still open — ask before implementing any of them: staging retention after
posting (deleting the header would destroy the `postedBP` idempotency guard
against SPA retries), routing edit/change requests through staging (only create
is redirected today), populating `sourceETag` (never set, so a request approved
days later overwrites concurrent S/4 changes), and reading number ranges so
users can key their own BP number when the grouping is externally numbered.

### `srv/business-partner-service.js` — everything is one file, by design
`BusinessPartnerService` (extends `cds.ApplicationService`) wires all handlers
in `init()`, but the bulk of the file is pure helper functions above the class
(query building, payload sanitization, string/name matching, JSON parsing).
**All of it is exported** via `BusinessPartnerService._internals` specifically
so `test/*.test.js` can unit-test these functions directly without spinning up
a CAP server — when adding a new helper that has non-trivial logic, add it to
`_internals` and give it a test.

Key handler groups in `init()`:
- **CRUD passthrough** — `createBusinessPartner` / `updateBusinessPartner`
  actions translate to `cds.ql` INSERT/UPDATE against the remote
  `API_BUSINESS_PARTNER` service (`s4 = cds.connect.to('API_BUSINESS_PARTNER')`),
  not against a local entity.
- **Full-screen maintenance** — `saveBusinessPartnerEntity` /
  `deleteBusinessPartnerEntity` are generic, driven by the `MAINTENANCE_ENTITIES`
  config map (per-entity remote name, navigation property, whether create/delete
  is allowed, required fields). This is what backs the full-screen create/edit
  flow for addresses, roles, tax numbers, bank details, identifications,
  industries, customer/supplier data — adding a new maintainable child entity
  means adding one entry to `MAINTENANCE_ENTITIES`, not new handler code.
- **Search** — `applyBusinessPartnerSearch` rewrites Fiori's OData `$search`
  into an `or`-chain of `contains()` filters over `SEARCHABLE_FIELDS`, because
  the remote OData V2 service has no native free-text search.
- **Business Partner Assistant** — `askBusinessPartnerAssistant` is a
  read-only, grounded Q&A action. It is intentionally *not* a general LLM
  passthrough: `answerBusinessPartnerQuestion` and friends do local matching
  against already-fetched partners/addresses (dedicated stop-word lists for
  English and Dutch), and only fall through to SAP AI Core
  (`srv/ai/business-partner-assistant.js`) when local matching is insufficient.
  Only a bounded, explicit field allowlist (`ASSISTANT_FIELDS`,
  `ASSISTANT_ADDRESS_FIELDS`) is ever sent off-box — bank and tax data must
  never be added to that allowlist.
- **Approval workflow** — creating a Business Partner (`createBusinessPartner`
  and `saveBusinessPartner`) also calls `startWorkflow` from `srv/wf/processAutomation.js`
  to kick off an SAP Build Process Automation approval workflow. This is
  best-effort: a workflow-start failure does not fail the create — it returns
  the created partner and surfaces a warning via `req.info(500, ...)`.
  `saveBusinessPartner` currently has most of its own body commented out (only
  the workflow-trigger side effect is active) — treat it as mid-refactor rather
  than a template to copy.

### `srv/wf/processAutomation.js` — BPA integration
Talks to SAP Build Process Automation through the `SBPA_DESTINATION` CDS
requires entry (a `rest`-kind destination, see `package.json`). Gets an OAuth2
client-credentials token from the `mdmlight-bpa-uaa` user-provided service
(cached until near expiry) and an API key from the same service, then POSTs a
workflow-instance start to BPA's REST API with the `irpa-api-key` and bearer
token headers. `mdmlight-bpa-key` / `mdmlight-bpa-uaa` are Cloud Foundry
user-provided services, bound in `mta.yaml` and expected in `VCAP_SERVICES`
locally when hybrid-testing this path.

**Known bug, not yet fixed:** `srv/wf/processAutomation.js` reads `apiKey` from
`mdmlight-bpa-uaa`, but that service holds `clientid`/`clientsecret`/`url`.
`mdmlight-bpa-key` is bound in `mta.yaml` and never read, so the `irpa-api-key`
header goes out `undefined` and the workflow start fails. Because
`submitRequest` deliberately leaves a request in `draft` when the workflow will
not start, the symptom is staging rows appearing with status `draft` and no
approver task — that is the guard working, not a second bug. Confirm with
Arthur which service actually holds the key before changing it.

#### Multiple approvers: decide and post are separate

SPA owns approval routing entirely — how many approvers a request needs, and
which criteria pick them. CAP deliberately knows none of that:

- `decideRequest` records an outcome and **never writes to S/4**. `approve`
  moves the request to `approved`, meaning every approval SPA wanted is in.
  `reject` is terminal.
- `completeRequest` is the "post it now" signal and the only thing that writes
  to S/4. SPA calls it after its chain finishes.

So `approved` means *waiting to be posted*, not finished. Only `posted` and
`rejected` are terminal. Individual approvals are not stored anywhere in CAP,
by decision — the UI cannot show "2 of 3 approved" without a new table.

Open TODOs on this, agreed and deliberately deferred:

- **`completeRequest` has no scope restriction.** It writes to S/4, so as it
  stands any authenticated user can force a post and bypass approval entirely.
  Restrict it to the SPA technical user before this goes anywhere real.
- **Arthur's workflow still calls only `decideRequest`** and expects the partner
  to exist afterwards. Until his process adds a `completeRequest` call, approved
  requests will sit at `approved` and never post. Coordinate before merging.

#### Contract the SPA side depends on

Changing any of these breaks Arthur's process definition, so agree the change
first rather than "fixing" it locally:

- Approver task URL: `<app-url>#/ChangeRequests/{changeRequestId}/approve`
- Workflow context sent at submit:
  `{ changerequestid, requesttype, businesspartner, emailadressinitiator }`
- Decision callback: `POST /service/changerequest/decideRequest` with
  `{ ChangeRequest, Decision: 'approve'|'reject', Comment }`
- Post trigger, once every approval is in:
  `POST /service/changerequest/completeRequest` with `{ ChangeRequest }`
- Workflow definition ID:
  `eu10.alluvion-dev-cf.mdmlightapproval.mDM_LIGHT_APPROVAL_WF`
- `businesspartnerinput` is **gone** from the create path — the approve view
  fetches from staging instead.

The SPA calls `decideRequest` on the CAP app directly, not through the
approuter. The browser does go through the approuter, so any new CAP service
path also needs a route in `app/businesspartner/xs-app.json` — the catch-all
sends anything unmatched to the HTML5 repo, where it 404s instead of erroring
usefully.

### `srv/ai/` — SAP AI Core orchestration
`business-partner-assistant.js` calls the Generative AI Hub via
`@sap-ai-sdk/orchestration`, bound through the `extended`-plan AI Core service
`mdm-businesspartner-aicore` (created/bound automatically by the MTA). Model
and fallback chain are set via `AICORE_MODEL` / `AICORE_FALLBACK_MODELS` /
`AICORE_RESOURCE_GROUP` on the `mdm-businesspartner-srv` module in `mta.yaml`
(currently `anthropic--claude-4.5-haiku` with fallbacks `gemini-3.5-flash`,
`gpt-5-mini`). The primary is deliberately **not** a reasoning model: the
assistant summarizes a pre-filtered context and gains nothing from reasoning,
while `gpt-5` as primary was slower and could spend its whole budget on hidden
reasoning. `gpt-5`/`o*` models take `max_completion_tokens` instead of
`max_tokens`, and an undersized budget then returns empty content instead of
erroring (`isReasoningModel` / `modelParams` handle this distinction; keep it
if you promote a reasoning model back to primary).

`ASSISTANT_INTENT_SOURCE: model` in `mta.yaml` switches intent parsing from the
regex heuristics to `srv/ai/intent.js`. This is what makes "maak BP X aan"
reliably yield a `companyName`, which is what triggers the duplicate check —
the check itself is unconditional on intent. The regex parser stays as the
fallback whenever `parseIntent` returns null.
`company-research.js` provides a separate lookup used to suggest company data
and flag potential duplicates before creating a new Business Partner
(`findPotentialDuplicates` uses Dice-coefficient name similarity, not exact
match).

### UI (`app/businesspartner`) — Fiori Elements, extended
This is a separate npm project (own `package.json`, own `node_modules`) driven
by `@sap/ux-ui5-tooling`/`@ui5/cli`, not by the root CAP project. It is a
standard List Report / Object Page Fiori Elements app
(`webapp/manifest.json`) with custom extensions layered on top rather than a
hand-rolled UI5 app:
- `webapp/ext/controller/BusinessPartnerMaintenance.controller.js` and
  `ListReportExtension.controller.js` — controller extensions for the
  full-screen create/edit flow and list-report behavior.
- `webapp/ext/BusinessPartnerAssistant.js` / `CustomActions.js` — the chatbot
  panel and custom toolbar actions, calling the `askBusinessPartnerAssistant`
  and `saveBusinessPartner*` actions on the CAP service.
- `webapp/ext/BusinessPartnerMetadata.js` plus
  `scripts/generate-maintenance-metadata.js` — generates the metadata driving
  the full-screen maintenance UI; re-run `npm run generate:metadata` (also
  part of `build`/`build:cf`) after changing `MAINTENANCE_ENTITIES` on the
  service side or the maintained entities won't line up.
- `ui5.yaml` (real backend) vs `ui5-mock.yaml` (local mock data) are separate
  UI5 tooling configs — pick the matching npm script (`start` vs
  `start-mock`) rather than editing one to behave like the other.

### No approuter module — managed approuter via Work Zone

**The standalone approuter was removed 2026-08-13.** The app is served by the
**managed** approuter through SAP Build Work Zone, standard edition.

`app/businesspartner/xs-app.json` is the routing config, and it is the only one:
`build:cf` copies it into `dist/` so it ships to the HTML5 repo alongside the
app, and the managed approuter applies it. That is why every `/service/*` route
lives there and why a new CAP service path still needs an entry in that file —
the mechanism did not change, only who reads it.

Why it changed: the BAS Workflow UI generator (`@bas-dev/routing-config`)
crashes on a project that declares both a standalone `approuter.nodejs` module
and the managed-approuter markers, and SAP's own guide requires
**Managed Approuter** for the workflow UI template. The MTA was scaffolded for
managed all along — `deploy_mode: html5-repo`, the app-host/app-runtime
resources, destination content carrying `sap.cloud.service`, `manifest.json`
declaring the same service with `public: true`, and `HTML5Runtime_enabled: true`
on the destination service. The standalone module was the outlier.

Consequences to know:

- **The dev-space mapped route is gone.** Access is the Work Zone site URL.
- `mdm-businesspartner-repo-runtime` is no longer required by any module. It is
  kept deliberately — the managed runtime serves the app out of the repo.
- If login loops or fails after adding the app to a site, check the XSUAA
  `redirect-uris` in `mta.yaml`: `https://*.${default-domain}/**` may not cover
  the Work Zone launchpad host, which sits on a different subdomain.

### MTA / deployment (`mta.yaml`)
Four modules: CAP service (`mdm-businesspartner-srv`),
HTML5 app-content deployer, destination-content, plus the resources they bind
to (XSUAA, HTML5 apps repo host/runtime, destination service, connectivity,
AI Core `extended`, and the existing BPA user-provided services). The CAP
service module path is `gen/srv` (the `cds build` output), not `srv/` — always
rebuild before assuming `mta.yaml`/`mbt build` picks up service-code changes.

Bump the `version` in `mta.yaml` for every deploy. Several different artifacts
have shipped as `1.13.2`, which makes the deploy log useless for working out
whose build is actually running.

### The PostgreSQL deployer will block on any dropped column

`mdm-businesspartner-db-deployer` runs `cds-deploy` as a one-off task and
evolves the schema against a copy of the previously deployed model that CAP
stores **in the database** (table `cds_model`). CAP refuses to drop elements
during schema evolution, so any model change that removes a column fails the
task with:

```
Error: Dropping elements is not supported (in entity:"..."/element:"...")
```

It fails identically on all retries because it is a compile-time error — the
deployer never reaches the database. `--auto-undeploy` is HDI-only and does
nothing here. While staging holds nothing worth keeping, the fix is to wipe and
redeploy; once it holds real change requests, write a migration instead.

`tools/wipe-staging.js` does the wipe. It lists what it would drop and stops
unless given `--yes`. Note two BTP-specific constraints it already handles: the
bound role does **not** own schema `public` (so `DROP SCHEMA` is refused — it
drops objects individually), and `public` also contains extension objects owned
by someone else (so it filters on `pg_get_userbyid(c.relowner) = current_user`).

The endpoint is private — nothing connects from a laptop or from BAS, and the
BAS Database Explorer only ever lists HANA instances. Two ways in:

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

Pass the payload through an env var as above rather than inlining it in
`--command`; long single-token commands get line-wrapped in transit and the
container's bash then executes the fragments as separate commands.

For simply reading staged data, prefer the OData service over SQL —
`ChangeRequests` is exposed read-only and expands to every node:

```
<srv-url>/service/changerequest/ChangeRequests?$expand=general,addresses,roles,findings
```

Note that `cds build` also materialises all 65 imported `API_BUSINESS_PARTNER`
entity sets as physical tables and views, despite nothing ever reading them.
They are empty noise in the schema, not state — do not "fix" bugs by looking at
them.

## Configuration notes

- `.cdsrc.json` — checked in, sets CAP build target (`gen`) and requires
  `xsuaa` auth in production.
- `.cdsrc-private.json` — gitignored, holds hybrid-profile service bindings
  (destinations, connectivity, AI Core, BPA) tied to a specific CF
  org/space; regenerate locally with `cds bind` rather than hand-editing paths
  from another environment.
- Local secrets (`.env`, `default-env.json`, `credentials.json`) are
  gitignored — never commit S/4 or BPA credentials into `mta.yaml`,
  `.cdsrc-private.json`, or source files.

## Working alongside the other developers

Several people push to `main` in the same CF space, so a failure is often
someone else's build rather than your code.

**Before assuming a deploy failure is a bug, check what you are deploying.** MTA
deploys take a per-MTA-ID, per-space lock; a second `cf deploy` while one is in
flight aborts with a conflicting-process error that reads like a broken
deployment. If a colleague reverted something, their build and yours are
different apps even at the same version number.

**Do not revert the staging feature to unblock a deploy.** It has been reverted
once already (`dec9278`, restored by `0a0daaa`) when the real cause was
elsewhere, and reverting has a trap: once a commit is reverted on `main`, git
considers it merged, so re-merging the feature branch brings back *nothing*. The
feature only returns if the revert is itself reverted. If a deploy is blocked,
diagnose it — the deployer failures seen so far were a corrupt lockfile and a
dropped column, neither of which had anything to do with the feature.

**Watch merges of long-lived branches.** The `Adding-WF` merge (`32b92c7`)
auto-merged by concatenating both sides rather than conflicting: it produced a
`package-lock.json` containing two complete lockfile documents (~10k lines,
`"lockfileVersion"` twice) and a test file with two adjacent tests joined
without the closing `});`. Both looked like unrelated bugs. After merging a
branch that has drifted, sanity-check `package-lock.json` and run `npm test`
before concluding anything about a deploy failure.
