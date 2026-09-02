# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

CAP (Node.js) + SAP Fiori Elements (OData V4) recreation of SAP's `mdm.md.businesspartner.manage`
(F3163). There is **no local business-partner database** — the CAP service is a facade that delegates
reads to an S/4HANA OData V2 `API_BUSINESS_PARTNER` service through the BTP destination
`VF_S4HANA_DEST`. BP deletion is disabled throughout.

Reads are pure facade; **creates are staged in PostgreSQL and posted only once approved**. Read
"Change request staging" before touching `db/staging.cds`, `srv/change-request-service.*`, or the
maintenance controller.

## Commands

Root (CAP service):
```bash
npm ci                   # install
npm run watch            # cds watch, http://localhost:4004
npm start                # cds-serve
npm test                 # node --test test/*.test.js
node --test test/business-partner-service.test.js
node --test --test-name-pattern="<pattern>" test/<file>.test.js
npm run local            # cds watch --profile hybrid (live BTP-bound services)
npm run build            # cds build --production
npm run import:bp        # re-import API_BUSINESS_PARTNER
npm run import:valuehelp # re-import ZSRVB_MDMLIGHT_VH
```

Four npm projects under `app/`: `businesspartner` (Work Zone tile, Fiori Elements),
`mdmrules` (MDM Configuration Panel tile), `bptask` (My Inbox task UI, freestyle), `reuse` (the
shared maintenance screen, a library-shaped folder copied at build time). Each has `npm run build:cf`;
`app/businesspartner` also has `npm start`, `start-mock`, `generate:metadata`, `unit-tests`,
`int-tests`.

Deployment: `mbt build` then `cf deploy mta_archives/mdm-md-businesspartner-manage_<version>.mtar`.

Hybrid testing needs service keys bound with `cds bind` into `.cdsrc-private.json` (gitignored).
The destination must be named `VF_S4HANA_DEST`, URL ending at `/sap/opu/odata/sap` — CAP appends
`/API_BUSINESS_PARTNER` or `/ZSRVB_MDMLIGHT_VH`. On-premise needs `ProxyType=OnPremise` via Cloud
Connector and `csrf: true` (already set).

## Standing rules

These recur everywhere; sections below assume them rather than restating them.

- **A check that could not run must never read as a check that passed.** No "no duplicates found"
  from a check that never ran, no empty findings panel where a lookup failed, no silently skipped
  validation. Report the failure instead.
- **Best-effort for every remote/platform read that is not a verdict on the data** — BTP APIs, BPA
  signals, workflow rule/profile tables, metadata drift, live re-reads for diffing. Never throw,
  never block a submit, log and degrade. The opposite applies to *validation* stores: an unreadable
  rule table reports itself, because a validation nobody ran must not pass silently. An unreadable
  *field property* table resolves to nothing, because hiding every field or blocking every submit
  over a control is worse.
- **`cds-deploy` can ADD an element and can neither DROP nor RETYPE one.** Any removal fails
  `deploy_to_postgresql` at compile time, identically on every retry. Consequence: abandoned columns
  stay in the model as documented dead weight, and a reworked mechanism gets a NEW name rather than
  reusing a deployed one. Currently dead and read by nothing: `DerivationRules.createsRow`, the four
  `cond*` columns on `DuplicateRules`, `FieldPropertyProfiles.sequence`, and on `WorkflowRules` the
  `conditions : LargeString` column plus the whole `conditionRows`/`WorkflowRuleConditions`
  composition. Never delete these; never "revive" them either.
- **Half a mechanism nobody calls is what the next person mistakes for a working one.** Withdrawn
  client-side code is deleted, not left dormant. A *read* path is kept where stored data may still be
  in the old shape (e.g. `srv/checks/value-lists.js` still parses `BE|NL` delimited lists).
- **A requester never reads "you could have X if you filled in Y."** A derivation that cannot fire
  for want of an input says nothing. Two exceptions that do speak: a result that is only partial
  ("this country has 5 tax categories, one row is proposed"), and settings that could not be read.
- **The client may never name the role a write is judged under.** `requesterContext(req)` hardcodes
  `Requester` on every write path. The *screen's* own role is trusted only for rendering decisions
  and for what a proposal may offer.
- **Bump versions on every deploy** — `version` in `mta.yaml`, and
  `sap.app.applicationVersion.version` in each UI app's manifest. Several artifacts have shipped
  under one number, which makes deploy logs and `cf html5-list` useless.

## Architecture

### Facade, not a data model

`srv/business-partner-service.cds` projects the imported `API_BUSINESS_PARTNER` model
(`srv/external/*.{csn,edmx}`, all 65 entity sets). Almost everything is `@readonly`; only
`BusinessPartners` and the maintenance actions write. Two exclusion lists (`A_Customer excluding
{...}`, `A_Supplier excluding {...}`) work around fields in the imported metadata that this
on-premise release does not expose — a section read failing with "Resource not found for the
segment" usually means a field needs to move into an exclude, not that there is a bug.

### The imported models are copies and go stale silently

Both remote services are compiled from `srv/external`; nothing reads `$metadata` at runtime and
nothing can (`as projection on` is resolved by the compiler, `mbt build` is offline).

- The bare import scripts resolve destinations from `VCAP_SERVICES` and **only work in Cloud
  Foundry**. From BAS use `npm run import:bp -- --url https://<host>:44301/sap/opu/odata/sap`
  (`S4_USER`/`S4_PASSWORD`, `--insecure` for a self-signed gateway). There is no `--file` route on
  purpose. For a document already in the workspace:
  `npx cds import <file>.edmx --as cds --force --no-save` — **not `--into`**, cds-dk 8 does not know
  that flag and lands the result in `srv/external` by itself.
- Both checked-in copies got here by hand. Treat a re-import as a manual step a person performs.
- **The five `Der*` entities in `ZSRVB_MDMLIGHT_VH` were hand-added to both the `.cds` and the
  minified single-line `.edmx`**, not imported. The `checksum` comment in the `.cds` is stale and
  nothing verifies it. No `Annotations` block was added for them, matching the served metadata. A
  real `cds import` supersedes all of it and is preferred whenever one can be run.
- `srv/metadata-drift.js` runs once at startup against the nine entity sets the app actually reads.
  A property the live service **dropped** is a warning (that read is already failing); one it
  **gained** is info. Read its output against the `excluding {}` lists — a named field already
  excluded is noise, one that is not is a broken section. Silence means "no destination here", not
  "in step".
- **Excluding a field in the CDS must reach the create screen too.**
  `app/businesspartner/scripts/generate-maintenance-metadata.js` compiles
  `business-partner-service.cds` (`cds.load`/`cds.linked`) and diffs each section's projected
  elements against the raw CSN to derive exclusions automatically, merged with whatever
  `excludedFields` a section still hand-lists. A CDS-excluded field still named in a `fieldGroups`
  block fails the build. Re-run `npm run generate:metadata` after changing any `excluding {}` clause
  (`build`/`build:cf` already chain it).

### `abap/` — the two S/4-side services

`abap/valuehelp/README.md` and `abap/customerfields/README.md` carry the ADT steps, the released
views behind each value help, and known drift. Read one before touching a `@Common.ValueList`.

`abap/customerfields` (`ZMDML_CUST_ENTITY` / `ZSRVB_MDMLIGHT_CUST`) is **designed but not wired in**
— not in `package.json`'s `cds.requires`, no `srv/external` copy, nothing projects it. It exposes
`I_Customer` to close the gap between `A_Customer`'s 53 fields and the MDG ERP Customer screen. Build
it when one of those fields is actually asked for.

`mdmlbpcheck/README.md` holds the ABAP write-ups: the `ZMDML_BPCHECK` mapper, the nine SPRO
derivations SAP fills in and this app does not (with their customizing sources), and the probe
rounds that established the mechanism.

## Change request staging (approve-then-create)

**Nothing reaches S/4 until it is approved.** Creates used to post immediately and start the workflow
afterwards, so the approver reviewed something already live. Do not reintroduce that order.

1. User fills the create form (no Preview step — removed; Check, Save Request and Submit Request are
   live on the empty form).
2. **Submit Request** writes to staging; **Save Request** stores a draft without starting anything.
3. The SBPA workflow starts and a task lands in the approver inbox.
4. The approver opens the same maintenance screen in approve mode, read back from staging.
5. On approve, CAP posts to `API_BUSINESS_PARTNER`. SBPA never writes to S/4.

`db/staging.cds` holds `ChangeRequests` plus one `Staged*` node per object-page section (mirroring the
MDG node structure), `CheckFindings`, and `ChangeRequestComments`.
`srv/change-request-service.cds` exposes `ChangeRequests`/`CheckFindings` as `@readonly` and does
every write through actions, so a status cannot be forged from the client.
`srv/change-request-service.js` never talks to S/4 directly — posting is delegated to
`BusinessPartnerService`, which owns the connection, payload sanitizing and maintenance config.

Every child node carries an explicit `request` backlink, so **the to-one compositions (`general`,
`customer`, `supplier`) need an `ON` condition too** — without it CAP puts a foreign key on the header,
duplicating the link and creating a schema that later fails to migrate.

**Statuses.** `ACTIVE_REQUEST_STATUSES` is a lock (governs the refusal to edit, `openEditPage` in
`CustomActions.js`) and includes `approved` and `failed`, because a failed post is not atomic.
`IN_PROGRESS_REQUEST_STATUSES` (`srv/search-results.js`) is narrower — `draft`, `inApproval`,
`reworkRequired`, `checkAndEnrich` — and answers "is a human still holding this". Do not collapse
them. `posted` is the only terminal status; a withdrawn request is deleted. `rejected` is in the enum
and nothing writes it any more, but it cannot be dropped, so no reader may fall through on it.

**Still open, ask before implementing:** staging retention after posting (deleting the header would
destroy the `postedBP` idempotency guard against SBPA retries); routing edit/change requests through
staging (only create is redirected today); populating `sourceETag` (never set, so a request approved
days later overwrites concurrent S/4 changes); reading number ranges so users can key their own BP
number when the grouping is externally numbered; `completeRequest` has **no scope restriction** and
writes to S/4, so any authenticated user can force a post — restrict it to the SBPA technical user
before this goes anywhere real.

**Human-readable CR numbers (asked, not built).** Maarten wants MDG-style `$1`…`$999999` instead of
the `cuid`. **Do not change the key** — the UUID is in the SBPA contract (`changerequestid`, the
decide/complete payloads, `bpurl`) and `cds-deploy` refuses to change a key. Build it additively as a
display-only `changeRequestNumber`; nothing joins on it. Undecided: where the number comes from
(`SELECT max()+1` is not concurrency-safe and this app does produce bursts — a Postgres sequence needs
either a locked counter table under `cds.tx` or a native `CREATE SEQUENCE` migration), what happens at
`$999999`, and whether a draft gets a number at all.

### The merged search list

The list report reads **`BusinessPartnerSearchResults`**, not `BusinessPartners`: live S/4 partners
and in-flight change requests in one result set, so a requester can see that the company they are
about to request is already being created. A partner under an in-flight request is **marked**, never
hidden (`applyChangeRequestExclusion` is deleted) — the object page and maintenance screens still read
`BusinessPartners`, so a hidden partner could not be opened for display either.

Two kinds of row: a **pending create** has no partner number and appears as its own row
(`ResultKey: 'CR:<id>'`, `IsChangeRequest: true`), named by `stagedFullName`. A
**change/block/delete** request is the existing partner's own row (`ResultKey: 'BP:4711'`) carrying
`RecordStatus`/`RecordStatusCriticality`/`ChangeRequest`; its staged copy is never listed separately,
or one company would be reported twice.

The entity is `@cds.persistence.skip`; one READ handler in `srv/business-partner-service.js` merges:

1. **Staging is read first** and staged rows take the top of the list, which is what makes `pageSplit`
   exact — page 2 resumes the remote read at `skip - pendingCount`.
2. Staged rows are filtered **in memory** by `matchesWhere` and `matchesTerms`. An expression
   `matchesWhere` cannot evaluate **keeps** the row and logs `[search]`: a staged request wrongly
   shown is a nuisance, one wrongly hidden is the failure this list exists to prevent.
3. The remote read asks for a **fixed** column list (`PARTNER_FIELDS`) — one unknown field fails the
   whole remote read.
4. **`$count` arrives from the V2 remote as a STRING.** `partners.count + pending.length` concatenates
   (`"323" + 57` → `"32358"`). Coerce both sides.

- Computed columns are non-sortable (`NonSortableProperties` keeps all the change-request ones):
  sorting on one would silently sort the staged half only. `remoteOrderBy` drops anything S/4 has
  never heard of, `ResultKey` included.
- **Every filterable column must also be in `UI.SelectionFields`** — OData V4 Fiori Elements builds
  the filter bar and "Adapt Filters" from that list alone, with no "every property is a candidate"
  fallback.
- **Change-request columns are filterable.** S/4 has never heard of them, so `referencedFields`
  (`srv/search-results.js`) walks the WHERE clause and, if any field falls outside `PARTNER_FIELDS`,
  flips into a branch that fetches the full matching population and filters in memory
  (`mergeLocalPage` against `entry.row`, not `entry.searchable`), sorts by `byRequestedAtDesc` and
  pages locally — so that branch's `$count` is exact. A `console.warn` names the fields that forced
  it. A mixed filter works because the whole clause is evaluated once against the whole merged
  population; splitting it would be the optimisation, and correctness came first.
  `NonFilterableProperties` holds only `ResultKey` and `RecordStatusCriticality`; `ChangeRequest` (a
  raw UUID) stays off `SelectionFields`.
- **A change request row opens read-only, for anyone**, via `ChangeRequests/{id}/display` —
  `_loadStagedRequest(id, "view")`, no Check, no decision buttons, no save. Editing a draft still
  means the steward-gated Change Requests list; an `inApproval` request is still decided from the
  inbox against a real task. `onSave` refuses an unrecognised mode.
