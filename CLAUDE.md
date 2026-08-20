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
```

UI (`app/mdmrules`, the MDM Rules tile — again a separate npm project):
```bash
cd app/mdmrules
npm install
npm run build:cf         # ui5 build preload for Cloud Foundry
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
stages actually in use are built per request from two places and concatenated in
`runRequestChecks`:

- `srv/checks/rule-store.js` — the **steward-configured** validation and
  derivation tables, deterministic and offline. See "The validation and derivation
  tables" below.
- `srv/checks/registry-checks.js` — **VIES and GLEIF**, as one validation and one
  derivation sharing a single lookup (VIES throttles per member state).

Configured stages come first in both lists; the reasoning is with the tables.

- **Validation**: a VAT number VIES does not know blocks. A name or an address
  that disagrees with the register only **warns** — VIES returns the legal name
  and partners are often stored under a trading one, and blocking stopped the
  derivations and the normalisation proposals as well. `NAME_MISMATCH_SEVERITY`
  is the one-line knob back to `'error'`.
- **VIES never proposes.** It validates and it fills gaps; rewriting a value the
  requester typed is the model's job (`srv/checks/normalise.js`). A register value
  that differs from a filled-in one is reported as a warning naming both, never
  offered as a change.
- **Never block on an outage.** `registry.js` uses check name `vat_registered`
  for *both* "not registered" (error) and "could not confirm" (info, because VIES
  answers `isValid: false` when merely throttled). Re-grade by severity, not by
  check name — `severityOf` exists for exactly this.
- **Derivation**: fills empty address fields on the *first* address row from VIES
  first, then GLEIF.

#### A derivation may create the row it needs (changed 2026-08-20)

A derivation used to refuse to invent a row: with no address on the screen, a VIES
answer was reported with no `field` ("there is no Addresses row to hold it") and
written nowhere — so the requester had to press **Add** before the register could
fill anything, which is precisely the case where the lookup is most useful.

**Built twice, on the same afternoon, and merged into one.** Maarten and Julien both
implemented it within four minutes of each other (`b50a8a1` and `6a45554`). The
merged design takes the trigger, the scope and the registry path from the first and
the idempotency and the stage ordering from the second — Maarten's call.

- **The payload is the trigger, not a flag on the rule.** A rule whose target section
  holds no rows proposes the row; one whose section has rows fills its gaps. There is
  no `createsRow` column and no "Add row" checkbox: conditions met are enough, and a
  steward should not have to tick a second box to get the obvious behaviour. The
  `createsRow` **column stays in `db/quality-rules.cds` as dead weight**: dropping it
  failed `deploy_to_postgresql` four times over, because Julien's build had already
  reached the deployed model. Nothing reads it, the same way nothing reads the four
  `cond*` columns on `DuplicateRules`. (Julien's
  version made it opt-in per rule, with save-time refusals guarding the checkbox;
  those refusals went with it — a condition on the section being added is evaluated
  against an empty row and cannot hold, and a value copied out of that section
  resolves to nothing, so both simply do not fire.)
- **Only an EMPTY section, and only its first row.** A section the requester has
  already put a row in is theirs: the rule falls back to filling gaps and never
  appends beside it. This is narrower than Julien's version, which appended — so
  "role FLVN01 in BE means purchasing organisation 1710" fires on a partner with no
  purchasing org, but will not add a *second* one.
- **Two stages, adders before fillers.** Every rule in one stage sees the same payload
  — the pipeline applies a stage's entries only after it returns — so a filler sharing
  a stage with the rule that adds its row would fill nothing. Both stages run every
  rule and `mode` (`'create'` / `'fill'`) decides what each may emit, because which
  rule adds and which fills is not known until the payload is in hand. `sequence`
  therefore orders rules *within* each kind, not across them.
- **Idempotent.** A section already holding a row with that value is left alone, and
  `_applyProposals` refuses to add a second row carrying the value it is accepting —
  so pressing Check twice adds one row, and a row the requester added by hand is kept.
- **The requester still ticks it.** The row is created in the pipeline's own copy
  (which is what the duplicate check reads) and on the screen only when the proposal
  is accepted — with `__state: "new"`, so it stages as a `C` rather than an update to
  a row S/4 does not have. The dialog says **Row added** rather than *Filled in*.
- **The registry creates the first address too** (`registry-checks.js`): VIES/GLEIF
  set `createsRow` when there is no address row at all, which is the case that started
  this. Only the first of the four address entries carries the flag — the pipeline
  fills the rest into the row it just made.

Three behaviours worth not "simplifying" away: a validation that throws blocks
(a rule that silently skipped would defeat the ordering); a derivation that
throws only reports (an improvement, not a gate); and a duplicate check that
could not run is reported rather than folded into an empty result, because "no
duplicates found" from a check that never ran is the one wrong answer here.

### Normalisation — `srv/checks/normalise.js`

AI Core proposes reformatting of **stored** data: casing, legal forms (`bvba` →
`BVBA`), whitespace, street conventions. **Proposals only — nothing is ever
applied without the requester ticking it.**

Two distinctions worth keeping straight:

- Normalising **for comparison** is already solved deterministically in
  `srv/ai/duplicate-fields.js` and is the engine's business. This is different:
  it rewrites what someone typed, which is an edit to master data.
