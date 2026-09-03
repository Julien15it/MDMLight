# Architecture — facade, imported models, S/4 side

<!-- paths: srv/**, srv/external/**, abap/**, app/businesspartner/** -->

## Facade, not a data model

`srv/business-partner-service.cds` projects the imported `API_BUSINESS_PARTNER` model
(`srv/external/*.{csn,edmx}`, all 65 entity sets). Almost everything is `@readonly`; only
`BusinessPartners` and the maintenance actions write. Two exclusion lists (`A_Customer excluding
{...}`, `A_Supplier excluding {...}`) work around fields the on-premise release does not expose — a
section read failing with "Resource not found for the segment" usually means a field needs to move
into an exclude, not that there is a bug.

**Excluding a field in the CDS must reach the create screen too.**
`app/businesspartner/scripts/generate-maintenance-metadata.js` compiles the service CDS and diffs each
section's projected elements against the raw CSN. A CDS-excluded field still named in a `fieldGroups`
block fails the build. Re-run `npm run generate:metadata` after changing any `excluding {}` clause
(`build`/`build:cf` already chain it).

## The imported models are copies and go stale silently

Both remote services are compiled from `srv/external`; nothing reads `$metadata` at runtime and
nothing can (`as projection on` is compiler-resolved, `mbt build` is offline).

- Import scripts resolve destinations from `VCAP_SERVICES` and **only work in Cloud Foundry**. From BAS:
  `npm run import:bp -- --url https://<host>:44301/sap/opu/odata/sap` (`S4_USER`/`S4_PASSWORD`,
  `--insecure` for a self-signed gateway). No `--file` route, on purpose. For a document already in the
  workspace: `npx cds import <file>.edmx --as cds --force --no-save` — **not `--into`**, cds-dk 8 does
  not know that flag and lands the result in `srv/external` itself.
- Both checked-in copies got here by hand. Treat a re-import as a manual step a person performs.
- **The five `Der*` entities in `ZSRVB_MDMLIGHT_VH` were hand-added** to both the `.cds` and the
  minified single-line `.edmx`. The `checksum` comment is stale and nothing verifies it. No
  `Annotations` block, matching the served metadata. A real `cds import` supersedes all of it.
- `srv/metadata-drift.js` runs once at startup over the nine entity sets actually read. A **dropped**
  property is a warning, a **gained** one info. Read it against the `excluding {}` lists — a named
  field already excluded is noise, one that is not is a broken section. Silence means "no destination
  here", not "in step".

## `abap/` — the two S/4-side services

`abap/valuehelp/README.md` and `abap/customerfields/README.md` carry the ADT steps, the released views
behind each value help, and known drift. Read one before touching a `@Common.ValueList`.

`abap/customerfields` (`ZMDML_CUST_ENTITY` / `ZSRVB_MDMLIGHT_CUST`) is **designed but not wired in** —
not in `cds.requires`, no `srv/external` copy, nothing projects it. It exposes `I_Customer` to close
the gap between `A_Customer`'s 53 fields and the MDG ERP Customer screen. Build it when one of those
fields is actually asked for.

`mdmlbpcheck/README.md` holds the ABAP write-ups: the `ZMDML_BPCHECK` mapper, the nine SPRO derivations
SAP fills in and this app does not, and the probe rounds that established the mechanism.

## `srv/business-partner-service.js` — one file, by design

Handlers are wired in `init()`; the bulk of the file is pure helpers above the class. **All of it is
exported** via `BusinessPartnerService._internals` so tests can run them without a CAP server — add a
new non-trivial helper to `_internals` and give it a test.

- **CRUD passthrough** — `createBusinessPartner`/`updateBusinessPartner` translate to `cds.ql`
  INSERT/UPDATE against the remote service, not a local entity.
- **Full-screen maintenance** — `saveBusinessPartnerEntity`/`deleteBusinessPartnerEntity` are generic,
  driven by `MAINTENANCE_ENTITIES` (remote name, navigation property, create/delete allowed, required
  fields). A new maintainable child entity is one entry, not new handler code.
  **`Customers`/`Suppliers` are `deletable: false` here permanently** — S/4 has no DELETE verb for a
  customer/vendor master (retirement is `DeletionIndicator`) and rejects with 405. **Do not flip this to
  fix a delete-button complaint**: it is unrelated to the generated metadata's own `deletable`, which
  only decides whether the staged screen draws a Delete button. Those are `true`, and safe, because
  `writeStagedNodes`' `!config.many` branch has no `deleted[section]` handling at all.
- **Search** — `applyBusinessPartnerSearch` rewrites Fiori's `$search` into an `or`-chain of
  `contains()` over `SEARCHABLE_FIELDS`; the remote V2 service has no native free-text search.
- **Assistant** — `askBusinessPartnerAssistant` is read-only and grounded, **not** a general LLM
  passthrough. Only the bounded allowlists `ASSISTANT_FIELDS`/`ASSISTANT_ADDRESS_FIELDS` are ever sent
  off-box — **bank and tax data must never be added to them.**
- `saveBusinessPartner` has most of its body commented out (only the workflow side effect is active) —
  mid-refactor, not a template.

**Paging:** `readAllPages` stops on a short page because the caller sets the page size. That is the
opposite of `srv/checks/config-reader.js` — see `checks.md` before copying either.

## UI (`app/businesspartner`) — Fiori Elements, extended

A separate npm project driven by `@sap/ux-ui5-tooling`/`@ui5/cli`, not by the root CAP project.

- The **maintenance screen is not here** (see `maintenance-screen.md`).
  `scripts/generate-maintenance-metadata.js` still lives here but writes into `app/reuse`.
- `webapp/ext/controller/ListReportExtension.controller.js` — list-report behaviour.
- `webapp/ext/CustomActions.js` — toolbar actions.
- `ui5.yaml` (real backend) vs `ui5-mock.yaml` (mock data) are separate configs — pick the matching npm
  script rather than editing one to behave like the other.