- **Nothing authorises the staged payload.** `getRequestPayload` has no check in front of it and
  `@readonly ChangeRequests` is readable by any authenticated user through `$expand`. Restricting
  `getRequestPayload` to steward-or-requester today would break every approval, because an approver is
  neither. Closing this needs the role model.

Change requests have their own list (`ext/view/ChangeRequestList.view.xml`), reached from a
**steward-only** button (`{perm>/isDataSteward}`). Consequence accepted while only the dev team files
requests: **a requester cannot reach their own saved draft.** A `draft` opens editable via
`ChangeRequestEdit`; nothing further along is navigable from this list at all — approve is reached from
the inbox, rework from the `reworkurl` notification.

### `BusinessPartnerFullName` is derived, never stored

A standard S/4 field marked `sap:creatable="false" sap:updatable="false"` — S/4 composes it and
refuses to be told it. Hence uneditable on the maintenance screen, and absent from the Field
Properties catalog (`payload-fields.js` is generated from `db/staging.cds`, which has no such column).

A **pending create** has no such name anywhere, so `srv/partner-name.js` composes it — the BP category
decides which fields to read (1 person, 2 organisation, 3 group), because S/4 discards name fields that
do not match the category; an empty answer falls through the other groups rather than leaving a request
unnamed. **One composed name, two consumers**: `stagedFullName` in `srv/search-results.js` *is*
`fullNameOf`, and `buildBusinessPartnerInput` wraps the root row in `withFullName`.

**Never write it into a request payload.** `ROOT_CREATE_EXCLUDED_FIELDS` is the create-path
counterpart to `sanitizeEntityPayload`'s update exclusions and holds `BusinessPartnerFullName` and
`BusinessPartnerName`. Other derived root fields (`BusinessPartnerUUID`, `CreatedByUser`, …) are still
unguarded on create; nothing produces them today.

On screen `_refreshFullName` fills it from `previewName` (the same category-driven composition,
client-side). It recomposes on a committed name field, on a name accepted from a proposal, from the
Additional Fields dialog, and from the AI assistant's suggested draft (`_onCreateRoute` calls
`_refreshFullName(true)` after `setData`) — the last three because they write straight into
`state.root` and never fire `_onFieldCommitted`. All are **guarded on a name field having actually
changed**: an existing value is otherwise left alone, because on a partner read from S/4 that value is
S/4's own derivation. It is safe to hold on `state.root` — staging has no such column so `stageable()`
drops it.

### The request screen's message area

Strips live in a collapsible `Panel` (`maintenanceMessagePanel`). The header carries the leading
message elided to one line with `(+N more)`; strips are ordered so a Warning leads. Anything above
Information opens the panel (`messagesNeedAttention`). `expanded` is bound **one-way**, so a render
re-applies it — accepted deliberately over a state flag all thirteen `state.messages = …` sites would
have to remember to set.

**The findings follow the request into the approval task.** `getRequestPayload` returns `FindingsJson`
(duplicate findings, `duplicate_check` only, same `isStale` filter the exposed `CheckFindings` view
applies) and `ValidationsJson` (written by `recordValidationFindings` on both submit paths), and
`_loadStagedRequest` feeds them to the same `_setDuplicatePanel` / `_validationMessages` the requester
saw — one piece of code, so the two screens cannot drift. Validations are written **after** the
blocking gate (nothing blocking is ever stored) and **before** the duplicate check (an outage there
cannot cost the warnings already produced), and are **superseded, not deleted**, on a resubmit.
Validations render as strips, not in the duplicate panel: they are statements about this record, not
other partners to compare against. Messages are **appended after the mode branches**, since every
branch assigns `state.messages`.

Approver findings rows carry **no candidate name** — `candidateName` is not a staging column, so the
title is the partner number (or `pending request <id>`) and the stored `message` carries the sentence.

`srv/request-processors.js` (a "who has it now" step/holder sentence, returned as `ProcessorsJson`)
is **still on the server and no longer rendered** — `processorMessage`/`parseProcessors`/
`state.processors` were removed from the controller on request. It stays available to build a
different surface on. Its own rules: approvers are what CAP *sent* the workflow (re-resolved from
`WorkflowRules`, so a table edited since submit makes them stale), resolved only while `inApproval`;
a requester is always `kind: 'user'`; `submittedBy` outranks `createdBy`; `approved` and `failed` say
nobody holds them rather than naming someone who cannot act; an empty approver list is legitimate.

## The check pipeline — `srv/checks/pipeline.js`

**validate → derive → duplicate check**, and the order is the design: data that fails validation
cannot be a duplicate of anything, and data that is merely incomplete may be missing the very fields a
duplicate rule needs. Stages run over the **request payload** (`{ root, sections }`), not a flattened
candidate, so a derivation can say "the street of the first address" and the screen can write it back.

Three behaviours worth not "simplifying" away: a validation that **throws blocks** (a rule that
silently skipped would defeat the ordering); a derivation that throws **only reports**; a duplicate
check that could not run is **reported**, never folded into an empty result.

`VALIDATIONS`/`DERIVATIONS` are empty default registries. The stages actually used are built per
request in `runRequestChecks` (`srv/change-request-service.js`) from `srv/checks/rule-store.js` (the
steward-configured tables), `registry-checks.js` (VIES/GLEIF), `cvi-checks.js`, `derivation-checks.js`
and `field-properties.js`. **Configured stages come first in both lists**: validations because they
are offline and a failing request should not cost a VIES call; derivations because the pipeline never
overwrites, so an explicitly configured rule outranks a lookup.

**Pipeline guarantees:** a derivation **never overwrites** a typed value; `createsRow` invents a row
only when the section is empty **or** — with a `rowKey` — when no existing row already carries that
key; `runDerivations` applies each entry as it goes, so a later entry in one stage sees an earlier
entry's row.

### Two buttons, two questions

- **Check** — "is this record right?": validate, derive, normalise. Returns derivations and
  normalisations and **nothing about duplicates**.
- **Duplicate Check** — "does it already exist?": validate, derive, match. Derivations run **in memory
  only** (a rule conditioned on a country nobody typed still has to fire).

Both stage nothing and share `runRequestChecks`; only the stage list differs, never the order.
**Submit/resubmit run the validations and the duplicate check, never the derivations** — a derivation
changes the data and the requester has to have seen what they are asking for. Since Check only
proposes, no derived value reaches a request without the requester ticking it.

### Checks run on a button press, and only on a button press

The automatic/debounced trigger was removed: **opening a record dialog commits the cell behind it**,
so "+" and "Add" fired checks nobody asked for, mid-typing, each costing an AI Core call and a remote
round trip. Every guard added against the resulting double-dialogs worked as designed; the premise was
what was wrong.

- `_onFieldCommitted` survives and does **local work only** — recompose the full name, redraw the
  change summary. `test/check-triggers.test.js` pins that it makes no server call (no
  `_executeAction`, no `checkRequest`, no `setTimeout`, no `_offerProposals`). Adding a debounced check
  back is a one-line change, which is why the absence is tested.
- `_cancelPendingTrigger` keeps its name, has no timer left, and empties `_declinedProposals` so a
  check button asks again. Every check-running button calls it first.
- `Propose` and `Scope` on `checkRequest` stay (the duplicate check sends `propose: false`, and
  `checkStandard` still keeps the SAP standard checks off a scoped call); nothing automatic sends them.
- `_rememberDeclined`/`_isDeclined` stay as the record of what was offered and refused; nothing filters
  on it. Declines are recorded in `afterClose` (Escape is a decline too, and after Apply Selected the
  unticked rows are declines). One dialog at a time (`_proposalsOpen`). `_emptyState` clears them.

### Registry checks — VIES and GLEIF (`srv/checks/registry-checks.js`, `srv/ai/registry.js`)

One validation and one derivation sharing a single lookup (VIES throttles per member state).

- A VAT number VIES does not know **blocks**. A name or address disagreeing with the register only
  **warns** — VIES returns the legal name and partners are often stored under a trading one, and
  blocking stopped the derivations and normalisation proposals too. `NAME_MISMATCH_SEVERITY` is the
  knob back to `'error'`.
- **VIES never proposes.** It validates and fills gaps; rewriting a typed value is `normalise.js`'s
  job. A register value differing from a filled-in one is a warning naming both.
- **Never block on an outage.** `registry.js` uses check name `vat_registered` for both "not
  registered" (error) and "could not confirm" (info — VIES answers `isValid: false` when throttled).
  Re-grade by **severity**, never by check name; `severityOf` exists for this.