- A **derivation** fills a gap and never overwrites. A **normalisation** only
  ever touches a field that already has a value. That is why it is its own stage
  and why it can never auto-apply.

`sanitizeProposals` checks the model's output against the fields actually sent —
a proposal for a field that was not offered, or one that changes nothing, is
dropped. Identifiers (tax numbers, IBAN, BP number) are deliberately outside
`NORMALISABLE`: formatting them is not a formatting matter.

It runs on **Check only**, and returns `[]` on any failure — an AI Core outage
must not stop a check or a submit.

#### Two buttons, two questions (changed 2026-08-17)

`checkRequest` and `duplicateCheckRequest` are separate actions over the same
pipeline, because the screen asks two different things:

- **Check** — "is this record right?": validate, derive, normalise. Returns
  derivations and normalisations and **nothing about duplicates**.
- **Duplicate Check** — "does it already exist?": validate, derive, match. The
  derivations still run, but **in memory only** — nothing derived is returned or
  shown. They run because a rule conditioned on a country nobody typed yet still
  has to fire, which is the whole reason derive precedes match in `pipeline.js`.

Both stage nothing, and `runRequestChecks` in `srv/change-request-service.js` is
the one runner they share — the stage list is what differs, never the order.

#### Automatic triggers (2026-08-17)

The buttons are no longer the only way in. `checkRequest` gained two optional
parameters and the maintenance controller fires it by itself:

- **`Propose : Boolean`** — false skips the AI Core normalisation call entirely.
  A tax number being committed wants the register, not an LLM.
- **`Scope : String(40)`** — `'root'` or a section id, narrowing
  `normalisableFields(payload, scope)` and the deterministic proposals to one
  target. Omit both and the behaviour is exactly the button's.

Two things were decided rather than assumed, and both keep earlier rules intact:

- **A trigger still only proposes.** Maarten asked for VIES to "add the Address
  automatically"; that would reverse the 2026-08-13 decision below, so it was
  raised and he chose proposal-only. A triggered check routes through the same
  `_offerProposals` dialog and `_applyProposals`, and **nothing is written to the
  form without a tick**. `test/check-triggers.test.js` pins that a trigger never
  calls `_applyProposals`.
- **Normalisation fires per scope, not per field** — one call for an address
  block, not four.

"Leaving a section" is realised **without** `ObjectPageLayout.sectionChange`,
because the `ObjectPageSection`s carry no ids to map back to a staging section.
Instead `_onFieldCommitted` tracks a pending scope and flushes it when the next
commit lands in a *different* scope, or after `TRIGGER_IDLE_MS`. Same call count,
no dependency on ObjectPage internals.

The trigger is deliberately timid, and each guard is load-bearing: it hangs off
`change`, never `attachLiveChange` (which fires per keystroke); it never opens a
`MessageBox` and never sets `state.busy`, because the requester is mid-form; it
runs one at a time and drops rather than queues; it de-duplicates on scope +
payload so re-committing an untouched field costs nothing; and a failure is a
`console.warn`, never an interruption — the buttons are what report properly. The
duplicate check is **not** trigger-driven: it is pairwise and already refuses
above a population limit.

##### Check used to derive twice (fixed 2026-08-19)

Pressing **Check** shortly after typing produced a second proposals dialog for the
same record. The guard was **one-directional**, and that was the whole bug:

- `_runTriggeredCheck` refused to start while `state.busy`, and a button press sets
  it. A trigger firing *during* a check was correctly dropped.
- Nothing stopped an already **scheduled** trigger from firing the moment the
  button released busy. Commit a field, press Check inside `TRIGGER_IDLE_MS`
  (1500ms), and: Check runs → busy goes false → the idle timer fires →
  `_flushPendingScope` → a second `checkRequest` over the same payload.

`_cancelPendingTrigger()` is the fix, called by **every button that runs a check of
its own** — Check, Duplicate Check, Save/Submit/Resubmit and Withdraw. It clears
both timers (`_idleTimer` for the pending scope, `_triggerTimer` for the debounce
after it flushes) and nulls `_pendingScope`, or the next commit in a different
scope would flush the stale one. It runs **before** the client-side validation, so
a press that fails that check has still superseded what the trigger was about to
ask.

Cancelling timers cannot help a trigger that is already **mid-flight**, and the
busy check happens before the await — so a button pressed *during* a trigger would
still have produced two dialogs. `_buttonRun` closes that half: the trigger records
which press it started under and drops its result if that changed, because an
explicit press is the answer the requester is looking at and the trigger was only
ever a convenience. It still records `_lastTriggerKey` first, so the wasted call is
not repeated by the next identical commit.

Two things not to "simplify" here. Setting `_lastTriggerKey` from the buttons
instead would **not** work: the key is `scope|propose|dataJson` and a triggered
check is scoped where a button's is not, so the keys never collide. And the cancel
belongs on all the buttons, not just Check — Duplicate Check asks the same question
of the same record, and the submit paths move the request past the point a trigger
reports on.

**Derivations no longer auto-apply.** They used to be written straight into the
form on Check, which made them easy to miss and impossible to decline. They are
proposals now, and they share the normalisation dialog: one list, a `change`
column saying `Filled in` or `Reformatted`, everything ticked by default.
Consequences worth keeping:

- A field a derivation filled and the model then reformatted is **one row, not
  two** (`_proposalRows`), and the normalised value wins — applying both would
  write the same field twice.
- The proposed value is an **editable input**. A model that spells "st" out as
  "Straat" where the requester meant "Sint" is right that the abbreviation needs
  resolving and wrong about how; `_applyProposals` reads back from the model, so
  what was typed is what lands. Clearing the field is a decline, not an
  instruction to blank what is there.
- A derivation carrying **no `field`** is a statement, not a value. It cannot be
  applied, so it stays a message strip.

Duplicate findings survive the dialog in a collapsed, self-scrolling `Panel`
(`_setDuplicatePanel`) — dismissing the MessageBox used to destroy the only copy
of the list, so looking a candidate up meant pressing the button again.

**Only a match ever changes that panel**, and only Duplicate Check and Submit
match. Check does not touch it, and neither does applying a proposal: the
findings stand until something re-matches and replaces them. A check that **did
not run** leaves them standing too. Every one of these is the same rule — a
screen that looks clean must never be clean on the strength of a check nobody
ran, which is the wrong answer `pipeline.js` refuses to give server-side.

**Submit runs the validations and the duplicate check, but never the
derivations** (decided 2026-08-13). A derivation changes the data and the
requester has to have seen what they are asking for, so Check is where they are
proposed; more triggers get decided on their own merits when there is a
derivation framework. Since Check only proposes now, **no derived value reaches
a request without the requester having ticked it.** A blocking validation on submit leaves the request a
`draft` and reports at the top of the screen — a list of things to fix in the
form, not a decision to take, which is why it is strips and not a dialog.

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
reached from the Change Requests button on the list report. **The button is
steward-only** (`{perm>/isDataSteward}`), and since the rules moved to their own
tile it is the last steward-gated action on the list report.

### The MDM Rules tile — its own app (`app/mdmrules`, 2026-08-17)

Rule configuration left the Maintain BP app's toolbar and became its own tile.
`app/mdmrules/webapp/ext/view/MDMRuleHub.view.xml` is the landing page: four
`GenericTile`s for **Duplicate Check Rules**, **Validation Rules**,
**Field Properties** and **Derivation Rules**.

**It is a second HTML5 app, not a second inbound.** The first attempt declared
`MDMRules-manage` alongside `BusinessPartner-manage` in one manifest and told
them apart with a `screen=rules` startup parameter. That cannot work: **SAP Build
Work Zone, standard edition exposes only the FIRST `crossNavigation.inbounds`
entry per `sap.app.id`.** Extra inbounds are dropped silently — they never reach
the Content Explorer, so no amount of refreshing the HTML5 Apps channel surfaces
them, and the deployed manifest verifiably contains an inbound that Work Zone
ignores. SAP confirmed this as not supported on a customer ticket. Do not
reintroduce a second inbound, and do not read a missing tile as a deploy problem.

A **local copy** in Content Manager can add a tile with its own parameters, and
that path was tried; it produced a tile that would not load. It is also
documented to stop reflecting later descriptor changes. Rejected for that.

So there are two apps sharing one backend:

- Unique **`sap.app.id`** (`mdm.md.mdmrules.manage`) — required, or the deploy
  collides.
- **Shared `sap.cloud.service`** (`mdm.md.businesspartner`) — deliberate. Apps in
  one MTA may share it, which is why no new destination, app-host or XSUAA entry
  was needed; `app/mdmrules/xs-app.json` reuses the existing
  `mdm-businesspartner-srv-api` destination for `/service/duplicateconfig/*` and
  `/service/businesspartner/*` (the latter only for `currentUserPermissions`).
- One `com.sap.application.content` module at `path: .` funnels **both** app zips
  into the same app-host. Two content modules pointed at one app-host would each
  replace the other's content.
- **`tools/package-html5.js` does the zipping, and that is not a style choice.**
  The first attempt used the generator's pattern — two `type: html5` modules with
  `build-result: dist`, referenced from `build-parameters.requires` by
  `<module>.zip` — on the assumption that `mbt` archives an html5 module's
  build-result for you. It does not, at least not here: `mbt build` produced
  `mdm-businesspartner-app-content/resources/data.zip` at **22 bytes**, an empty
  archive. Deploying that would have shipped empty content to the app-host and
  **deleted both apps from the HTML5 repository**. The deploy was aborted for an
  unrelated reason before it got there, which is the only reason it didn't happen.
  The script therefore refuses to emit a zip under 1KB. Verify before any deploy:
  `unzip -l mta_archives/*.mtar | grep -i zip` must show two app zips of real size.
- The hub is the app root (route pattern `""`), and `Component.js` calls
  `getRouter().initialize()` itself — there is no Fiori Elements AppComponent
  here to do it. Back from the hub is a **cross-app intent** to
  `BusinessPartner-manage`, not a route, and it no-ops where there is no shell.

**Adding the app does not create the tile.** After deploying, refresh the HTML5
Apps content provider in Channel Manager, then add the app from the **Content
Explorer** (it does not appear in Content Manager until you do), then assign it
to a group, a catalog, a role, and the role to the site.

