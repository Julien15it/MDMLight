# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CAP (Node.js) + SAP Fiori Elements (OData V4) recreation of the standard SAP app
`mdm.md.businesspartner.manage` (F3163). There is **no local business-partner
database** — the CAP service is a live facade that delegates every request to an
S/4HANA system's OData V2 `API_BUSINESS_PARTNER` service through the BTP
destination `VF_S4HANA_DEST`. Deletion of Business Partners is deliberately
disabled throughout the facade.

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

### `srv/ai/` — SAP AI Core orchestration
`business-partner-assistant.js` calls the Generative AI Hub via
`@sap-ai-sdk/orchestration`, bound through the `extended`-plan AI Core service
`mdm-businesspartner-aicore` (created/bound automatically by the MTA). Model
and fallback chain are set via `AICORE_MODEL` / `AICORE_FALLBACK_MODELS` /
`AICORE_RESOURCE_GROUP` on the `mdm-businesspartner-srv` module in `mta.yaml`
(currently `gpt-5` with fallbacks `gpt-5-mini`, `anthropic--claude-4.5-haiku`).
`gpt-5`/`o*` models are reasoning models — they take `max_completion_tokens`
instead of `max_tokens`, and an undersized budget silently returns empty
content instead of erroring (`isReasoningModel` / `modelParams` handle this
distinction; keep it if you add another reasoning-family model).
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

### `app/router` — standalone approuter
Minimal `@sap/approuter` module (`xs-app.json` routing) deployed as its own
MTA module; not a place for application logic.

### MTA / deployment (`mta.yaml`)
Five modules: CAP service (`mdm-businesspartner-srv`), standalone approuter,
HTML5 app-content deployer, destination-content, plus the resources they bind
to (XSUAA, HTML5 apps repo host/runtime, destination service, connectivity,
AI Core `extended`, and the existing BPA user-provided services). The CAP
service module path is `gen/srv` (the `cds build` output), not `srv/` — always
rebuild before assuming `mta.yaml`/`mbt build` picks up service-code changes.

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