- **GLEIF is a last resort, not a second opinion.** `enrichCandidate` searches GLEIF only when a name
  **and** a country are filled in (`primaryCountry` reads the root `Country` or the first address — a
  name alone once put a Belgian company under a Dutch entity's number) **and** no VIES check came back
  `VALID`. `requireCountry: false` is opt-in and used only by the assistant's "who is this company?"
  prefill, whose answer is chat prose, never a proposed field value; the pipeline never passes it and a
  test pins that.
- The derivation fills empty address fields on the **first** address row, VIES then GLEIF, and sets
  `createsRow` on the first of its four address entries when there is no address row at all.

### The CVI configuration check (`srv/checks/cvi-checks.js`)

Answers **will this partner actually synchronise?** — CVI turns a BP into a customer and a supplier,
and whether it can is decided by S/4 customizing nobody filling in the form can see. Reads
`CviConfigService` (`srv/cvi-config-service.cds`), backed by CDS views in S/4 package `ZMDM_LIGHT`.

- **A role its BP category may not carry** — `TB003` gives role → role category, `TB003A` the
  category's allowed BP categories. Reported per offending `BusinessPartnerRoles` row.
  **Every CHAR(1) flag in these sets arrives as `Edm.Boolean`, not `'X'`** (look at
  `srv/external/ZSRVB_MDMLIGHT_VH.cds`) — this rule was wrong twice over exactly that, once firing on
  `FLCU01`/`FLVN01` on an organisation and once being permanently silent. `isSet` accepts both
  representations and the tests use the boolean form on purpose. The no-flags-set guard stays but
  describes no real system: on S4A all 166 `TB003A` rows have at least one flag set.
- **Postprocessing switched off**, when a role is requested at all — PPO off means a sync error is
  dropped rather than queued and the partner silently never becomes a customer. Reported **per row of
  `CviPostprocessingControl`**, never against a hardcoded sync object name.
- **Number assignment** — does the grouping line up with the account group CVI will use, so a number
  actually gets assigned? Tables: `TBD001`/`TBC001` (grouping → account group + same-number flag),
  `CVIC_CUST_TO_BP1`/`CVIC_VEND_TO_BP1` (inbound, both empty on S4A), `TB001.NRRNG`,
  `T077D.NUMKR`/`T077K.NUMKR`, `TBD002`/`TBC002` (which role category creates a customer/supplier),
  `MDSC_CTRL_OPT_A` (active directions). Reported in order: direction off; nothing maintained for the
  grouping; same number set but intervals differ (both ranges and intervals named); same number not set
  and the account's range is external. The inbound rows are exposed but never read — MDM Light only
  creates BPs — and a test pins that a rule cannot mistake one direction for the other.
- **Severity is `warning`; `ROLE_CATEGORY_SEVERITY` is the knob.** The costs are asymmetric: a warning
  on a combination that would have worked is noise, blocking a legitimate partner leaves a requester
  unable to submit and with no way to argue. Move to `error` once seen right on real customer data.
- **A configuration that cannot be read reports itself and never blocks** — the pipeline turns a
  thrown validation into a blocking error, so an unreachable S/4 would stop every submit.
- **Configuration, not SAP's verdict.** `CVI_FS_CHECK_CUST` is a module pool with no callable API and
  its judgements move with support packages; these rules are derived from the customizing itself.
- Deliberately not built: contact person synchronisation — MDM Light stages no contact persons.

**The account group derivation `cvi_account_group`** fills `Customers.CustomerAccountGroup` /
`Suppliers.SupplierAccountGroup` from `TBD001` — for direction BP → Customer, S/4 takes the account
group from that table by grouping; it is a lookup, not a free choice, and it only existed on a SPRO
screen. Silent wherever it cannot be sure (no grouping, no role that creates the account, an inactive
direction, no assignment row or more than one); `numberAssignmentFindings` already says why nothing
was filled. Because a derivation never overwrites, `accountGroupConflictFindings` sits beside it and
reports a requester's hand-picked account group that contradicts `TBD001` — validations run before
derivations, so it judges what was typed. Which target a role reaches for comes from `TBD002`/`TBC002`,
**never from the role name** — pattern-matching `FLCU*` would be a guess.

### SAP standard checks (`ZMDML_BPCHECK` via `srv/checks/bp-check.js`)

- **They only see accepted values.** `runDerivations` returns a third payload, `systemDerived`: what
  was typed plus only entries a derivation marked `system: true`. `checkStandard` runs on that, never
  on `derived` — otherwise S/4 objects to postal codes VIES merely *proposed*, an error a requester
  cannot clear. Acceptance is the gate; `_applyProposals` writes an accepted proposal into the payload
  so it arrives typed on the next press. `cvi_account_group` is the **only** `system` derivation, and
  the flag is load-bearing twice: `TBD001` decides the account group whatever the screen says, and it
  is what *creates* the `Customers`/`Suppliers` node, without which `ZMDML_BPCHECK` sends no relation
  node and the customer/vendor tiers silently examine nothing. The duplicate check still reads
  `derived`. `systemDerived` is replayed from `applied` (so an entry the pipeline refused is not
  replayed) and a keyed entry is replayed **by key, not by index**.
- **They are held back until the proposals are answered.** `bp-check.js` flattens every S/4 message to
  `{severity, message}`, formatting class and number into the text and discarding S/4's own `field`
  (which anchors nothing anyway), so "was this message about City?" cannot be answered — and an
  accepted value can make a **new** message appear, so a removal-only reconciliation would hand back a
  cleaner list than S/4 would give. The answer is **when**, not **which**: `checkRequest` returns
  `StandardJson` separately from `ValidationsJson` (filtered by object identity out of
  `result.validations`), and `_resolveStandardChecks` decides on the way out of the dialog — nothing to
  propose: shown on the first press; nothing accepted (Not Now, Escape, all unticked, every value
  edited back): shown as they are, **no second round trip and no second vendor number**; something
  accepted: `_rerunStandardChecks` asks again with `Propose: false`, replacing rather than merging.
  `_applyProposals` **returns the number of fields it changed** and that count is what `afterClose`
  reads, not whether Apply Selected was pressed. A re-run that fails says so as a warning, never as
  silence.
- **They only run on the DATA STEWARD step.** `stewardStep` in `runRequestChecks` reads the screen's
  own `req.data.Role` with `startsWith(DATASTEWARD_ROLE)`, and `checkStandard` is
  `standard && !scope && stewardStep`. This is the same trust level as the `renderRole` half — nothing
  is written or approved on the strength of `Role`; what it decides is whether a remote dry-run costs a
  round trip and a vendor number, so a client that lied spends only its own. A requester's Check still
  validates, derives, normalises and duplicate-checks; what they no longer see is S/4's message list.
  `_rerunStandardChecks` sends `Role` too.
- **`MAX_SEVERITY` caps every standard finding at `'warning'`** on purpose, and `runChecks` never lets
  one flip its own `valid` flag — they join the validation list for **display**. So the pre-action gate
  uses `_standardBlocks(findings)`: anything with `severity !== 'info'` blocks (gating on `'error'`
  would never fire), and a findings value that is not an array blocks too. Checked in every branch
  `_runPreActionCheck` takes, including approve, and — where proposals were offered — against the
  **effective** findings the dialog settles on, not the stale initial ones. `_resolveStandardChecks`
  and `_rerunStandardChecks` both return those findings for that reason.

### SPRO derivations (`srv/checks/derivation-checks.js`)

One stage, `sap_derivations`, reading `DerivationConfigService` with a 60s cache. Runs **last** in the
derivation list — a country default is the weakest claim on any field. Check and Duplicate Check only.

- **Address language** from `T005-SPRAS`, on **every** address row (every address in a country has that
  country's default language, unlike a registry fact about one place). This is the `FSBP_GENERIC/008`
  field.
- **Customer tax category** from `TSTL` — proposes the ROWS; `CustomerTaxClassification` is left empty
  on purpose (a decision about the customer, not something customizing knows). Only when the request
  asks to be a customer, never into a section already filled. A country with several tax categories is
  **said out loud** as a `field`-less statement naming all of them. **A created tax row needs TWO
  entries** — `createsRow` writes one field, so the departure country comes from a second entry that
  finds the row the first made; without it the row is half a `KNVI` key.
- **Address time zone** from `TTZ5S`, keyed by country **and** region, into `StagedAddresses
  .AddressTimeZone` (`ADRC-TIME_ZONE`). No region means nothing to derive, said as a statement (one,
  however many rows are short). Where a region carries several zones `TZONEDFT` decides; where several
  exist and none is default, nothing is derived — a customizing gap, not a coin toss.
- **`TransportZone` is deliberately NOT staged**: `TZONE` holds valid zones per country and carries no
  determination data, so nothing could ever fill it.
- **Mandatory customer partner functions** from `TKUPA` → `TPAER`. `TKUPA`'s key is the **account group
  alone** (`T077D` carries no procedure; `T077D-KALSM` is output determination). Only `PartnerType =
  'KU'` rows. `BPCustomerNumber` and `PartnerCounter` are never proposed. Needs a `CustomerSalesArea`
  row; three extra entries fill that key.
- **Mandatory supplier partner functions** from `T077K-PARGE` → `TPAER`. **A different table**: the
  vendor procedure is three columns on the account group table itself (`PARGE` purchasing org, `PARGT`
  sub-range, `PARGW` plant). Only `PARGE` is joined, because the app stages a purchasing-org row and
  nothing below it. Guard inverted: `PartnerType = 'LI'` — procedure `AG` carries `LF` and schema `0001`
  carries `AG`, so each side would otherwise propose the other's functions.
- Customer-only is not an oversight: `KNVI` has no vendor counterpart. Withholding tax is absent from
  both (`T059P` has no mandatory flag). Language and time zone are BP-level.
- **Do not copy `cvi_account_group`'s `system: true` flag onto these** — that flag says "S/4 will use
  this whatever anyone ticks", which is true of the CVI account group and of nothing else here.

**The remote value-help service caps a response at 100 rows.** `srv/checks/config-reader.js`'s
`readAllOf` is mandatory for every customizing read (twelve were silently truncated; account group
`0001` alone is 18 `DerPartnerFunctionAccGrp` rows, so page one never reached `DEBI` and correct
customizing proposed nothing). Two decisions inside it: **`skip` advances by what arrived, never by
`pageSize`**, and **the loop ends on an EMPTY page, not a short one** (the read that lost `DEBI` was
short *because* the server capped it) — unlike `readAllPages` in `business-partner-service.js`, which
stops on a short page because there the caller sets the page size. Still unpaged deliberately:
`fetchWorkflowEntityRows` (one partner's child rows) and everything on local Postgres.
`derivation-checks.js#diagnose` logs the five config **row counts** alongside every field the builders
branch on, because a truncated read looks exactly like customizing that says nothing.

### Two standard-check messages nobody could clear

- **`VMD_API/043`** (EU vendor needs a VAT registration number) fired on every EU vendor because
  `ZCL_MDML_BPCHECK` never built a `TaxNumbers` node — `ty_sections` had no such member. Same blind
  spot fed `CVI_API/007`.
- **`FSBP_GENERIC/008`** (LANGU in ADDR1_DATA) was *caused* by the mapper: `datax-langu` was set
  unconditionally, and a blank with the X-flag set means **clear this field**.

So `StagedAddresses` gained **`Language`** (ADDR1_DATA-LANGU, `String(2)`). **It is not
`CorrespondenceLanguage`** — that is BP-level (`bp_centraldata-partnerlanguage`) and person-only on an
organisation (`R11/336`), so filling it can never satisfy an address-level LANGU and on an org buys a
second error. Keep the two apart.

### Normalisation — `srv/checks/normalise.js`

AI Core proposes reformatting of **stored** data (casing, legal forms `bvba` → `BVBA`, whitespace,
street conventions). **Proposals only.** Normalising *for comparison* is solved deterministically in
`srv/ai/duplicate-fields.js` and is a different thing; a derivation fills a gap and never overwrites,
a normalisation only ever touches a field that already has a value.

`sanitizeProposals` drops a proposal for a field that was not offered or that changes nothing.
Identifiers (tax numbers, IBAN, BP number) are outside `NORMALISABLE` — formatting them is not a
formatting matter. Runs on **Check only** and returns `[]` on any failure.

### The proposals dialog

Derivations and normalisations share one dialog, everything ticked by default, with a `change` column
saying `Filled in` or `Reformatted`. Derivations **no longer auto-apply**.

- A field a derivation filled and the model then reformatted is **one row, not two** (`_proposalRows`),
  and the normalised value wins.
- The proposed value is an **editable input**; `_applyProposals` reads back from the model. Clearing
  the field is a decline, not an instruction to blank what is there.
- A derivation carrying **no `field`** is a statement, not a value — it stays a message strip.
- **The Why column is three words, with the sentence on hover.** An entry carries a short `label`
  (shown as Why) beside its long `message` (the cell's tooltip). Labels: `VIES check` / `GLEIF check`
  (named after the source — a requester needs to know which register to argue with), `CVI customizing`,
  `Derivation rule`. Normalisations get theirs from the model: `PROPOSAL_SCHEMA` requires `reason` and
  `detail`, the prompt asks for at most three words and one or two sentences, and `shortReason` clamps
  to three words server-side. A missing `detail` falls back to a stated sentence — an empty tooltip
  reads as a broken one.
- **A whole derived ROW is one line.** `_proposalRows` groups derivation entries on **target + index**,
  and a group whose lead entry carries a **`rowKey`** collapses into one line built by `_derivationRow`:
  the Field column names the **section**, `subtext` carries the key ("Sales area 1710 / 10 / 00"), only
  the lead is tickable and editable, and the key fields travel with it as `extras`. Idempotence
  compares **every key field**, with a blank on the existing row counting as a match — the same rule
  `rowMatchesKey` applies server-side. **The `rowKey` is the boundary, not `createsRow`**: grouping on
  `createsRow` collapsed VIES's four independent address fields into one line with only Street editable.
  An unkeyed row-adding entry keeps its own line, its own field name, and still says *Row added*;
  `test/proposal-rows.test.js` pins the address case.
- Duplicate findings survive the dialog in a collapsed, self-scrolling `Panel` (`_setDuplicatePanel`).
  **Only a match ever changes that panel**, and only Duplicate Check and Submit match — findings stand
  until something re-matches and replaces them, including when a check did not run.

### Gating derivations by field property, and re-validating at every gate

Two separate mechanisms, because they answer different questions ("may this be shown" vs "does this
still pass").

- **Gating.** `runDerivations`/`runChecks` take an optional `fieldEditable(target, field)` predicate;
  an entry whose target field it refuses gets **no entry at all** — not written, not reported, not
  offered. A field-less statement is checked with `field` undefined, resolving to the entity's own state
  via `effectiveProperty`'s cascade. No predicate means everything is editable, exactly as before.
  `runRequestChecks` builds it from `fieldState` for the **screen's own** role (narrowed the same way
  `effectiveFieldProperties` narrows it), which is a rendering trust level, not a security boundary.
  Both `checkRequest` and `duplicateCheckRequest` take `RequestType`/`Role`; a caller sending neither
  resolves to `role: null`, matching only `*` profiles. The client sends them from `_checkRole(state)`.
- **Re-validating.** `runSubmitValidations(req, payload)` is the one definition shared by
  `submitRequest`, `resubmitRequest`, `decideDataStewardReview`'s `complete` branch **and
  `decideRequest`'s approve path** (which previously ran none of this). On approve it runs over
  `loadStagedPayload(changeRequest)` — the same `{root, sections}` reconstruction `getRequestPayload`
  does, extracted so the two cannot drift — and a blocking result **rejects the action outright**,
  which is safe because nothing has been written at that point. The reason: the configuration behind a
  rule can have changed since submit.
- **`loadStagedPayload` must always assign an ARRAY** to `sections[section]`, whatever `config.many`
  says. `getRequestPayload`'s bare-object shape for a to-one node is only safe because the *client*
  re-wraps it; `loadStagedPayload` feeds validations directly, and both `relation-checks.js` and
  `node-required.js` silently `continue` on a non-array — so a real Suppliers row was invisible and
  the check reported "no Supplier record" over a row it never looked at.
- **Derivations never run on approve** — nothing there is editable, so there is nobody to show a
  proposal to.
- **`_runPreActionCheck`** (`BusinessPartnerMaintenance.controller.js`) is the client half: `onSave`
  (Submit, Resubmit, and the embedded My Inbox rework action) and `onApprove` call it first, from a
  button press. A validation gate that only speaks when something is wrong reads as "no check
  happened", so it is the **full Check-button experience** — it calls `checkRequest` as `onCheck` does,
  blocks with the same message, and opens the **same** `_offerProposals` dialog (which gained an
  optional `onResolved` callback), waiting for it to close. Two callers share that one vetted dialog;
  never add a second, cheaper way for a proposal to reach the screen. **Never for Approve**
  (`forApprove: true`, also skipping the AI normalisation call) — `decideRequest` takes no `DataJson`,
  so an acceptance would have nowhere to go; checked before the confirm dialog opens.

## The MDM Configuration Panel tile (`app/mdmrules`)

`webapp/ext/view/MDMRuleHub.view.xml` is the landing page: five `GenericTile`s — Duplicate Check
Rules, Validation Rules, Field Properties, Derivation Rules, Workflow Agent Determination.

**Renamed on the screen only.** Every technical id is unchanged: `app/mdmrules`, `sap.app.id`
`mdm.md.mdmrules.manage`, the `MDMRules-manage` inbound and `MDMRules` semantic object, the
`WorkflowRules` entity, the `WorkflowRuleList` route, and the service path `/service/duplicateconfig`
(which keeps its name after growing four more tables).

**It is a second HTML5 app, not a second inbound. SAP Build Work Zone, standard edition exposes only
the FIRST `crossNavigation.inbounds` entry per `sap.app.id`.** Extra inbounds are dropped silently and
never reach the Content Explorer; SAP confirmed this as unsupported. Do not reintroduce a second
inbound, and do not read a missing tile as a deploy problem. A **local copy** in Content Manager was
tried, produced a tile that would not load, and stops reflecting later descriptor changes.

So: unique `sap.app.id` per app, **shared `sap.cloud.service`** (`mdm.md.businesspartner`) so no new
destination/app-host/XSUAA entry is needed, each app's own `xs-app.json` reusing the
`mdm-businesspartner-srv-api` destination, and **one** `com.sap.application.content` module at
`path: .` funnelling all app zips into the same app-host (two content modules pointed at one app-host
each replace the other's content).

**`tools/package-html5.js` does the zipping, and that is not a style choice.** The generator's pattern
(`type: html5` modules with `build-result: dist`, referenced by `<module>.zip`) produced a **22-byte**
`data.zip` here — deploying that would have shipped empty content and **deleted both apps from the
HTML5 repository**. The script refuses to emit a zip under 1KB. Verify before any deploy:
`unzip -l mta_archives/*.mtar | grep -i zip` must show app zips of real size.

The hub is the app root (route pattern `""`) and `Component.js` calls `getRouter().initialize()`
itself — there is no Fiori Elements AppComponent here. Back from the hub is a **cross-app intent** to
`BusinessPartner-manage`, and it no-ops where there is no shell.

**Adding the app does not create the tile.** After deploying: refresh the HTML5 Apps content provider
in Channel Manager, add the app from the **Content Explorer** (it does not appear in Content Manager
until you do), assign it to a group, a catalog and a role, and the role to the site.

### The rule tables

`db/quality-rules.cds` (`ValidationRules`, `DerivationRules`), `db/duplicate-rules.cds`
(`DuplicateRules`) and `db/workflow-rules.cds` (`WorkflowRules`) share a BRF+-style decision-table
shape and are all exposed by `DuplicateConfigService`. Read a row left to right as one sentence:

- Validation — *where `Addresses.Country` = BE, `General.Language` must be `=` NL*
- Derivation — *where `Addresses.Country` = BE, fill `General.Language` with NL*
- Workflow — *a **create** request whose `Addresses.Country` is BE is **approved** by these people*

**Fields are payload fields, not duplicate-catalog fields.** `srv/checks/payload-fields.js` is a
second, different catalog: `srv/ai/duplicate-fields.js` describes bags of *normalised* values for
comparing two partners, while a rule reads and writes the request payload with its real values. It is
**generated from the staging model** (`cds.model`), never listed — add a column to `db/staging.cds` and
the value help has it. Names are qualified and always dotted. `PAYLOAD_NODES` is the single source of
truth for section ids, and `NODES` in `srv/change-request-service.js` is derived from it, so a rule can
never name a section nothing stages.

**The Value column means two things and nothing else says which.** A value resolving to a qualified
catalog field is a **reference**; anything else is a literal — unambiguous because catalog names are
always dotted and a literal never can be. The derivation page's "Copied from …" hint under the cell is
the only feedback that a reference was understood as one; do not drop it. A same-section reference
reads **the same row**.

Semantics worth not "simplifying":

- **An empty field does not fail a comparison** — validations run before derivations, so a rule failing
  on an empty field would block the derivation about to fill it. `notEmpty`/`empty` are the exceptions.
- **Condition scoping is per row on the rule's own section.** A condition on any *other* section is a
  statement about the partner and holds when any row matches. (Workflow rules target no section of
  their own, so every condition there is a statement about the partner.)
- **A rule the engine cannot evaluate blocks**, like a validation that throws.
- **Severity is a column** on validations — without it every validation would block, and a naming
  convention that stops a submit is how people learn to ignore findings.
- **An empty table contributes nothing and does not fall back to defaults.** (The duplicate table is
  the exception: it falls back, because an empty table would switch the control off.)

`srv/checks/rule-store.js` holds rows in memory (60s TTL, dropped on any write) and
`createConfiguredStages` builds **one stage per kind**, not per rule — the pipeline blocks on the first
error a validation stage reports, and a table of twenty rules has to report all twenty.

**The field picker is a dialog, not a ComboBox** (`ext/fragment/FieldValueHelp.fragment.xml`). The
catalog is several hundred fields and `sap.m.ComboBox` filters on the **start** of an item's text. The
dialog searches with `contains` over the qualified code as well as the label, and **the qualified code
is what is stored** — a relabelled field must not turn a saved rule into one that no longer resolves.
**Reset the filter when the dialog OPENS, never when it closes, and read the selection off its binding
context**: resetting a JSONModel list binding re-templates the rows, so an item control asked for its
value after a reset answers for whatever now sits at that position.

**No standing banners on the rule pages.** The remaining strips are `Warning` and conditionally bound —
rules saved but not running, or a duplicate table fallen back to defaults.

Still open on these tables: a custom message per validation row (a generated one ships); rules for
object types other than the BP — when MM arrives, **copy the tables** rather than adding an object-type
column.

**Multiple values per condition were built and withdrawn**, after three deployed attempts failed
(`MultiInput` tokens written with `context.setProperty` never reached the server; a hidden bound `Input`
fixed saving and broke typing; drawing what was written exposed `removeAllTokens` reporting every token
as removed, which **blanked every stored condition value on page open**). The lesson: **a hand-managed
aggregation alongside a bound column is the wrong shape** — whatever comes next must make the binding
the only writer (a child entity with a real list binding, or `sap.ui.mdc`'s multi-value field). What
survives: `srv/checks/value-lists.js` as a READ path (`conditionHolds`, `holds` and `resolveApprovers`
still parse `BE|NL` and OR across it), and the stuck plural names `WorkflowRules.conditionValues`/`2`.
`ListCell.js` was deleted. **`WorkflowRules.approvers` holds one approver; several approvers are
several rows**, which `resolveApprovers` merges.

### Condition slots, and the page mechanics shared by all rule pages

**Five fixed condition slots per rule, and the PAGE decides how many are drawn.** A genuinely unbounded
count needs a composition, which was built, deployed toward and abandoned twice — do not try it a third
time. Columns: `conditionField`/`conditionOperator`/`conditionValue(s)` ×5 plus `conditionLogic`
(1↔2) and `conditionLogic2..4`. WorkflowRules' value columns are plural (`conditionValues`), the other
three singular (`conditionValue`) — a stuck naming difference; nothing reads a column name by
convention, each `CONDITION_PAIRS` names its own.

- **"Add Condition" is table-wide, not per row** — it raises `view>/conditions`; each Column and its
  cells carry `visible="{= ${view>/conditions} >= N }"`. Nothing is written. The ceiling comes from the
  service (`conditionSlots`, from `MAX_CONDITIONS`) so page and schema cannot disagree.
- **A saved rule reveals its own columns** — `_syncConditionColumns` (on `updateFinished` and after an
  import) raises the count to the highest slot any row fills, and **never lowers it**.
  `_setConditionColumns` is the only writer of `view>/conditions`.
- **"Delete Condition" removes the LAST shown slot and CLEARS it** on every row that holds something.
  Hiding alone is not enough — the values stay and the engine goes on matching a condition nobody can
  see. Confirmed first when it would actually throw data away; nothing is saved until Save.
  **Condition 1 is never removable** (a rule with no condition is written by leaving it blank).
- **Widths are rem, not percentages** — a hidden column contributes no share of 100%. The table sits in
  a horizontal `ScrollContainer` (`vertical="false"`) and `view>/tableWidth` gives it something to
  overflow with, because a fixed-layout `sap.m.Table` at `width="100%"` redistributes its columns into
  whatever space it has. `tableWidthFor` is the arithmetic (24rem per condition, 6 per Logic column of
  which there is one fewer, plus `SELECT_REM = 3` for the invisible MultiSelect column). The tests
  that added the declared `<Column width>`s up against it were removed in the 2026-09-02 test cull as
  layout churn, so nothing now catches the two drifting apart — check the arithmetic by hand when you
  add or resize a column. `growingScrollToLoad` is off so the More button still
  works. `_applyTableWidth` is the single setter, which is what stops Add Condition undoing a resize.
- **The engine folds LEFT TO RIGHT, one logic per gap** — `foldConditions` in
  `srv/checks/value-lists.js`. `A OR B AND C` is `(A OR B) AND C`; there is no precedence. Zero and one
  condition behave exactly as before (a lone condition is itself, logic bypassed, so NOR cannot
  invert it) and two under one logic give the identical answer, which is what keeps every stored rule
  matching. `joinConditions` (the older pairwise fold) still serves nothing else that needs it.
  **A blank slot takes its own Logic with it** — `readConditions` drops it and carries each surviving
  condition's own preceding logic.
- **A blank comparator reads as `eq`** (`operatorOf` in `rule-engine.js`, like `conditionLogicOf` for a
  blank Logic) — every row stored before the operator column existed meant equality, so nothing was
  migrated. `empty`/`notEmpty` read the **RAW** value via `sectionRows`, never `fieldValues` (which
  filters empties out before either could see one). `eq` keeps wildcard and `|`-multi-value matching
  (`listMatches`); every other operator is OR across the listed values. The duplicate engine's bag holds
  **normalised** values, so its `is empty` means "no value for that field at all" and its comparators
  compare normalised against normalised.
- **`is empty` / `is not empty` are a COMPLETE condition with no value.** `conditionProblems`,
  `validateRule`/`toEngineRule` (`srv/ai/rule-config.js`) and each page's `_localProblems` all know
  this. The two operators are **named** by a shared constant (`EMPTINESS_COMPARISONS`), not signalled
  over the wire — a served `needsValue` flag that failed to arrive read as `undefined !== false` and
  refused a valid rule.
- **Operator labels are symbols.** `symbolOnly` (in `rule-engine.js`, beside the `COMPARISONS` it
  formats) takes everything before the double space `COMPARISONS` already uses to separate symbol from
  gloss, and returns the word-shaped operators (`contains`, `is empty`, `is not empty`) whole. The
  duplicate page's own `COMPARISON_TEXT` (`Exact — equal after normalisation`) is a different
  vocabulary — how two RECORDS are matched — served alongside as `conditionComparisons`, and untouched.
- **`describeCondition` says which comparator fired.** With five slots it folds left to right using each
  gap's own word, bracketing from the third clause on; the two-clause NOR wording is kept verbatim
  because that is what every row stored before means.
- **The Value cell's expression binding needs `targetType: 'any'`** — inside an expression binding a
  referenced property is formatted into the bound control property's type unless told otherwise, so
  `${dc>conditionOperator}` on a Boolean `enabled` threw `FormatException` on every row and silently
  fell back to the default. Write `${path: 'dc>conditionOperator', targetType: 'any'}`. Applies to any
  expression over the typed `dc` model; the `view>` JSONModel carries no types.
- **Multi-select is `mode="MultiSelect"` and nothing else** — `sap.m.Table` draws the per-row checkbox
  as column 1 and the select-all in the header, so no page declares a `<Column>` for it. Delete and
  Duplicate read `getSelectedItems()`, act in the same `ruleChanges` group so one Save writes them
  together, then `removeSelections(true)`. The confirmation counts what it is about to delete.
- **Column resizing is `ext/util/ColumnResizer.js`**, shared. `sap.m.Table` has no resizing of its own,
  so the grip is a real `<div>` on the right edge of each `<th>` dragged with plain mouse listeners.
  **What is draggable is the BORDER between two columns, never the column itself** — there is no
  reordering and no `dragDropConfig` anywhere near these tables, and a test pins that. The drag ends in
  `Column#setWidth`, not an inline style (every keystroke in a bound cell can re-render), and handles
  are re-installed on `onAfterRendering`. Header cell → column is **by id first, by position second**
  (zipped against the *visible* columns). A resize widens the TABLE by the same delta
  (`_onColumnResized` → `/widthAdjust` → `_applyTableWidth`), keeping a `calc(<n>rem ± <n>px)` so the
  rem half still follows the page font. Field Properties passes no `onResize` — it is 100% wide with no
  horizontal scroll. The handle needs `webapp/css/style.css`, registered as `sap.ui5/resources/css`;
  `position: relative` on the `<th>` is set from JS rather than by matching a private theme class.
- **"Delete Rule" sits beside "Add Rule"** (Field Properties says "Delete Profile"): a bare "Delete"
  two buttons along from "Delete Condition" left the toolbar with two deletes and no word saying which
  removed a row.
- **Save cannot claim what it did not do.** `hasPendingChanges` answers for one update group, so a
  create that never travelled leaves it false and the toast reports a save that did not happen.
  `_transientRows()` asks the rows directly. **That guard had a race**: `submitBatch`'s promise can
  resolve before a freshly created context has flipped out of `isTransient()`. So `onSave` captures
  `_transientRows()` **before** the submit and, once `hasPendingChanges` has ruled out a genuine
  rejection, awaits each row's `context.created()` (each `.catch(() => {})`) before asking a second
  time. Applied to all four rule pages.
- **Duplicate a rule** — `STRIP_ON_COPY` (`ID`, `@odata.etag`, `createdAt`/`By`, `modifiedAt`/`By`) then
  `binding.create(copy)`. Nothing is saved automatically.

### Excel import/export (`app/mdmrules/webapp/ext/util/XlsxCodec.js`)

A real `.xlsx`, hand-rolled with **no new dependency**, mirroring BRF+'s own decision-table up/download:
one worksheet, bold frozen header row, one data row per rule. A `.xlsx` is a ZIP of OOXML parts and the
container needs only STORE entries to be valid, which sidesteps DEFLATE on export; inline strings
(`t="inlineStr"`) sidestep `xl/sharedStrings.xml` on write.

- **Reading back must cope with what real Excel saves**, which is a different shape: always DEFLATE
  (method 8) and always `xl/sharedStrings.xml` once a file has been opened and re-saved. Decompression
  uses the browser's `DecompressionStream('deflate-raw')`, so import is async where export is not.
- **A targeted XML scanner (`matchTags`/`parseAttrs`), not `DOMParser`** — it keeps every read-path
  function runnable and testable outside a browser.
- **The attribute group must be lazy (`[^>]*?`).** Real Excel writes an empty cell as
  `<c r="D3" t="inlineStr" />` and a greedy group swallows the trailing `/`, so the tag reads as OPEN and
  consumes the next cell's content — silently shifting every column after it.
- **`xmlUnescape` is applied at each leaf text node (`<t>…</t>`)**, separately from attribute values and
  never inside the generic tag scanner (which also returns markup that must not be decoded twice).
- **Columns are matched by header LABEL, not position**, so a reordered or trimmed copy re-imports.
  `ID` is not a column on any page — nothing reads it on either side of the round trip.
- **Import REPLACES the table wholesale**: delete every row on the page, create a fresh row for every
  non-blank file row. No ID matching. A header-only file clears the table. **Import never saves by
  itself** — the existing Save/Discard flow and `_localProblems` still have the last word.
- **`isActive` is read tolerantly** (`true`/`1`/`yes`/`x`, case-insensitive, and a real `t="b"` cell).
- Each page owns its own `xlsxColumns()` (mirroring its own table; `sequence`/`threshold` are left out
  where they are not columns on screen) and its own `_applyImportedXlsx` (the "does this file look like
  this table's export" check differs per table). `buildWorkbook` takes `sheetName` so each export names
  its own tab.
- Tested at two levels: `test/xlsx-codec.test.js` loads the module by `new Function`-wrapping the AMD
  factory — **not** `vm.createContext`/`runInContext`, which creates a separate JS realm and makes
  `assert.deepEqual` fail on structurally identical arrays. Each page's own test file tests that page's
  columns and wholesale-replace behaviour.

**The controller glue (`onAddCondition`, `onDeleteCondition`, `_setConditionColumns`,
`_syncConditionColumns`, `STRIP_ON_COPY`, `xlsxColumns`, `_localProblems`) is duplicated across the four
pages deliberately** — heavy shared machinery is extracted (`XlsxCodec`, `ColumnResizer`), per-page
wiring reads better beside the page it wires. If a fifth table ever needs it, extract it then.

### Check Current Data (`srv/checks/data-scan.js`)

The Validation Rules page's counterpart to the duplicate tile's "Test Against Current BPs": run the
**saved** ruleset against the partners that exist.

- **Knows nothing about S/4** — readers are handed in (`readPartners()`, `readSection(section,
  partners)`), like `srv/ai/name-index.js`, so it is testable with plain objects.
- **Runs `runValidationRule`, the engine itself.** A scan judging the data by its own reimplementation
  would be a second answer to the same question.
- **Only the sections the ruleset actually reads are fetched** (`sectionsUsedBy` walks each rule's field
  and its five condition fields); `General` arrives with the partner.
- **The customer/supplier tree is read by the number `A_BusinessPartner` itself carries**, never by the
  partner number — CVI does not guarantee they are equal (the same reason `resolveRelationNumber`
  exists). `scanKeyFieldFor` derives the key column from `MAINTENANCE_ENTITIES`'
  `parentKeyField`/`parentKeyFields`, covering all 31 sections without a second hand-kept map.
- **Every column of `A_BusinessPartner`, no projection** — a rule may name any General field.
- **A section that could not be read is NAMED in the report**, never treated as empty.
- **Findings and flagged partners are counted separately**; rules are ordered loudest first.
- **Capped at `MAX_PARTNERS` (2000) and refused above it** rather than answered on a slice
  (`testRuleset` makes the same call at 5000 for its own pairwise cost).
- **Delegated to `BusinessPartnerService`** from `DuplicateConfigService`, like `testRuleset` — one S/4
  connection. With no `RulesJson` it runs what is stored.

Derivation deliberately gets no such button: it fills empty fields on the request in front of you, and
there is no population-wide verdict to preview.

## Field property profiles (`db/field-properties.cds`)

A profile says what a request may, must and must not show: **mandatory, read-only, hidden or optional**,
per entity and per field. Conditions are two dropdowns on the profile row — **CR type** and **role**,
both taking `*`. Content lives behind **Modify**: a dialog listing every entity, expandable to its
fields, four checkboxes on both levels.

- **One state per target, not four flags.** The boxes behave as a radio group; the stored row carries a
  single `property`, so nothing downstream resolves a contradiction that should never have been
  storable (`hidden`+`mandatory` is unsubmittable, `readOnly`+`mandatory` only a derivation could
  satisfy).
- **Absent is not `optional`.** A field with no row is not mentioned; `optional` is an explicit override,
  which is what lets a narrow profile hand a field back after a broader one made it mandatory.
- **The dialog replaces the whole profile** (`saveFieldProperties` deletes and rewrites). An unknown
  entity, field or property is **refused**, not filtered.
- **The entity/field tree is generated** by `srv/checks/field-properties.js` from `payloadFields()`.
  The condition lists are closed and served from the same module.
- **Modify saves the profile first** — settings hang off a saved profile.

### Applying them

**Where two profiles match, the broadest result wins** — a **join over three axes** (visible / editable
/ required), not a ranking, because `mandatory` and `readOnly` are not comparable. Visible or editable
if **any** matching profile allows it; required only if **every** profile that speaks demands it.

| Profile 1 | Profile 2 | Result |
| --- | --- | --- |
| hidden | readOnly | readOnly |
| mandatory | readOnly | **optional** |
| mandatory | optional | optional |
| hidden | mandatory | optional |

`PROPERTY_STATE` is the whole rule and the join is closed over the four names
(`test/field-property-apply.test.js` proves it exhaustively). **Nothing reads a precedence** — the grid
shows no Order cell and the resolver never sorts. **Silence is not `optional`**: a profile saying
nothing about a target is left out of the join entirely.

**Only `hidden` and `readOnly` cascade from an entity to its fields** — they describe the container. An
entity's `mandatory` is about whether it needs a **row** at all.

Two halves, deliberately not one code path:

- **Rendering** — `effectiveFieldProperties(RequestType, Role)` on `ChangeRequestService`, loaded by the
  maintenance controller **before the first render** (rendering is synchronous; a field painted and then
  taken away is worse than one never drawn). `hidden` drops the field from both layouts entirely and a
  hidden entity hides its whole `ObjectPageSection`. `readOnly` takes editability away and can never
  grant it. `hidden` is deliberately honoured on the approve view — once approvals are split by
  function, a sales approver has no business reading bank details.
- **Enforcement** — `createFieldPropertyStages` adds a `field_properties` validation to Check, Duplicate
  Check, submit and resubmit, reading the cascade back first. Without it a profile is a star on a label
  a direct service call walks past. It runs on `requesterContext(req)`, always `Requester`, and is the
  security-relevant half.

**"Both layouts" includes the section's own summary table**, not just the record dialogs:
`_renderSection` filters `_summaryFields` through `_isHiddenField` the same way `_createFieldGrid`/
`_createFieldTable` already do, so a hidden field is gone from the column list, the cells and the search.

### Roles are BTP role collections, by naming convention

A profile's role is one of `*`, `Requester` (the only two non-role-collection concepts left in
`ROLES`/`ROLE_TEXT`), or a BTP role collection name.

- The picker sources from `workflowAgents()` filtered to `type === 'Role'` — a profile's role condition
  is about an actor kind, so users stay out of this picker. **The bare `MDMLIGHT` collection is excluded
  here only** (it is the catalog-level role for the whole app; offering it would scope a profile to
  "everyone with any access" while looking like a narrow choice).
- **A role matches the screen's category by a case-insensitive PREFIX, checked BIDIRECTIONALLY**
  (`profileMatches`). `ApproverSales` counts as an Approver-category profile, and once the screen
  resolves a *specific* role the bare category must still match it (`"Approver".startsWith("Approver
  Customer")` is false), while two different specific roles stay apart. `LEGACY_ROLES`
  (`['Approver', 'DataSteward']`) keeps the write guard accepting the literal values stored before this,
  and an exact match is checked before the prefix.
- **Rendering is narrowed to the caller's own specific role.** `resolveEffectiveRole`
  (`change-request-service.js`) resolves `Approver`/`DataSteward` (`RESOLVABLE_ROLE_CATEGORIES`) to the
  caller's own collection via `specificRoleFor(email, category)` (`srv/wf/btp-agents.js`) before
  `effectiveFieldProperties` runs — without this, `Approver Customer` (hides Suppliers) and `Approver
  Vendor` (hides Customers) both matched every approve screen and the join landed on "visible for both,
  for everyone". **Ambiguous resolves to null, not a guess** (several matching groups, or none), falling
  back to the bare category. Best-effort. **Only the rendering path** — enforcement still runs on
  `requesterContext(req)`.

### Critical entities

- **Critical is entity-level only.** `validateSetting` refuses a row carrying both `element` and
  `critical: true`; the dialog greys the box on a field row and `onCriticalSelect` guards it again.
  `resolveProfiles` still *reads* an older field-level row rather than dropping it, and `_buildTree`
  never carries one back, so such a profile self-migrates on the next Apply.
- **Critical is a marker, not a gate.** `createFieldPropertyStages` enforces `mandatory` only; a first
  version that blocked an empty critical entity was rejected.
- **Drawn on the screen, not written as a message** — `_isCriticalEntity` reads `criticalEntities` off
  the already-loaded properties and `_markSectionCritical` appends "⚠" to the Object Page section title.
  Applied in `_renderSection` for the nine node sections and in `_renderRootForm`/`_renderRootSection`
  for the two cards the root splits into (both render the same `General` section).
- **Critical is Requester-scoped and reflected read-only everywhere else.** A request carries one set of
  critical entities for its lifetime, decided by whoever files it. `resolveProfiles` computes it from a
  **separate** matching set (`criticalMatching`/`criticalIds`, re-running `profileMatches` against
  `role: 'Requester'`) independent of the caller's own role. The Modify dialog computes
  `canEditCritical = !role || role === "*" || role === "Requester"`, guards both the checkbox binding and
  `onCriticalSelect` with it, and `_settingsFromTree` multiplies every `critical` it sends by that flag —
  **Apply on an Approver profile must not copy the Requester profile's flag into it.** Other roles' dialogs
  still SHOW the box, disabled, fed by `fieldPropertiesOf`'s `{ settings, requesterCritical }` (which
  reuses the exact runtime resolution the maintenance screen reads "⚠" from).
- `srv/checks/field-property-store.js` caches profiles for 60s, dropped on any write.
- **Watch the read column lists.** The Critical checkbox silently stopped saving because
  `fieldPropertiesOf`'s SELECT omitted `critical` — the save side had always been correct.

## Workflow Agent Determination (`db/workflow-rules.cds`)

Produces the `approvers` list in the workflow context; SBPA routes on it.

- **The table decides WHO, never how many approvals or in what order.** CAP does not check that a role
  exists either — roles live in SBPA and a copy here would go stale.
- **An entry carrying an `@` is a user, anything else a role.** `resolveApprovers` returns
  `{ step, kind, value }`; the wire carries a flat array of the values (see below). The two halves are
  entered differently on purpose: an address is free text, a role has to be spelled as SBPA knows it, so
  the cell takes typing *and* offers a value help. The condition cells deliberately do not get it.
- **Rows are additive** — every matching row contributes, nothing needs ranking, and there is no order
  column. **Several approvers means several rows**; `resolveApprovers` de-duplicates on step + value.
- **All four CR types plus `*` ("Any").** Unlike the field property profiles' closed list this table
  offers `block`/`delete`, because saying who approves one early is harmless (`SUPPORTED_REQUEST_TYPES`
  gates what can be submitted). `*` is an explicit value a steward picks, not a default for a blank type,
  and a `*` rule and a specific-type rule both contribute for a request matching both.
- **`step` carries only `Approve`** — a column rather than an assumption, because the next version of
  this table describes whole request types with several steps each.
- **Empty is a legitimate answer** — no rule matched, empty table, or unreadable: all `[]`, which is what
  every submit sent before this table existed.
- **Resolved in `workflowContext()`**, after the validations and the duplicate gate, and rebuilt after a
  rework so a resubmit routes on the payload the requester fixed.

### The approver picker is sourced from the subaccount (`srv/wf/btp-agents.js`)

The subaccount's own **role collections** and **users**, read live from the BTP Authorization Management
API — not this app's `ROLES` list, which is a different question (`ROLES`/`ROLE_TEXT` are untouched and
still serve the Field Property Profiles page).

- Role collections are filtered to those whose **Description** starts with `MDMLIGHT`
  (`ROLE_COLLECTION_PREFIX`) — **Description, never Name**: the prefix is a convention applied to text an
  admin writes. Users are named by e-mail, falling back to the username.
- **A second, separate XSUAA instance**: `mdm-businesspartner-authmgmt` (plan `apiaccess`, in
  `mta.yaml`), because the app's own `mdm-businesspartner-auth` (plan `application`) has no access to
  that API. Its key carries `clientid`/`clientsecret`/`url` plus **`apiurl`** — a fixed region-wide
  address, not this tenant's login URL; `btp-agents.js` refuses to guess one when it is missing. Being a
  **managed** service its credentials land under VCAP's `xsuaa` group, not `user-provided`.
- A broad, subaccount-wide read credential; `btp-agents.js` is the only module that ever sees it.
- Best-effort, cached 5 minutes (`TTL_MS`). The two lookups fail independently.
- **The F4 dialog is a real two-column table** (`RoleValueHelp.fragment.xml`), not `sap.m.SelectDialog`
  — that control wraps a plain `sap.m.List` with no column headers, and *Type* vs *Name / E-mail* is
  exactly the distinction a combined picker must make visible. `onRolesChosen` reads the entry off its
  binding context before anything touches the list.
- **`Agent { type, value }`** is the CDS type on `WorkflowRuleOptions.agents`.

**Two BTP API facts, live-tested rather than assumed:**
`GET /sap/rest/authorization/v2/rolecollections` already returns each collection's roles inline as
**`roleReferences`** — there is no detail call to make, and `detail.roles` does not exist. And
`GET .../users/{name}/rolecollections` answers empty for a user confirmed to be a member of two
collections; `GET /Users` returns membership inline as **`groups`** (`[{value, display, type:'DIRECT'}]`).
`test/data-stewards.test.js` pins both shapes. Diagnosed by running a script as a one-off `cf run-task`
against the bound credentials (the same env-var-passthrough trick `tools/wipe-staging.js` uses).

## Workflow / SBPA integration

`srv/wf/processAutomation.js` talks to SAP Build Process Automation through the `SBPA_DESTINATION` CDS
requires entry (a `rest`-kind destination). It gets an OAuth2 client-credentials token from the
`mdmlight-bpa-uaa` user-provided service (cached until near expiry) and an API key, then POSTs a
workflow-instance start with `irpa-api-key` and bearer headers. `mdmlight-bpa-key`/`mdmlight-bpa-uaa`
are CF user-provided services bound in `mta.yaml`.

**Known bug, not fixed:** it reads `apiKey` from `mdmlight-bpa-uaa`, which holds
`clientid`/`clientsecret`/`url`. `mdmlight-bpa-key` is bound and never read, so `irpa-api-key` goes out
`undefined` and the workflow start fails. Because `submitRequest` deliberately leaves a request in
`draft` when the workflow will not start, the symptom is staging rows at `draft` with no approver task —
that is the guard working. Confirm with Arthur which service holds the key.

### Decide and post

- **`decideRequest` records an outcome and, on approve, creates the business partner.** It writes
  `approved` first, then posts: success → `posted` with the number; failure → `reworkRequired` with the
  reason in `postError` and in the action's `ErrorMessage`. `reject` → `reworkRequired`. It is not
  terminal.
- **`completeRequest` is the same step for SBPA's callback**, made a no-op by its `postedBP` guard once
  approve has run. **Both entry points call one `postAndRecord`.**
- Individual approvals are not stored anywhere in CAP, by decision.

Three traps found wiring this, all still load-bearing:

- **A status write immediately before `req.reject` never persists** — `req.reject` throws and CAP rolls
  the transaction back. That is why a failed post is **returned** as `ErrorMessage` with
  `Status: reworkRequired` rather than rejecting the action.
- **A partial post must not create a second partner.** `postToS4` persists the number the moment S/4
  hands it over — before the child nodes, which can still throw — and `isCreate` is
  `requestType === 'create' && !businessPartner`.
- **…nor re-create a child node S/4 already has.** `postToS4` flips a successfully-created row's own
  `action` to `'U'` right after the save, and removes a successfully-deleted row from staging entirely.
  Only `header.businessPartner` and `ROLE_NODES` were retry-safe before (the latter because their
  `isCreate` reads `relationValue == null`).
- `completeRequest` once threw a ReferenceError on every completion by calling `notifyWorkflow`, a
  `const` declared inside the `decideRequest` handler. `test/approve-posts.test.js` pins that it is only
  called where it is declared.

**Signalling the outcome.** The parked instance is told the result through its own trigger,
`waitForResult`, whose inputs are exactly `businesspartnerid`, `businesspartnerfullname`, `status`
(`success`/`error`) and `errormessage`; `executionId` is `ChangeRequests.processInstanceId`. It has no
`result` key, so it cannot go through `sendTrigger` — `triggerPostResult` posts it through the same
destination. `SignalWorkflow: false` (the task form saying completion already delivers the decision)
deliberately does **not** silence this: the decision and the result are different waits. Best-effort.

**Several approvers, sequentially.** BPA routes through multiple approver tasks and only the last should
decide anything in CAP. **CAP still knows nothing about this**; `app/bptask` decides whether to call
`decideRequest` at all. BPA maps two optional task inputs, `currentapprover` and `totalapprovers`
(1-indexed), and `_isFinalApprover(context)` is `current >= total` — absent, or unparseable, reads as
"the only approver". `_completeTask("approve")` skips `_decideOnServer` when not final and only completes
the one task, which is what BPA reads to advance. **Both inputs are declared in `app/bptask`'s manifest
but its `applicationVersion` was put back to `1.5.0` on 2026-09-02 (`3f5bf77`), the version that
predates them** — so until the task is re-pointed at a new version the Lobby serves the old schema,
neither input becomes context, and every approver reads as the last one: the FIRST approver decides and
posts. `test/task-form.test.js` pins `1.5.0` and records the drift. Raise the manifest and that pin
together once Arthur re-points. **Reject is never gated** — a chain of approvals is not
a chain of independent decisions. The shared screen's own `onApprove`/`_decide` need no gate: embedded,
`_addInboxActions` wires the buttons straight to `_completeTask`, and standalone there is no real chain.

### Rework — the requester's screen

A rejection is a **loop, not an end**. `ChangeRequests/{id}/rework` renders the same maintenance screen
in mode `rework` — the draft view with **Resubmit** as the primary action and Withdraw beside it.
`state.mode` is what `onSave` routes on.

- **Two entry points**: the `reworkurl` deep link (sent by SBPA with the *initial* workflow context) and
  a My Inbox task whose input carries `tasktype: "rework"`. A task with no `tasktype` still opens the
  approver's screen. The screen must cope with a link opened twice.
- **My Inbox does not render an embedded app's `sap.m.Page` footer at all.** Anything that must be
  pressable on a task goes in the header actions or through `inboxAPI.addAction`.
  - **Check/Duplicate Check live in the object page header actions regardless of `env>/embedded`** — on
    a long create form the footer is a scroll away from the fields being filled in. Neither is a
    declared outcome, so the header was always the only way to reach them embedded.
  - **Resubmit/Withdraw go through `inboxAPI.addAction`** (`_addReworkInboxActions`), the same native
    action bar as Approve/Reject. Pressing one publishes on the `"taskform"` event-bus channel; the
    shared controller (subscribed in `onInit`) runs the real `onSave`/`onWithdraw` flow, and the task
    completes only after that succeeds, via `_completeEmbeddedOutcome` calling `completeOutcome` on the
    task app's Component. The footer copies hide on `env>/embedded`.
- **Resubmit resumes, it does not restart.** The instance stays parked and `resubmitRequest` signals it
  with `RESUBMITTED_SIGNAL`. A request with no `processInstanceId` is refused rather than given a fresh
  workflow, which would hand it two audit threads. **A failed signal no longer blocks the resubmit** —
  it fails with `bpm.workflowruntime.rest.message.no.match` even for valid reworks because the parked
  instance is not waiting on `requesterCallBack`, which is a BPA-side gap. What resumes the process is
  the rework **task completing**. `resubmitRequest` returns `ContextJson` so that PATCH can carry the
  reworked data as the task's own output.
- **Resubmit runs every gate a first submit runs** — the requester may have changed the very fields the
  duplicate check reads. Derivations still do not run on a submit path.
- **The approver's comment goes to `rejectionComment`, never over `reason`** — the requester would
  otherwise find their own justification replaced by the verdict on it. The strip **points at the
  conversation panel** rather than repeating the text; `state.rejectionComment` is read for truthiness
  only, to tell "a reason was given" from "none was recorded".
- **Comment boxes**: `approverCommentBox` is embedded-only (`context>/comment`, a model only
  `app/bptask`'s Component sets). `reworkCommentBox` and `dataStewardCommentBox` bind to
  `maintenance>/…` and work standalone too (the deep links reach those screens directly); the rework one
  is sent as `resubmitRequest`'s `Reason` and echoed into the panel locally after a successful resubmit.
  All three sit **right after the conversation panel** — at the bottom of the content they were cut off
  (My Inbox does not reliably give an embedded app's lower content room).
- **The full conversation, not just the latest word.** `ChangeRequestComments` is append-only
  (`role` + `author` + `text`); `decideRequest`/`resubmitRequest` write to it **in addition to** the
  legacy `reason`/`rejectionComment`. Returned as `CommentsJson`, rendered as `commentsPanel` (oldest
  first) on every mode with a thread — approve, rework, view, draft — and it is the **last** panel above
  the form.
- **`claimRework` is a stopgap for the missing reject callback.** SBPA notifies the requester and never
  calls `decideRequest`, so the request is still `inApproval` when the rework screen opens and every
  downstream gate refuses. It moves `inApproval` → `reworkRequired` **on the rework route only**,
  treating arrival as the evidence. No-op on any other status, refuses a request carrying `postedBP`, and
  deliberately sends **no** workflow signal. **Accepted cost:** the link stays in the mailbox, so clicking
  it again after a resubmit pulls a live approval back into rework. **Delete the handler, the controller
  call and their tests once Arthur's rejection branch calls `decideRequest`** — that path carries the
  comment this one cannot ("No reason was recorded with it").
- **`reworkRequired` is an ACTIVE_REQUEST_STATUS** — the requester is about to edit and resubmit.
- **No Save Request in rework**: it drops the screen out of editing and offers Edit, which re-enters
  `edit` mode, and `onSave` would then route to `submitRequest`, starting a second workflow.

**Withdraw deletes.** `withdrawRequest` removes the staged children explicitly then the header, rather
than trusting the compositions' cascade through the hand-written `ON` backlinks. Two load-bearing
guards: a request carrying `postedBP` can never be withdrawn, and only `draft`/`reworkRequired` are
withdrawable. **Idempotent** — a missing request returns `Deleted: false`, not a 404. The workflow is
told (`'withdrawn'`) before the delete, best-effort.

### Data steward enrichment

A third loop, parallel to rework: a steward is handed a request mid-approval to add or correct data, then
sends it back — to the approver if they made it work, to the requester if not.

- **`checkAndEnrich` is its own status**, not a value of `reworkRequired`, and joined `EDITABLE_STATUSES`,
  `ACTIVE_REQUEST_STATUSES` and `IN_PROGRESS_REQUEST_STATUSES`. `WITHDRAWABLE_STATUSES` aliases
  `EDITABLE_STATUSES` (test-pinned), so a steward may withdraw — accepted, though no UI offers it.
- **`claimDataStewardReview` is `claimRework`'s pattern**: arrival (via the `datastewardurl` deep link or
  a task carrying `tasktype: "datasteward"`) moves `inApproval` → `checkAndEnrich`, no signal sent.
- **`decideDataStewardReview` is two existing shapes under one action.** `'complete'` is
  **`resubmitRequest`'s body** — persist, the same gates, `Confirm` included, rebuild the context, hand
  the same parked instance back to `inApproval`. `'reject'` is **`decideRequest`'s reject branch** —
  straight to `reworkRequired` with the steward's note on `rejectionComment`, back to the requester,
  never to the approver who never asked the steward anything.
- **Both handlers are placed after `withdrawRequest`**, not beside `claimRework`: several tests slice
  `serviceJs` from `resubmitRequest` to `withdrawRequest` expecting an exact shape.
- Two signals, `DataStewardComplete`/`DataStewardRejected`, are **unconfirmed placeholders**;
  `triggerRequesterCallback` carries all four, told apart by `result`.
- The screen is the same shared screen in a fourth mode (`"datasteward"`), route
  `ChangeRequests/{id}/datasteward` in both `app/businesspartner` and `app/bptask`. Editable like rework
  but with `showSaveButton`/`showSaveRequestButton` both false — only the two decision buttons. The field
  property profile is read under `DataSteward`.
- **Two buttons.** *Complete Review* goes through `_sendChangeRequest("decideDataStewardReview")`, so it
  gets the same Check/duplicate-confirm dance as Resubmit, then `_completeEmbeddedOutcome("enrich", …)`.
  *Reject* is a plain decision (`onRejectDataStewardReview` → `_declineDataStewardReview`), mirroring
  `onReject`/`_decide`.
- **Outcome ids are `"enrich"` and `"reject"`.** `sap.bpa.task.outcomes` is one flat array across every
  task type and an id only has to be unique **within** it: `_addInboxActions` and
  `_addDataStewardInboxActions` both register `"reject"` with their own callbacks, safe because
  `_initTaskForm` picks exactly one branch per task. Both publish on the event bus rather than calling
  `_completeTask` directly.
- **Nothing on Arthur's side routes a task to a data steward yet** — which condition sends a request
  here, how the parked instance waits for the two signals, and re-pointing the Lobby's user task.

### `datastewards` and `approvers` on the wire

`workflowContext` sends **`approvers` as a flat array of strings**, not the structured list
`resolveApprovers` returns — the deployed process declares an array of strings and the runtime validates,
so sending objects failed **every submit** with `/approvers/0 The value must be of string type`. The
`.map` sits in `workflowContext` and nowhere else. What is genuinely lost is `step` (two steps arrive as
one list); restoring it is a process-side schema change, **not** a one-sided fix here. `kind` is not
lost, only implicit.

**Role names are sent unresolved**, and so are `datastewards` (`dataStewardRoles()` — the *names* of the
role collections carrying this app's `DataSteward` role template). This is true only because **Arthur's
process resolves BTP role collection membership itself**. Do not read it as a general rule: if a process
that does not is ever swapped in, this reverts to expanding them via `emailsForRoleCollections`
(`srv/wf/btp-agents.js`, still live and still used by `dataStewardEmails`). The tell is a task landing
with an approver list of one unresolvable string. `srv/wf/data-stewards.js` genuinely needs both shapes,
permanently: `dataStewardEmails` for `processorsFor`'s human-readable strip, `dataStewardRoles` for the
wire — separate cached functions, not one with a flag.

**`criticalfield`** (lowercase on the wire, like every key in this context; the local variable stays
`criticalField`) is a **scalar `'X'`/`' '`**, never a list and never one entry per entity.
`workflowContext` answers one question: does this request fill in **any** entity a **Requester-scoped**
profile marks critical? It reads `resolvedProperties(requesterContext(req)).criticalEntities` and checks
each with `sectionRows`. SBPA is told *that* something critical was filled in, never *which* — the "⚠" is
where a human sees that.

**Still open:** wiring SBPA to actually consume `approvers` — Arthur's definition ignores the field, so
the table is inert until his process assigns its approver task from it.

## The task app (`app/bptask`) and the approve screen as a BPA UI5 Task Form

Freestyle UI5, `sap.app.id` `mdm.md.businesspartner.task`, shared `sap.cloud.service`, its own
`xs-app.json`, one more entry in `tools/package-html5.js`. It used to be the Fiori Elements app with
`sap.bpa.task` in its manifest; SAP documents UI5 task UIs for **freestyle** apps only. It declares **no
`crossNavigation` inbound**, deliberately — My Inbox resolves a task UI by `sap.cloud.service` +
`sap.app.id`, so the one-inbound-per-app limit never applies and it needs no tile, catalog or role.

What stayed in `app/businesspartner`: the List Report, object page, `CustomActions` toolbar wiring, and
the `?changerequestid=` deep link. What left: `sap.bpa.task`, the `inboxAPI` actions, the task context
load and the completion PATCH. The `env>/embedded` model stays set — to `false`, always — because the
shared view binds it to decide whether to draw its own decision buttons.

- **Outcome labels are literal text, not `{{…}}` keys** — `{{Approve}}` resolves out of the app's own
  i18n bundle, which is not where the Lobby looks. `test/task-form.test.js` pins the labels. `inputs`
  and `outputs` declare the task context for the Lobby; the runtime reads none of it.
- **Re-pointing the user task in the Lobby is a manual step** whenever the app id changes.
- **Never put a comment key in `app/businesspartner/xs-app.json`** — it is schema-validated in the HTML5
  repository, and an unknown property makes the whole app version unservable: every resource returns
  **500** and the app fails with `adding element with duplicate id '<app id>-content'`, which names
  nothing relevant.
- **`app/businesspartner/xs-app.json` needs `^/api/(.*)$` as its FIRST route**, to
  `com.sap.spa.processautomation` / endpoint `api`. Without it the form loads and every workflow call
  404s.
- The workflow base URL is **derived**: `/{sap.cloud.service}.{sap.app.id}/api/public/workflow/rest/v1`,
  dots stripped. `test/task-form.test.js` pins it.
- **Verifying `manifest.json` over HTTP proves nothing about what is running.** `build:cf` uses
  `ui5 build preload` and `Component-preload.js` **embeds the manifest** — the runtime reads it from the
  bundle. To test a change, disable the browser cache or move the app version.
- **The OData `dataSources` need the DESTINATION SERVICE INSTANCE GUID as a path prefix.** Without the
  leading UUID the approuter cannot tell which destination service instance to resolve
  `mdm-businesspartner-srv-api` from, and `/service/*` answers 500. It is the instance GUID of
  `mdm-businesspartner-destination-service` (`cf service … --guid`) — **not** a Work Zone content
  provider id (those are ≤20 alphanumerics/dots/underscores, so never a 36-char UUID) and not the
  app-host GUID. `/api/` never needed it because it resolves a **service**, not a **destination**.
- **The prefix is carried in the TASK CONTEXT, because nothing else can carry it.** `workflowContext()`
  sends `prefix`, read out of `VCAP_SERVICES` by `srv/ui-prefix.js`; `_initTaskForm` reads it and
  `_appPath()` composes `/{prefix}.{sap.cloud.service}.{sap.app.id}/` in front of the still-relative
  `dataSources` uri. **`manifest.json` declares no OData model** (a `dataSource`-backed one is built at
  init, before any context exists). Only the GUID crosses the wire, not the whole path.
  **Ordering is the design**: `_loadPermissions` and `getRouter().initialize()` live in `_begin()`, which
  runs only once the prefix is known. Standalone calls `_begin("")`. **A task with no `prefix` is
  reported, never guessed.** `UI_PATH_PREFIX` overrides the lookup by hand.
  Two routes ruled out, recorded so nobody re-runs them: (1) deriving it from the component's own load
  URL — tried and reverted, the resource root is versioned and **unprefixed**; (2) routing `/service/*`
  as a business service — only works for a service whose VCAP credentials publish `sap.cloud.service`
  and `endpoints` via the broker's `onBind` hook, which a plain CF app behind a destination is not.
  Build-time substitution is impossible in one pass: the destination service instance is a resource of
  this same MTA, so its GUID does not exist until the first deploy finishes.
- **`app/bptask`'s `dataSources` are ABSOLUTE on that derived path; `app/businesspartner` keeps relative
  uris.** Embedded in My Inbox the app is served from the HTML5 repository at its **version-stamped**
  path where `/service/*` is not proxied, so a relative uri answered 500 without ever reaching CAP
  (nothing in `cf logs`). Statics come from the versioned path; the approuter applies `xs-app.json` on
  the **unversioned** one. Do not "make them consistent".
- Completion is `PATCH task-instances/{id}` with `status: COMPLETED`, the context and `decision`, after
  fetching an `X-CSRF-Token`. **Order matters**: `decideRequest` runs *before* the PATCH, because
  completing the task resumes the workflow. `decideRequest` is passed `SignalWorkflow: false`.
- Embedded, `window.location` is the **host's** — the change request id comes from the task **context**,
  never the hash.
- **A service model is read through `_serviceModel()`, never straight off the view.** The handover calls
  `_loadStagedRequest` from `onInit`, and a view has not inherited its component's models at that point,
  so `getView().getModel("cr")` is `undefined` and the first action call throws "Cannot read properties
  of undefined (reading 'bindContext')". The accessor tries the view first, then the component.

Still open, Julien's call: a failed post from My Inbox completes the task anyway.

### Contract the SBPA side depends on

Changing any of these breaks Arthur's process definition — agree the change first.

- Approver task URL: `<app-url>#/ChangeRequests/{changeRequestId}/approve`
- Requester rework URL: `<site-url>#BusinessPartner-manage&/ChangeRequests/{id}/rework`
- Data steward review URL: `<site-url>#BusinessPartner-manage&/ChangeRequests/{id}/datasteward`
  (sent as `datastewardurl`, not yet used by any process definition)
- **Both deep links are Work Zone intents, not approuter paths.** The managed approuter serves the app
  through the Work Zone site, so a link is the site URL plus a cross-navigation intent with the app's
  route after `&/`. The base comes from **`WORKZONE_URL`** (a literal in `mta.yaml`, from Site Manager);
  `APPROUTER_URL` is deliberately no longer read — it stayed set on the deployed app and kept producing
  the dead standalone host, so unset now yields `''` and a missing link is diagnosable where a 404 is
  not. The intent must match the `BusinessPartner-manage` inbound.
- Workflow context at submit:
  `{ changerequestid, requesttype, businesspartner, emailadressinitiator, bpurl, reworkurl,
  datastewardurl, prefix, businesspartnerinput, bpduplicates, approvers, criticalfield, datastewards }`
- **`prefix` must be mapped onto the approval AND rework task inputs.** Declared in `app/bptask`'s
  `sap.bpa.task.inputs` as an optional string. **An undeclared key never becomes task context**, so
  sending it is not enough — the process definition has to declare and map it.
- Decision callback: `POST /service/changerequest/decideRequest` with
  `{ ChangeRequest, Decision: 'approve'|'reject', Comment }`
- Post trigger: `POST /service/changerequest/completeRequest` with `{ ChangeRequest }`
- Workflow definition ID: `eu10.alluvion-dev-cf.mdmlightapproval.mDM_LIGHT_APPROVAL_WF`
- `businesspartnerinput` is **gone** from the create path — the approve view reads staging.

**Not built on Arthur's side — rework needs three things and the loop does not close without them:**

1. On reject: call `decideRequest` with `Decision: 'reject'` and the comment, notify the requester with
   `reworkurl`, and **do not complete the instance** — park it. (Today the notification arrives and the
   callback does not, which is why `claimRework` exists.)
2. Handle the approval-decision trigger input `result: 'Resubmitted'` — **capitalised**, unlike
   `approved`/`rejected` — by routing the request back to the approver:
   ```json
   { "executionId": "<process instance>",
     "inputs": { "result": "Resubmitted", "changerequestid": "...",
                 "businesspartnerinput": {}, "bpduplicates": [], "...": "..." } }
   ```
   The BP context sits **flat inside `inputs`, next to `result`**, and is the same object a first submit
   sends (`workflowContext()` builds both). It is rebuilt *after* `persist()`. `executionId` is the BPA
   process instance, **not** the change request UUID.
3. Handle `result: 'withdrawn'` by terminating the instance and clearing any open approver task. CAP has
   already deleted the request by then.

SBPA calls `decideRequest` on the CAP app directly, not through the approuter. The browser does go
through it, so **any new CAP service path also needs a route in `app/businesspartner/xs-app.json`** —
the catch-all sends anything unmatched to the HTML5 repo, where it 404s instead of erroring usefully.

## The shared maintenance screen (`app/reuse`)

The object page used for create, edit, approve, rework, datasteward and view lives in **`app/reuse`**,
not in either app that renders it:

```
app/reuse/src/mdm/md/businesspartner/reuse/
  controller/BusinessPartnerMaintenance.controller.js
  view/BusinessPartnerMaintenance.view.xml
  BusinessPartnerMetadata.js      (generated)
  BusinessPartnerAssistant.js
  css/maintenance.css
```

Rendered by `app/businesspartner` and `app/bptask`. It moved rather than being copied, because a second
copy of a 2,400-line controller drifts and nobody notices until the two screens disagree. **It is
freestyle** — a plain `sap/ui/core/mvc/Controller` over `sap.m`/`sap.uxap` — and **must not gain a
`sap.fe` dependency**; `test/task-form.test.js` fails if it does, because the task app has no Fiori
Elements libraries.

**It is copied at build time, not deployed as a library.** `tools/sync-reuse.js` copies the folder into
each consumer's `webapp/reuse` (gitignored, never edited) and each manifest maps
`"resourceRoots": { "mdm.md.businesspartner.reuse": "./reuse" }`, so module names are identical in both
apps and there is one copy in git. **A deployed UI5 library is the textbook answer and the wrong one
here** — it is addressed by a version-stamped URL, and a stale version reference is exactly what 404'd
the task UI. `app/reuse` is still shaped as a real library project so that can be revisited; nothing
loads `library.js` today.

- **`npm run generate:metadata` writes into the library.** Both consumers pick it up on their next build.
- **Every build runs `sync:reuse` first** — editing `webapp/reuse` directly is pointless.
- **The controller attaches only to routes its host declares** — the partner app routes all six, the
  task app only approve, rework and datasteward. `onInit` skips a missing route rather than throwing.
- `ui5 build preload` bundles `webapp/reuse/**` under the consuming app's own namespace, which is not
  the name the runtime asks for, so shared modules load as individual files and the bundle carries
  unused copies. Works, not free; excluding them is a worthwhile follow-up.

### Highlighting what changed

A changed value is **light red**, an added one **light orange**, and a collapsible three-column summary
leads the screen. `state.trackChanges` decides whether a baseline is meaningful:

- **A plain new create has none** — `_onCreateRoute` leaves it `false`.
- **Editing a live BP** compares against the values as read from S/4 (cloned right after the read).
- **A staged request** tracks changes everywhere **except** a create-type draft reopened by its own
  requester: `state.trackChanges = state.requestType === "change" || mode !== "edit"`.
- **A change-type request is judged against S/4's own current values, re-read live** —
  `_loadChangeBaseline` → `_fetchLiveSnapshotForDiff` (reusing `_loadSection`). Staging holds the
  *merged* result, so cloning it would compare a record against itself. Best-effort: a failed re-read
  leaves the as-loaded snapshot (a diff one round behind), logged, never shown.
- **A create-type request's baseline is server-persisted** in `ChangeRequests.baselineDataJson`, written
  by `submitRequest` **only**, returned as `BaselineDataJson`. **Nothing after the first successful
  submit ever writes this column again** — not `resubmitRequest`, not `decideDataStewardReview`, not
  `decideRequest`'s reject branch, not `claimRework`. That is deliberate and load-bearing: a steward's
  edits stay visible to the approver, and a requester reworking sees exactly what the steward changed.
  A client-side snapshot cannot do this — the next screen's own load re-snapshots against itself and the
  colouring vanishes.

**Rows are matched by CONTENT, never by `record.__state`.** That flag is staged as the DB `action`
column and **survives every reload**, so a row the original requester added still comes back `"new"` for
the next person. `matchSectionRows(records, baselineRecords, fieldNames)` runs two passes and does not
read it at all:

1. **Exact matches consumed first** (every field equal, either direction), so an untouched row is never
   coloured because some other row moved, and two identical rows never match one baseline row.
2. **The rest paired off by BEST MATCH** — `sharedFieldCount` scores every remaining (current, baseline)
   pair and the highest is assigned first, greedily. A row is a CHANGE for as long as any baseline rows
   remain and only becomes an ADDITION once the section genuinely has more rows than the baseline.
   Array order was worse than imprecise: two rows can each fail the exact pass without either being a
   real edit (one genuinely changed, another merely drifted in formatting on reload), and positional
   pairing then shuffles them against each other, reporting a change in every field nobody touched.

Still not exact without a stable row key — staging has a cuid, but `getRequestPayload` strips it before
it reaches the client. Two genuinely-edited rows scoring identically remain a coin flip. Undercounting
additions is the safe direction: it never invents a change nobody made.

**Deleted rows.** Whatever is unconsumed in `remaining` is a row somebody deleted; it rides along as
`results.deleted`, a property on the returned array so every existing caller keeps working. There is no
row left to colour, so the summary panel is the only place that can say so: one line per **populated**
field (old value shown, new value `"(removed)"`, `kind: "removed"`), or one "Row removed" line for a row
that was never filled in. **The header counts removals separately** ("3 fields changed, 1 row removed").
`ObjectStatus`'s existing ternary needed no change — `"removed"` falls into the Error branch.

- **Root fields are diffed value by value** — `fieldChangeKind(baseline, current)`: nothing when equal,
  `"added"` when the baseline was empty, `"changed"` otherwise, **including a field that was cleared**.
  `BusinessPartnerFullName` is excluded everywhere, root and summary alike.
- **The colour lives on the control, not in a binding** — the root form is built imperatively, so a
  field's background is fixed when its `VBox` wrapper is constructed. `_createForm`/`_createFieldGrid`
  take an optional trailing `baseline`, and `_onFieldCommitted` re-renders the whole root form after
  every commit (`change`, not `liveChange`).
- **A CHANGED row colours only the cells that differ, not the whole row** — colouring the whole
  `ColumnListItem` for one changed field is indistinguishable from the bug where every field was wrongly
  reported. There is deliberately no `mdmChangedRow` class. **An ADDED row is still tinted whole**
  (`mdmAddedRow`).
- **The Add/Edit dialog gets a baseline too** — `_openExistingRecord` resolves the row through
  `_rowBaseline` (the same `matchSectionRows` call `_renderSection` uses, so the two cannot disagree) and
  `_openNewRecord` passes `{}`. `_createFieldTable` colours the field control itself, since a table cell
  has no label wrapper. It is computed once, when the dialog opens — it does not track edits live.
- Hosted child sections (`childSections`) render through `_renderSection` and needed no separate work.
- **A value picked from the F4 help must be committed explicitly.** `sap.m.SelectDialog`'s `confirm` is
  not the `Input`'s `change` event, so `_onFieldCommitted` never ran for a chosen value. `_openValueHelp`'s
  confirm handler calls it directly after writing the value.
- **The summary panel is a real four-column table** (`changeSummaryPanel`: Field / Previous Value /
  New Value / Why), collapsible, `visible` bound to `changeSummary.length > 0`, with a count in the
  header. The colour sits on the **New Value** cell via `ObjectStatus`'s `state`. `_refreshChangeSummary`
  is the one place root and section diffs become `{field, oldValue, newValue, kind, why}` rows; a new
  section row lists its populated fields against `"—"`.
- **The Why column names the SOURCE of a value**, using the proposal dialog's own convention (three-word
  reason, full sentence on hover). `state.proposalProvenance` is written by `_recordProvenance` from all
  three of `_applyProposals`' write points (plain field, row-creating lead, and that row's key `extras`,
  which share the row's single Why). `_provenanceFor` returns the stored reason **only while the field
  still carries exactly the value the proposal wrote** — anything else is `"User change/input"`. Nothing
  has to remember to clear an entry, because a further edit stops matching on its own.
  `proposalProvenance` resets with `_emptyState()` and is **never sent anywhere** — no staging column, no
  `DataJson` key. A removed row's lines get no Why at all.

## `srv/business-partner-service.js` — everything is one file, by design

`BusinessPartnerService` (extends `cds.ApplicationService`) wires handlers in `init()`, but the bulk of
the file is pure helper functions above the class. **All of it is exported** via
`BusinessPartnerService._internals` so `test/*.test.js` can unit-test them without a CAP server — add a
new non-trivial helper to `_internals` and give it a test.

Handler groups:

- **CRUD passthrough** — `createBusinessPartner`/`updateBusinessPartner` translate to `cds.ql`
  INSERT/UPDATE against the remote service, not a local entity.
- **Full-screen maintenance** — `saveBusinessPartnerEntity`/`deleteBusinessPartnerEntity` are generic,
  driven by the `MAINTENANCE_ENTITIES` config map (remote name, navigation property, create/delete
  allowed, required fields). Adding a maintainable child entity means adding one entry, not new handler
  code. **`Customers`/`Suppliers` are `deletable: false` here permanently** — S/4 has no DELETE verb for
  a customer/vendor master (retirement is `DeletionIndicator`), so it rejects with 405. **Do not flip
  this to fix a delete-button complaint**: it is unrelated code to the generated metadata's own
  `deletable`, which only decides whether the staged maintenance screen draws a Delete button. Those two
  are `true` (Customer/Supplier Data are deletable on screen), and that is safe because
  `writeStagedNodes`' `!config.many` branch has no `deleted[section]` handling at all — removing the row
  just means nothing is re-inserted, so no delete is ever forwarded anywhere.
- **Search** — `applyBusinessPartnerSearch` rewrites Fiori's `$search` into an `or`-chain of `contains()`
  over `SEARCHABLE_FIELDS`; the remote V2 service has no native free-text search.
- **Business Partner Assistant** — `askBusinessPartnerAssistant` is read-only and grounded, **not** a
  general LLM passthrough: local matching against already-fetched partners/addresses (English and Dutch
  stop-word lists) falls through to AI Core only when insufficient. Only the bounded allowlists
  `ASSISTANT_FIELDS`/`ASSISTANT_ADDRESS_FIELDS` are ever sent off-box — **bank and tax data must never
  be added to them.**
- **Approval workflow** — creating a BP also calls `startWorkflow`; best-effort, surfaced via
  `req.info(500, …)`. `saveBusinessPartner` has most of its body commented out (only the workflow side
  effect is active) — treat it as mid-refactor, not a template.

## `srv/ai/` — SAP AI Core orchestration

`business-partner-assistant.js` calls the Generative AI Hub via `@sap-ai-sdk/orchestration`, bound
through the `extended`-plan service `mdm-businesspartner-aicore`. Model and fallbacks are set by
`AICORE_MODEL`/`AICORE_FALLBACK_MODELS`/`AICORE_RESOURCE_GROUP` in `mta.yaml` (currently
`anthropic--claude-4.5-haiku`, fallbacks `gemini-3.5-flash`, `gpt-5-mini`). **The primary is
deliberately not a reasoning model** — the assistant summarises a pre-filtered context and gains
nothing from reasoning, while `gpt-5` as primary was slower and could spend its whole budget on hidden
reasoning. `gpt-5`/`o*` models take `max_completion_tokens` instead of `max_tokens`, and an undersized
budget returns empty content instead of erroring (`isReasoningModel`/`modelParams` handle this — keep
them if a reasoning model is ever promoted back).

`ASSISTANT_INTENT_SOURCE: model` switches intent parsing from the regex heuristics to `srv/ai/intent.js`,
which is what makes "maak BP X aan" reliably yield a `companyName`. The regex parser stays as the
fallback whenever `parseIntent` returns null. `company-research.js` is a separate lookup;
`findPotentialDuplicates` uses Dice-coefficient name similarity, not exact match.

- **The Wikipedia branch has no structured data.** The REST summary API is prose, and Wikipedia is the
  branch a well-known company always takes (tried first, wins on any non-empty summary), so
  `suggestedAddress` was permanently `undefined` for exactly the companies most likely to have one.
  `addressFromPublicWeb` runs the DuckDuckGo snippet search as a **supplementary** call afterwards and
  merges the result, in its own try/catch.
- **`CorrespondenceLanguage` is inferred from the address country** — `COUNTRY_LANGUAGE`, deliberately
  narrow: only `NL`/`DE`/`FR`/`GB`. `BE` and `LU` are left silent on purpose (Dutch/French,
  Luxembourgish/French/German) — a wrong guess is worse than an empty field.
- **Registry enrichment joined the suggestion.** `registryEnrichment` calls `enrichCandidate` with the
  requested name and no typed tax numbers (GLEIF searches by name; VIES has nothing to validate yet).
  **A tax number is only ever proposed once VIES has confirmed it, and only for Belgium** — GLEIF's
  `registeredAs` is a local company number and `registeredAt` a registration-authority id
  (e.g. `RA000402`); **neither is an SAP `BPTaxType`**. A Belgian enterprise number is the base of the
  Belgian VAT number (`BE` + 10 digits, zero-padded from 9), so `belgianEnterpriseNumber` derives the
  candidate and `checkVatNumber('BE', …)` must answer `VALID` before `BPTaxType: 'BE0'` is proposed.
  Any other country's GLEIF hit contributes name and address only. **Registry outranks the research**:
  confirmed VIES, then GLEIF, then Wikipedia's title, then the plain requested name.
- **A VAT number typed in the chat is answered directly.** `extractVatNumber` finds a VIES-recognised
  2-letter code followed by 7–14 digits (dots/spaces/dashes tolerated) and `directVatLookup` calls VIES
  independently of any name match — **answered whatever VIES says**, including `invalid`/`unknown`/
  `not_applicable`, because staying silent on a number the requester explicitly gave is the failure being
  fixed. A confirmed direct hit outranks a name-matched one. **`check.vatNumber` is always the national
  number without the country prefix**, so build every branch off the check's own fields — building a
  label from the raw regex match doubled the prefix (`BEBE0403200393`).
- **The model must be TOLD about the registry results.** `registryEnrichment`/`directVatLookup` once
  reached only `fallbackAnswer`, so the live model had an empty context and reasoned its way to "check
  VIES yourself" — a plausible answer from a genuinely empty context, not a fallback-string bug.
  `registryFindings` (`{registry, directVat}`) is a fourth `promptContext` field, and the system prompt
  says plainly what it is and that the lookup already happened.
- **A requested role gets a role row.** `detectRequestedRoles` matches `customer`/`klant`/`afnemer` →
  `FLCU01` and `supplier`/`vendor`/`leverancier` → `FLVN01` against the free text (a plain regex, always
  on, unlike the `ASSISTANT_INTENT_SOURCE`-gated parser); both can fire. **Only the role row is added** —
  `cvi_account_group` fills Customers/Suppliers from `TBD001`/`TBC001` on the next Check, through the
  proposal path every other derivation follows.
- **`SuggestedData` is `{ root, sections }`**, the same shape a staged payload uses — a `TaxNumbers` row
  is a child entity and no flat key list can express one. The client JSON-encodes the whole object into a
  single `?draft=` query parameter. `_onCreateRoute` applies root fields off the explicit allowlist
  `ROOT_DRAFT_FIELDS` and section rows by id, stamping each `__state: "new"`; an unknown section key is
  ignored rather than refused. The `BusinessPartners/create:?query:` route already accepts any key.
- **The chat is a coloured list of turns** — a `sap.m.List` of `FeedListItem`s over
  `{ role, sender, text }`, built by a **factory** (a template cannot vary a row's style class). Three
  classes keyed off SAP semantic tokens (`--sapInformationBackground`/`--sapSuccessBackground`/
  `--sapWarningBackground`), never fixed hex: `bpChatUser`, `bpChatAssistant` (including the transient
  "Looking up live S/4HANA data…" placeholder, which `popMessage()` removes), `bpChatSystem` (the
  one-time intro only). `pushMessage(role, sender, text)` is the only writer. `conversationHistory` — the
  narrower `{role, content}` list sent as `ConversationJson`, capped to the last 10 turns — stays
  deliberately separate: the system intro and error text belong on screen, never in what the model
  reasons over.

## UI (`app/businesspartner`) — Fiori Elements, extended

A separate npm project driven by `@sap/ux-ui5-tooling`/`@ui5/cli`, not by the root CAP project. A
standard List Report / Object Page app with extensions layered on:

- The **maintenance screen is not here any more** (see `app/reuse`).
  `scripts/generate-maintenance-metadata.js` still lives here but writes into the library; re-run
  `npm run generate:metadata` after changing `MAINTENANCE_ENTITIES`.
- `webapp/ext/controller/ListReportExtension.controller.js` — list-report behaviour.
- `webapp/ext/CustomActions.js` — toolbar actions calling `askBusinessPartnerAssistant` and
  `saveBusinessPartner*`.
- `ui5.yaml` (real backend) vs `ui5-mock.yaml` (mock data) are separate configs — pick the matching npm
  script rather than editing one to behave like the other.

## Deployment

### No approuter module — managed approuter via Work Zone

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

### MTA (`mta.yaml`)

Four modules — CAP service (`mdm-businesspartner-srv`), HTML5 app-content deployer, destination-content
— plus resources (XSUAA, HTML5 repo host/runtime, destination service, connectivity, AI Core `extended`,
`mdm-businesspartner-authmgmt`, and the BPA user-provided services). **The CAP module path is `gen/srv`
(the `cds build` output), not `srv/`** — always rebuild before assuming `mbt build` picked up service
changes.

### The PostgreSQL deployer blocks on any dropped column

`mdm-businesspartner-db-deployer` runs `cds-deploy` as a one-off task, evolving the schema against the
previously deployed model CAP stores in table `cds_model`. Any removal fails with
`Error: Dropping elements is not supported (in entity:"…"/element:"…")`, identically on every retry
(compile-time — the deployer never reaches the database). `--auto-undeploy` is HDI-only. While staging
holds nothing worth keeping the fix is to wipe and redeploy; once it holds real requests, write a
migration.

**Diagnose a deploy failure from the MTA operation log, not the `cf deploy` console output**, which only
says a task failed: `cf mta-ops` lists every operation on an MTA ID (including other developers'), and
`cf dmol -i <operation-id> -d <dir>` downloads the per-module logs.

Before the first deploy of a subaccount, verify `postgresql-db`'s plan name — it varies by entitlement
and `mta.yaml` requests `free`: `cf marketplace -e postgresql-db`.

`tools/wipe-staging.js` does the wipe (lists what it would drop, stops without `--yes`). Two BTP
constraints it already handles: the bound role does **not** own schema `public` (so it drops objects
individually) and `public` contains extension objects owned by someone else (filtered on
`pg_get_userbyid(c.relowner) = current_user`).

The endpoint is private — nothing connects from a laptop or BAS, and the BAS Database Explorer only lists
HANA. Two ways in:

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

Pass the payload through an env var rather than inlining it in `--command` — long single-token commands
get line-wrapped in transit and bash executes the fragments separately.

For reading staged data, prefer OData over SQL:
`<srv-url>/service/changerequest/ChangeRequests?$expand=general,addresses,roles,findings`

Note `cds build` also materialises all 65 imported `API_BUSINESS_PARTNER` entity sets as physical tables
and views despite nothing reading them. Empty noise, not state — do not "fix" bugs by looking at them.

## Configuration notes

- `.cdsrc.json` — checked in; CAP build target (`gen`), `xsuaa` auth in production.
- `.cdsrc-private.json` — gitignored; hybrid-profile bindings tied to a specific CF org/space. Regenerate
  with `cds bind` rather than hand-editing paths from another environment.
- Local secrets (`.env`, `default-env.json`, `credentials.json`) are gitignored — never commit S/4 or BPA
  credentials into `mta.yaml`, `.cdsrc-private.json`, or source.

## Working alongside the other developers

Several people push to `main` in the same CF space, so a failure is often someone else's build.

**Check what you are deploying before assuming a bug.** MTA deploys take a per-MTA-ID, per-space lock; a
second `cf deploy` while one is in flight aborts with a conflicting-process error that reads like a
broken deployment. Check `cf mta-ops` for a colleague's `RUNNING` operation before deploying or retrying.

**Do not revert the staging feature to unblock a deploy.** It has been reverted once already (`dec9278`,
restored by `0a0daaa`) when the real cause was elsewhere, and reverting has a trap: once a commit is
reverted on `main`, git considers it merged, so re-merging the feature branch brings back *nothing* — the
feature only returns if the revert is itself reverted.

**Watch merges of long-lived branches.** The `Adding-WF` merge (`32b92c7`) auto-merged by concatenating
both sides rather than conflicting, producing a `package-lock.json` with two complete lockfile documents
and a test file with two tests joined without the closing `});`. After merging a drifted branch,
sanity-check `package-lock.json` and run `npm test` before concluding anything about a deploy failure.