Bump `sap.app.applicationVersion.version` on every UI deploy. It sat at `1.9.0`
across several deploys, which made `cf html5-list` useless for telling whether a
UI change had actually landed.

Validation and Derivation Rules were UI previews until 2026-08-19. **They are
real now** — see "The validation and derivation tables" below. They still copy
the duplicate rule table's layout, and each page still binds only its own entity:
binding `dc>/DuplicateRules` would show duplicate rules under a Validation Rules
heading and let someone edit them by accident.

### The validation and derivation tables (2026-08-19)

`db/quality-rules.cds` adds `ValidationRules` and `DerivationRules` alongside
`DuplicateRules`, in the same `mdmlight.config` namespace and the same BRF+
decision-table style: two optional condition pairs, then the columns that make
that kind of rule what it is. Both are exposed by **`DuplicateConfigService`**,
whose path keeps its old name (`/service/duplicateconfig`) on purpose — it is in
`app/mdmrules/xs-app.json` and in the deployed approuter config, so renaming it
would cost a route change and a redeploy to gain nothing.

Read a row left to right as one sentence:

- Validation — *where `Addresses.Country` = BE, `General.Language` must be `=` NL*
- Derivation — *where `Addresses.Country` = BE, fill `General.Language` with NL*

#### Fields are payload fields, not duplicate-catalog fields

`srv/checks/payload-fields.js` is a **second, different catalog** and the
distinction is the whole reason it exists. `srv/ai/duplicate-fields.js` describes
bags of *normalised* values for comparing two partners — `Name` is a fingerprint,
`TaxNumber` is country-padded. A rule that fills in a language or asserts a region
has to read and write the request payload (`{ root, sections }`) with its real
values, so it needs that shape's own field names.

The catalog is **generated from the staging model** (`cds.model`), never listed:
add a column to `db/staging.cds` and the value help has it. Names are qualified
and always dotted — `General.Language`, `Addresses.Country`. `PAYLOAD_NODES` is
the single source of truth for the section ids, and `NODES` in
`srv/change-request-service.js` is now derived from it, so a rule can never name
a section nothing stages.

#### The Value column means two things, and nothing else says which

A value that resolves to a qualified catalog field is a **reference** to that
field; anything else is a literal. That is what Maarten asked for on the
derivation table ("field A will be filled in with the same value as field B"), and
it needs no third column to disambiguate, because **catalog names are always
dotted and a literal never can be one**. `N.V.` is a literal; `General.Language`
is a reference. The derivation page says which one it read, under the cell
("Copied from …") — that hint is the only feedback that a reference was understood
as one, so do not drop it. Validation values work the same way, which is how
"CorrespondenceLanguage must equal Language" is written.

A same-section reference reads **the same row**: "this address's Region from this
address's Country" is about one address, not about the first one.

#### Semantics worth not "simplifying"

- **An empty field does not fail a comparison.** Validations run *before*
  derivations, so a rule that failed on an empty field would block the very
  derivation that was about to fill it. `notEmpty` is how a steward says a field
  is required, and it is the one comparison (with `empty`) that still fires on an
  empty field.
- **Condition scoping is per row on the rule's own section.** "Where
  `Addresses.Country` = BE, `Addresses.Region` is required" is about the Belgian
  address rows — not about every address of a partner that happens to have one
  Belgian address. A condition on any *other* section is a statement about the
  partner, so it holds when any row of that section matches.
- **A rule the engine cannot evaluate blocks**, the same way a validation that
  throws does. Skipping it would let a request through on the strength of a check
  that never ran.
- **Severity is a column, and was added rather than asked for.** Without it every
  validation would block, and a naming convention that stops a submit is how
  people learn to ignore findings.
- **A derivation still never overwrites and still never auto-applies.** The
  non-overwrite rule stays in `pipeline.js` so these rules and the registry's
  cannot disagree about it, and configured derivations reach the requester through
  the same proposals dialog, ticked by hand.

#### Where they run

`srv/checks/rule-store.js` holds the rows in memory (60s TTL, dropped on any
write) and `createConfiguredStages` turns them into **one stage per kind** — not
one per rule, because the pipeline blocks on the first error a validation stage
reports and a table of twenty rules has to report all twenty problems.

`runRequestChecks` puts them **before** the registry stages in both lists:
validations because these are offline and a request that fails one should not cost
a VIES call; derivations because the pipeline never overwrites, so the stage that
fills a field first wins, and an explicitly configured rule is a decision somebody
made about that field where the registry is a lookup that happens to have one.
Submit runs the configured validations and, as before, **no derivations**.

Two failure modes are deliberate:

- **An empty table contributes nothing, and does not fall back to defaults.** The
  duplicate check falls back because an empty table would switch the control off;
  there are no default validations, and inventing a rule nobody configured would
  be worse than running none.
- **An unreadable table reports itself.** A read failure with nothing cached
  produces a stage that says so, rather than passing as "nothing to report" — the
  same discipline the pipeline applies to a duplicate check that could not run.

#### The field picker is a dialog, not a ComboBox

`ext/fragment/FieldValueHelp.fragment.xml`, shared by both pages and used by every
cell that can name a field. The catalog is the whole staging model — several
hundred fields — and `sap.m.ComboBox` filters on the **start** of an item's text,
so finding a Country would have meant knowing it lives on Address and typing that
first. The dialog searches with `contains` over the qualified code as well as the
label, and the **qualified code is what is stored**: a label reworded later must
not turn a saved rule into one that no longer resolves.

**Reset the filter when the dialog opens, never when it closes, and read the
selection off its binding context.** The first version cleared the filter in the
confirm handler and then asked the selected item *control* for its value, which
wrote the wrong field: resetting a JSONModel list binding re-templates the rows,
so the item instance gets re-bound to whatever now sits at its old position.
Searching "Country" left one match at position 0, and position 0 of the unfiltered
catalog is a General name field — so that is what landed, reproducibly, and
differently depending on what had been searched for.

#### No standing banners on the rule pages

Asked for 2026-08-19. The strips that remain on all three pages are `Warning` and
conditionally bound, so a page carries a message only when something is actually
wrong with it — rules that are saved but not running, or a duplicate table that has
fallen back to the defaults. Explaining what a derivation *is* belongs here, not in
a strip above the table; the per-cell "Copied from" hint stays, because it reports
what the page actually read rather than restating the concept.

Still open on these tables, and not built:

- **A "Test Against Current Data" button — on Validation Rules only** (scoped
  2026-08-19). The duplicate page has one because a duplicate rule's effect is
  invisible until you run it against the population. A validation is worth the same
  treatment: a steward wants to know how many existing partners a new rule would
  have blocked before switching it on. A derivation does **not** need it — it fills
  empty fields on the request in front of you, and there is no population-wide
  verdict to preview.
- A custom message per validation row; a generated one is what ships.
- Rules for object types other than the Business Partner. When MM arrives, **copy
  the tables** rather than adding an object-type column.

### Field property profiles (2026-08-20)

`db/field-properties.cds` adds `FieldPropertyProfiles` and its
`FieldPropertySettings`, exposed by the same `DuplicateConfigService`. A profile
says what a request may, must and must not show: **mandatory, read-only, hidden or
optional**, per entity and per field.

A profile is **conditions plus content**, and they are maintained separately
because they are different sizes. The conditions are two dropdowns on the profile
row — **CR type** and **role** — and both take `*` for "all", which is how a global
profile is written. The content is several hundred fields, so it lives behind
**Modify**: a dialog listing every entity, each opening up with its arrow to the
fields underneath it, four checkboxes on both levels. Setting a property on the
entity row is what lets a steward hide or require a whole section without naming
every field in it.

Decisions worth keeping:

- **One state per target, not four flags.** The boxes are drawn as checkboxes
  because that is what was asked for, but they behave as a radio group: ticking one
  clears the other three. `hidden` + `mandatory` is a request nobody can submit,
  and `readOnly` + `mandatory` is one only a derivation could satisfy. The stored
  row carries a single `property`, so nothing downstream has to resolve a
  contradiction that should never have been storable.
- **Absent is not `optional`.** A field with no row is not mentioned by the profile
  at all; `optional` is an explicit override, which is what makes a narrow profile
  able to hand a field back after a broader one made it mandatory.
- **The dialog replaces the whole profile.** `saveFieldProperties` deletes the
  profile's rows and writes what was sent, the same wholesale-replace reasoning as
  the staged nodes: the dialog always holds the complete state, so no unticked row
  can survive as a setting nobody can see any more. An unknown entity, field or
  property is **refused**, not filtered — storing the valid remainder leaves a
  profile quietly missing what someone thought they set.
- **The entity/field tree is generated** by `srv/checks/field-properties.js` from
  `payloadFields()`, so a new node in `db/staging.cds` appears in the dialog with no
  UI change. The condition lists are closed and served from the same module: a typed
  value outside them makes a profile that looks configured and never fires.
- **The roles are not the xsappname scopes.** `Approver` is a workflow role that no
  scope carries, so `ROLES` is a hand-kept list next to `REQUEST_TYPES`, which is
  the set of types a request can actually carry (`block`/`delete` are in the enum
  and nothing produces them).
- **Modify saves the profile first.** The settings hang off a saved profile, so a
  row just added has no id to hang them on; the page offers the save rather than
  refusing, because pressing Modify on a new row is the obvious thing to do.

#### Applying them (2026-08-20)

**Where two profiles match, the broadest result wins.** Maarten's rule, and it is a
**join over three axes** (visible / editable / required) rather than a ranking,
because `mandatory` and `readOnly` are not comparable — one says what you must
fill, the other what you may touch. Visible or editable if **any** matching profile
allows it; required only if **every** profile that speaks demands it. His two
examples fall out of that rather than being special-cased:

| Profile 1 | Profile 2 | Result |
| --- | --- | --- |
| hidden | readOnly | readOnly |
| mandatory | readOnly | **optional** |
| mandatory | optional | optional |
| hidden | mandatory | optional |

`PROPERTY_STATE` in `srv/checks/field-properties.js` is the whole rule, and the
join is closed over the four names — every combination lands back on one of them,
which `test/field-property-apply.test.js` proves exhaustively. **There is therefore
no precedence column.** A `sequence` was modelled for one and dropped on 2026-08-20,
before the table had ever been deployed: the merge is a join, so no profile is ever
"first", and a column implying an order nothing reads is worse than no column.

**Silence is not `optional`.** A profile that says nothing about a target is left
out of the join entirely. Counting it as `optional` would let one global profile
neuter every narrower one, which is the opposite of what a global base profile is
for.

**Only `hidden` and `readOnly` cascade from an entity to its fields**, because they
describe the container: nothing shows inside a hidden section and nothing is
editable inside a frozen one. An entity's `mandatory` is about whether it needs a
**row** at all — cascading it would silently make every field of Tax Numbers
required, which is not what ticking Mandatory on the entity means.

Two halves, and they are not the same code path for a reason:

- **Rendering** — `effectiveFieldProperties(RequestType, Role)` on
  `ChangeRequestService` returns the merged answer, and the maintenance controller
  loads it **before the first render** (rendering is synchronous; a field painted
  and then taken away is worse than one never drawn). `hidden` drops the field from
  both layouts entirely — a disabled input still shows the value — and a hidden
  entity hides its whole `ObjectPageSection`, not just the container, or a heading
  is left pointing at nothing. `readOnly` takes editability away and can never
  grant it: a field S/4 will not accept on create stays uneditable however broad a
  profile is. `mandatory`/`optional` have the last word on the star, which is what
  `optional` is for.
- **Enforcement** — `createFieldPropertyStages` adds a `field_properties`
  validation to the Check button, the Duplicate Check button, submit and resubmit.
  A mandatory field left empty blocks, naming the row; a mandatory entity with no
  rows blocks. Without it a profile is a star on a label that a direct service call
  walks straight past. It reads the cascade back first: a field marked mandatory
  inside an entity a broader profile hid or froze is not something anyone can fill.

**The role a submit is judged under is never the client's to name.**
`requesterContext(req)` hardcodes `Requester` on every write path — whoever submits
is the requester — while the *screen* asks for whatever role it is rendering
(`approve` → `Approver`, draft/rework → `Requester`). Otherwise a requester could
claim `Approver` and submit past every mandatory field set for them. When the role
model lands — a requester role, one approver role per function, a steward role —
this becomes a scope read off `req.user` and the two converge.

**`hidden` is deliberately honoured on the approve view.** Confirmed 2026-08-20:
once approvals are split by function, a sales approver has no business reading the
bank details, and that is the point of the feature rather than a risk to it.

`srv/checks/field-property-store.js` caches the profiles for 60s and drops them on
any write, like `rule-store.js`. Its failure mode is the **opposite** one on
purpose: an unreadable rule table reports itself, because a validation nobody ran
must not read as "nothing to report"; an unreadable *profile* table resolves to
nothing, because a read failure that hid every field or blocked every submit would
take the maintenance screen down over a control that is not a verdict on the data.



A `draft` opens editable via `ChangeRequestEdit`. **Anything further along is not
navigable from here at all** (changed 2026-08-13): the approve screen is reached
from the approver's inbox and nowhere else, so a decision is always taken against
a real task rather than by finding the request in a list. The
`ChangeRequestApprove` route still exists — the inbox and `bpurl` use it — but
nothing in this list points at it. The same is true of `ChangeRequestRework`
(2026-08-19): it is reached by the `reworkurl` in the notification SPA sends on a
rejection, and by nothing in this list either.

Consequence, accepted while only the dev team files requests: with the list
steward-gated, **a requester cannot reach their own saved draft**. Revisit when
real requesters start using Save Request.

Still open — ask before implementing any of them: staging retention after
posting (deleting the header would destroy the `postedBP` idempotency guard
against SPA retries), routing edit/change requests through staging (only create
is redirected today), populating `sourceETag` (never set, so a request approved
days later overwrites concurrent S/4 changes), and reading number ranges so
users can key their own BP number when the grouping is externally numbered.

#### Human-readable change request numbers (asked 2026-08-19, not built)

A request is identified by its `cuid` UUID today, which is what the list, the
approve screen and the workflow all show. Maarten wants MDG-style numbers
instead — `$1`, `$2`, `$243`, up to `$999999` — because a 36-character hex string
is not something a person can read out, quote in a mail, or recognise twice.

**Do not do this by changing the key.** Two things make that the expensive
version, and both are documented above:

- The UUID is in the **SPA contract**. `changerequestid` in the workflow context,
  the `decideRequest`/`completeRequest` payloads and the `bpurl` deep link all
  carry it, so re-keying breaks Arthur's process definition and every approver
  task already sitting in an inbox.
- `cds-deploy` **refuses to change a key**, the same way it refuses to drop an
  element. It would need a hand-written migration against a database that now
  holds real requests.

So the shape to build is **additive**: keep the UUID as the technical key and add
a `changeRequestNumber` the UI displays everywhere the id is shown now. The number
is a label, not a foreign key — nothing should start joining on it.

The part that needs a decision before anyone writes code is **where the number
comes from**. It has to be gap-tolerant and concurrency-safe, and a
`SELECT max(...) + 1` is neither: two submits in the same second would collide,
and the 2026-08-12 ZODATACR retry storm is the standing evidence that this app
does produce bursts of near-simultaneous requests. A Postgres sequence is the
obvious answer, but sequences are not in the CDS model, so it is either a
`cds.tx` on a counter table with a locked read or a native `CREATE SEQUENCE` in a
migration. Also undecided: what happens at `$999999`, and whether a *draft* gets a
number at all — assigning one on Save Request means abandoned drafts burn numbers,
assigning it on Submit means a draft has nothing to quote.

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
  `reject` sends it to `reworkRequired` and back to the requester — see "Rework"
  below. It is **not** terminal any more.
- `completeRequest` is the "post it now" signal and the only thing that writes
  to S/4. SPA calls it after its chain finishes.

So `approved` means *waiting to be posted*, not finished. **`posted` is the only
terminal status**; a withdrawn request is deleted rather than parked in one.
Individual approvals are not stored anywhere in CAP, by decision — the UI cannot
show "2 of 3 approved" without a new table.

#### Rework — the requester's screen (2026-08-19)

A rejection is a **loop, not an end**. The approver rejects, SPA notifies the
requester, and they reopen the request, edit every field, and either resubmit it or
withdraw it. `rejected` stays in the status enum because cds-deploy refuses to drop
anything, but nothing writes it any more.

`ChangeRequests/{changeRequest}/rework` renders the **same maintenance screen** in
mode `rework`, which is deliberately the draft view with one different primary
action: the emphasized button says **Resubmit** and routes to `resubmitRequest`.
Withdraw sits beside it. `state.mode` is what `onSave` routes on, so the label and
the route change together.

Decisions behind it, each of which has a cheaper wrong version:

- **The entry point is the deep link and nothing else.** `reworkurl` goes to SPA
  with the *initial* workflow context (alongside `bpurl`), because SPA owns the
  rejection branch and has it to hand there. The change request list is
  steward-gated, so a requester has no other route in — which is also why the
  screen has to cope with a link opened twice.
- **Resubmit resumes, it does not restart.** The process instance stays parked
  through the rejection, and `resubmitRequest` signals it with
  `RESUBMITTED_SIGNAL` (`'resubmitted'`). One instance per change request means one
  audit thread on Arthur's side however many rework rounds happen. A request with
  no `processInstanceId` is refused rather than quietly given a fresh workflow,
  which would hand it two audit threads and possibly two approver tasks.
- **Resubmit runs every gate a first submit runs** — validations and the duplicate
  check with its confirming second press. The requester may have changed the very
  fields the duplicate check reads. Derivations still do not run on a submit path.
- **A failed signal leaves it `reworkRequired`**, exactly as a failed start leaves
  a submit in `draft`: a request in `inApproval` that no process is waiting on sits
  in nobody's inbox and could never be retried.
- **The approver's comment goes to `rejectionComment`, never over `reason`.**
  Overwriting was harmless while a rejection was terminal; now the requester
  reopens this record and would find their own justification replaced by the
  verdict on it — and then resubmit the approver's words as their reason. The
  comment leads the screen as a Warning strip, because "rejected" with no why is
  not something anyone can act on.
- **`claimRework` is a stopgap for the missing reject callback (2026-08-20).** The
  approver presses Reject in My Inbox, SPA notifies the requester with the
  `reworkurl` — and never calls `decideRequest`, so the request is still
  `inApproval` when the rework screen opens it. Every gate downstream reads the
  status, so the screen offered no buttons, refused to edit, and `resubmitRequest`
  would have 409'd. `claimRework` moves `inApproval` → `reworkRequired` on the
  rework route only, treating arrival on that link as the evidence of a rejection —
  the link is only ever sent by the rejection branch. It is a no-op on any other
  status, refuses a request carrying `postedBP`, and deliberately does **not**
  signal the workflow: the process already took its rejection branch.
  **The accepted cost:** the link stays in the requester's mailbox, so clicking it
  again *after* a resubmit pulls a live approval back into rework. Maarten chose
  this over an explicit "take back" press, with the hazard on the table. **Delete
  the handler, the controller call and their tests once Arthur's rejection branch
  calls `decideRequest`** — that is the real transition, and it carries the comment
  this path cannot (the screen says "No reason was recorded with it" instead).
- **`reworkRequired` is an ACTIVE_REQUEST_STATUS.** It looks finished, but the
  requester is about to edit and resubmit, so the partner stays locked. Leaving it
  out would unlock the partner for a second editor mid-rework.
- **No Save Request in rework**, and not only because two buttons is what was
  asked for: Save Request drops the screen out of editing and offers Edit, which
  re-enters `edit` mode — and `onSave` would then route to `submitRequest`,
  starting a second workflow for a request whose own instance is still parked.

**Withdraw deletes.** `withdrawRequest` removes the staged children explicitly and
then the header, rather than trusting the compositions' cascade through the
hand-written `ON` backlinks. Two guards are load-bearing: a request carrying
`postedBP` can never be withdrawn (destroying that guard would let an SPA retry
create a second business partner), and only `draft`/`reworkRequired` are
withdrawable at all. It is **idempotent** — a missing request returns
`Deleted: false` rather than a 404, so a double press is not an error to interpret.
The workflow is told (`'withdrawn'`) before the delete, best-effort: no ordering
avoids stranding something, so this follows the rule every other workflow side
effect here follows — the local record is what must be right, a BPA outage must not
stop a requester withdrawing their own request, and the failure is surfaced via
`req.info` rather than swallowed.

Open TODOs on this, agreed and deliberately deferred:

- **`completeRequest` has no scope restriction.** It writes to S/4, so as it
  stands any authenticated user can force a post and bypass approval entirely.
  Restrict it to the SPA technical user before this goes anywhere real.
- **Arthur's workflow still calls only `decideRequest`** and expects the partner
  to exist afterwards. Until his process adds a `completeRequest` call, approved
  requests will sit at `approved` and never post. Coordinate before merging.

#### The approve screen as a BPA UI5 Task Form

The same app serves the Work Zone tile and the My Inbox task form. `sap.bpa.task`
in `manifest.json` declares it; `Component.js` implements the contract from SAP
Help, *Technical Information for Adapting the SAPUI5 Application*.

- **Never put a comment key in `app/businesspartner/xs-app.json`.** It ships into
  the HTML5 apps repository with the app and is schema-validated there; an
  unknown property in a route makes the whole app version unservable and every
  resource - `manifest.json`, `Component.js`, the preload - returns **500**. The
  app then fails to load with `adding element with duplicate id
  '<app id>-content'`, which names nothing relevant. Cost an afternoon on
  2026-08-13.
- **`app/businesspartner/xs-app.json` needs `^/api/(.*)$` as its FIRST route**,
  to `com.sap.spa.processautomation` / endpoint `api`. Without it the form loads
  and every workflow call 404s — which reads as "the form is broken" and was the
  thing the BAS generator would have added.
- The runtime base URL is **derived**: `/{sap.cloud.service}.{sap.app.id}/api/
  public/workflow/rest/v1`, dots stripped. Renaming either breaks it, which
  `test/task-form.test.js` pins.
- My Inbox renders the buttons. `Component.js` registers them with
  `inboxAPI.addAction`, ids matching `sap.bpa.task.outcomes`, and the app's own
  footer Approve/Reject hide on `env>/embedded` so there is one place to press.
- Completion is `PATCH task-instances/{id}` with `status: COMPLETED`, the context
  and `decision`, after fetching an `X-CSRF-Token`.
- **Order matters**: `decideRequest` runs *before* the PATCH, because completing
  the task resumes the workflow, which calls `completeRequest` and posts to S/4 —
  the request has to be `approved` by then.
- `decideRequest` takes `SignalWorkflow`. The task form passes `false`:
  completing the task is already the signal, and `triggerApprovalDecision` as
  well would deliver the same decision twice.
- Embedded, `window.location` is the **host's**. The change request id comes from
  the loaded task **context**, never from the hash.

#### Contract the SPA side depends on

Changing any of these breaks Arthur's process definition, so agree the change
first rather than "fixing" it locally:

- Approver task URL: `<app-url>#/ChangeRequests/{changeRequestId}/approve`
- Requester rework URL: `<site-url>#BusinessPartner-manage&/ChangeRequests/{id}/rework`

**Both deep links are Work Zone intents, not approuter paths (fixed 2026-08-19).** They were built
as `<approuter-host>/mdmmdbusinesspartnermanage/index.html#<route>`, which is the standalone
approuter's shape - and that module was removed on 2026-08-13, so every link 404'd with
"Requested route does not exist". The managed approuter serves the app through the Work Zone site,
so a link is the **site URL plus a cross-navigation intent**, with the app's own route after `&/`.
The base comes from **`WORKZONE_URL`** (a literal in `mta.yaml`, from Site Manager). `APPROUTER_URL`
is deliberately no longer read: it was still set on the deployed app and kept producing the dead
host, so the variable was renamed rather than reused - unset now yields `''`, and a missing link is
diagnosable where a 404 is not. The intent must match the `BusinessPartner-manage` inbound.
- Workflow context sent at submit:
  `{ changerequestid, requesttype, businesspartner, emailadressinitiator, bpurl, reworkurl }`

**Not built on Arthur's side yet — rework needs three things from his definition,
and the loop does not close without them:**

1. On reject, **call `decideRequest` with `Decision: 'reject'` and the approver's
   comment**, then **notify the requester** with `reworkurl`, and **do not complete
   the instance** — park it waiting. `resubmitRequest` hands the request back to
   that same instance. As of 2026-08-20 the notification arrives but the callback
   does not, which is why `claimRework` exists — see the Rework section.
2. Handle the approval-decision trigger input `result: 'Resubmitted'` by routing
   the request back to the approver, the way a first submit does. **Capitalised**,
   unlike `approved`/`rejected` - his spelling, agreed 2026-08-19. The resubmit
   payload is:

   ```json
   { "executionId": "<process instance>",
     "inputs": { "result": "Resubmitted", "changerequestid": "...",
                 "businesspartnerinput": {}, "bpduplicates": [], "...": "..." } }
   ```

   The BP context sits **flat inside `inputs`, next to `result`**, and is the same
   object a first submit sends as its workflow context - `workflowContext()` builds
   it for both, so the two cannot drift. It is rebuilt *after* `persist()`, or the
   approver would be handed the version they had already rejected. `executionId` is
   the BPA process instance; Arthur calls it the CR id, and it is **not** the change
   request UUID.
3. Handle `result: 'withdrawn'` by terminating the instance and clearing any open
   approver task. CAP has already deleted the request by the time this arrives.
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
