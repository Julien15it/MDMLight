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

UI (`app/mdmrules`, the MDM Configuration Panel tile — again a separate npm project):
```bash
cd app/mdmrules
npm install
npm run build:cf         # ui5 build preload for Cloud Foundry
```

UI (`app/bptask`, the My Inbox approval task UI — freestyle UI5, third npm project):
```bash
cd app/bptask
npm install
npm run build:cf         # syncs app/reuse, then ui5 build preload for Cloud Foundry
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

The destination itself must be named `VF_S4HANA_DEST`, with its own URL ending at
`/sap/opu/odata/sap` — CAP appends only `/API_BUSINESS_PARTNER` or
`/ZSRVB_MDMLIGHT_VH` (see `package.json`'s `cds.requires`). For an on-premise
system it needs `ProxyType=OnPremise` via Cloud Connector and an auth method
allowed to read and maintain business partners; creating a partner also needs
CSRF token support (`csrf: true`, already set in `package.json`).

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
document already in the workspace, `npx cds import <file>.edmx --as cds --force
--no-save` is the whole job. **Not `--into`**: cds-dk 8, the version installed,
does not know that flag — it lands the result in `srv/external` by itself.)

Both checked-in copies got here by hand, from Julien and Arthur respectively.
There has never been an automated path, so treat a re-import as a manual step
someone performs, not as something the app can do for itself.

**The five `Der*` entities were HAND-ADDED to both copies (2026-08-27), not imported.**
`npm run import:valuehelp` could not be run against this landscape, so they were transcribed from
the served `$metadata` into `ZSRVB_MDMLIGHT_VH.cds` *and* `.edmx`. The two agree, and the drift
check (which reads the `.edmx`) is therefore quiet about them rather than nagging.

Worth knowing before touching either file:

- The **`checksum`** comment at the top of the `.cds` is now stale. Nothing verifies it; it exists
  for `cds import`'s own change detection.
- The `.edmx` is a **single minified line**, so it was edited by anchored string insertion, not by
  appending. Verified afterwards by tag balance (53 `EntityType` / 53 `Key` / 53 self-closing
  `EntitySet`, up from 48 each) and by byte offset — the types land before the first
  `<Association>`, the sets inside `<EntityContainer>` before the first `<AssociationSet>`.
- **No `Annotations` block was added** for these five. The imported copy carries
  `Common.SAPObjectNodeType` annotations for a dozen value helps; the served metadata carries none
  for the `Der*` types, so neither does this.
- A real `cds import` supersedes all of it and should be preferred whenever one can be run.

**The drift check earns its keep, and its output needs reading against the excludes**
(2026-08-21). It reported six fields gone from the live service; five were already in
the exclusion lists, and the sixth — `RecipientType` on `A_CustomerWithHoldingTax` —
was not, so that section's read was answering 404 and rendering empty on a partner
that has withholding tax data. When this warning fires, check each named field
against the `excluding {}` lists: the ones already there are noise, and the one that
is not is a broken section. Re-importing is the proper fix; an exclusion is the one
that does not need S/4 credentials.

`srv/metadata-drift.js` runs once at startup and reports the difference against
the live services, scoped to the entity sets the app actually reads (nine of the
65 in `API_BUSINESS_PARTNER`). A property the live service **dropped** is a
warning, because that read is already failing; one it **gained** is an info,
because the copy is only behind. It is best-effort by construction — an
unreachable S/4 logs at debug and never delays or fails startup — so treat a
silent log as "no destination here", not as "in step".

**Excluding a field in the CDS fixes the live read, and used to leave it on the
create screen anyway** (found and fixed 2026-08-27). The maintenance UI's field
catalog (`app/reuse/.../BusinessPartnerMetadata.js`) is generated by
`app/businesspartner/scripts/generate-maintenance-metadata.js`, and that script
read the **raw imported** `API_BUSINESS_PARTNER.csn`/`.edmx` directly — never
`business-partner-service.cds` — so a section's own `excludedFields` array there
was a **second, hand-copied list** of the same exclusions, and nothing enforced
that the two agreed. `RecipientType` on `A_CustomerWithHoldingTax` was excluded
in the CDS on 2026-08-21 (the incident above) and never added to that section's
`excludedFields` — so the field kept rendering on the create screen for six days,
correctly gone from S/4's own metadata but never removed from the copy the create
screen actually reads. The generator now compiles `business-partner-service.cds`
once (`cds.load`/`cds.linked`, same offline compilation `cds build` already
relies on) and diffs each section's projected elements against the raw CSN to
derive its exclusions automatically, merged into whatever `excludedFields` the
section still hand-lists for its own reasons. A field that is CDS-excluded but
still named in a `fieldGroups` block now fails the build with a clear message
instead of silently reappearing — the same guard that already existed for a
field named in a group the raw metadata does not have, extended to catch the
opposite drift. Re-run `npm run generate:metadata` after any change to
`business-partner-service.cds`'s `excluding {}` clauses, same as always — the fix
is that a forgotten run no longer leaves a genuinely-excluded field showing.

**Customer Data and Supplier Data became deletable in the generated metadata too
(2026-08-28, reported: "bij supplier data en customer data is dit niet
mogelijk").** Every other maintainable section was deletable already; these two
were still add-only because `generate-maintenance-metadata.js` hand-set
`deletable: false` on both, copying the reasoning from
`MAINTENANCE_ENTITIES.Customers`/`.Suppliers` on the server (see "Full-screen
maintenance" above) — a reasoning that does not actually apply here:

- **The two `deletable` flags are unrelated code**, despite the same name and the
  same section id. `MAINTENANCE_ENTITIES` gates `deleteBusinessPartnerEntity`'s
  live OData `DELETE` against S/4, which is real and stays refused — S/4 has no
  such verb for a customer/vendor master record. The generated metadata's
  `deletable` gates only whether **this shared, staged maintenance screen** draws
  a Delete button for the section; nothing auto-derives one from the other.
- **Deleting the row here never reaches that server call at all**, for either
  request type, because of a gap in `writeStagedNodes` (`srv/change-request-service.js`):
  `Customers`/`Suppliers` are `!config.many` (`kind: "single"`, one row at most),
  and that branch has **no `deleted[section]` handling whatsoever** — unlike the
  collection branch, which stages an explicit `action: 'D'` row that `postToS4`
  later turns into a real `deleteBusinessPartnerEntity` call. So removing the row
  on screen just means nothing is (re)inserted into `StagedCustomer`/
  `StagedSupplier` at save/submit: a **create** stages no customer/supplier data
  at all (the section was never posted to S/4 in the first place), and a
  **change** over a partner that already has one simply leaves S/4's live record
  untouched — the request carries no instruction about it either way. Neither
  case is a delete this app forwards anywhere; the button only lets someone take
  back data they added (or reviewed and decided not to touch) on this screen.
  Fixing this gap to genuinely stage a deletion for an *existing* Customer/Supplier
  would run straight into the server-side 405 at post time, which is exactly why
  it has not been touched.
- **The fix is therefore two one-line removals** — `deletable: false` deleted
  from the `Customers` and `Suppliers` entries in
  `generate-maintenance-metadata.js` — followed by `npm run generate:metadata`.
  `MAINTENANCE_ENTITIES` on the server is untouched and must stay that way.

### The `abap/` folder — how the two S/4-side services are built

`abap/valuehelp/README.md` and `abap/customerfields/README.md` are the ADT-side
companions to the two services above: exact ABAP steps for creating the service
definition/binding in the S/4 system, which released views back each value help,
and known drift between what is exposed there and what has been imported here.
Read one before touching a `@Common.ValueList` or asking why a field has no F4.

**`abap/customerfields` (`ZMDML_CUST_ENTITY` / `ZSRVB_MDMLIGHT_CUST`) is designed
but not yet wired in** — it is not in `package.json`'s `cds.requires`, has no
`srv/external` copy, and nothing in `srv/business-partner-service.cds` projects
it. It exposes S/4's `I_Customer` view to close the gap between
`A_Customer`'s 53 fields and the MDG *ERP Customer* screen's larger set
(Trading Partner, DME Indicator, Condition Groups 1–5, and others) — build it
when one of those fields is actually asked for, following the README's ADT and
wiring steps rather than guessing at the shape.

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

### The merged search list (2026-08-24)

The list report reads **`BusinessPartnerSearchResults`**, not `BusinessPartners`:
the live S/4 partners and the change requests still in flight, in one result set.
Without it a requester could not see that the company they are about to request
is already being created by somebody else — and worse, a partner under an
in-flight request was filtered **out** of the list by
`applyChangeRequestExclusion`, which is now deleted.

Two kinds of row, and the difference matters:

- A **pending create** has no partner number yet, so it can only be seen as its
  own row (`ResultKey: 'CR:<id>'`, `IsChangeRequest: true`), named by
  `stagedFullName` because S/4 is the one that derives
  `BusinessPartnerFullName` and staging only has the fields it was typed into.
- A **change/block/delete** request over an existing partner is that partner's
  own row (`ResultKey: 'BP:4711'`), marked via `RecordStatus` /
  `RecordStatusCriticality` and carrying `ChangeRequest`. Its staged copy is
  never listed: staging holds a second copy of the same company, and showing
  both would report one company twice — the same reason `stagedEntries` in
  `srv/ai/duplicate-check.js` feeds creates only to the duplicate check.

`IN_PROGRESS_REQUEST_STATUSES` (`srv/search-results.js`) is `draft`,
`inApproval`, `reworkRequired`. It is deliberately **narrower** than
`ACTIVE_REQUEST_STATUSES`, which is a lock and covers `approved` and `failed`
too. Do not collapse the two: one answers "may this partner be edited", the
other "is a human still holding this request".

The entity is `@cds.persistence.skip` — one READ handler in
`srv/business-partner-service.js` merges a remote read with staging:

1. Staging is read **first**. The staged rows always take the top of the list: a
   pending create has no number, so that is where the default sort puts it, and
   fixing their position is what makes `pageSplit` exact rather than
   approximate — page 2 skips the staged rows it already showed and resumes the
   remote read at `skip - pendingCount`.
2. Staged rows are filtered **in memory** by `matchesWhere` (enough CQN for what
   the filter bar and the `$search` rewrite emit) and `matchesTerms` (every term
   must hit a field, matching the remote rule). An expression `matchesWhere`
   cannot evaluate **keeps** the row and logs `[search]`: a staged request
   wrongly shown is a nuisance, one wrongly hidden is the failure this list
   exists to prevent.
3. The remote read asks for a **fixed** column list (`PARTNER_FIELDS`). The
   client asks for status columns that exist only here, and one unknown field
   fails the whole remote read.
4. `$count` is the remote count plus the matching staged rows, and **both sides
   have to be numbers**. `$count` arrives from the V2 remote as a **string**, so
   `partners.count + pending.length` was `"323" + 57` — string concatenation,
   giving `"32358"` for a list of 380 rows. It reported a count two orders of
   magnitude out for a week, and survived that long because 32,354 / 32,355 /
   32,358 all look like a plausible partner population rather than a bug.

   What gave it away was the arithmetic, not the logs: the numbers were always
   `"323"` with the staged count stuck on the end. Two wrong theories came first —
   that an unfiltered read was simply correct, and then that the `$top=1` count-only
   read made the gateway answer differently — and a per-read `[search]` log line
   disproved the second by printing `count 323` on exactly that read. The count-only
   read is back to asking for one throwaway row; the page-size version was aimed at a
   bug that was never there.

   **That per-read log line is gone** (2026-08-24), having settled this twice. The
   two `[search]` warnings that remain are worth keeping: staging unavailable, and a
   read arriving with no `$top` — the second is the one shape whose count nobody can
   sanity-check. If a count ever looks wrong again, put the line back rather than
   theorising: it prints the incoming shape, `countOnly`, and the remote count.

   A page filled entirely by staged rows still needs the total, which is why that
   branch exists at all.

Consequences worth knowing before changing this:

- The computed columns are declared **non-filterable and non-sortable**
  (`@Capabilities.FilterRestrictions` / `SortRestrictions`). Sorting on a
  computed column would silently sort one half of the list only.
- **Every filterable table column is also in `UI.SelectionFields`** (asked for
  2026-08-27), because OData V4 Fiori Elements builds the filter bar - and its
  "Adapt Filters" dialog - from `SelectionFields` alone; unlike V2, there is no
  "every property is a candidate" fallback, so a column left out of that list
  cannot be added as a filter no matter how visible it already is in the table.
  `BusinessPartnerFullName` and `SearchTerm1` were LineItem columns without a
  matching `SelectionFields` entry until then.
- **The change-request columns became filterable too (2026-08-28, asked for)** -
  `RecordStatus`, `IsChangeRequest`, `ChangeRequestType`, `ChangeRequestStatus`,
  `RequestedBy`, `RequestedAt` are all in `UI.SelectionFields` and out of
  `NonFilterableProperties` now. S/4 has never heard of any of them, so the READ
  handler cannot forward such a filter as-is the way it does for
  `BusinessPartnerCategory` or `SearchTerm1` - see "Filtering on the
  change-request columns" below for how it evaluates one locally instead.
  `ChangeRequest` (a raw UUID) stays off `SelectionFields` on purpose, the same
  reasoning that keeps `ResultKey`/`RecordStatusCriticality` off it: a field that
  means nothing as a typed value is not worth offering as a filter candidate.
- Sorting on a field S/4 *can* sort still leaves the staged rows on top —
  `remoteOrderBy` drops what S/4 has never heard of, `ResultKey` included.
- The **object page and the maintenance screens still read `BusinessPartners`**,
  which is why the exclusion had to go rather than move: a hidden partner could
  not be opened for display either.
- Because a marked partner is now reachable, `openEditPage` in
  `CustomActions.js` refuses to edit a partner that carries a `ChangeRequest`
  and names it. Hiding the row used to be what prevented that; a message is.
- **A change request row opens read-only, for anyone** (2026-08-24). Seeing what
  has already been asked for is the point of showing the request in this list, and
  the list itself is open — so a gate on the view would only have hidden the answer
  it exists to give. A first version restricted it to a steward or the requester
  (`CanViewRequest`, resolved from `req.user`); Maarten opened it to everyone and
  that flag is gone rather than left dormant.
- **The route is `ChangeRequests/{id}/display`, never the edit one.** `_loadStagedRequest(id, "view")`
  renders the screen with `editing` false, no Check, no decision buttons and no
  save — so this widened what can be *seen* without widening what can be
  *changed*. Editing a draft still means the steward-gated Change Requests list,
  and an `inApproval` request is still decided from the approver's inbox against a
  real task. `onSave` refuses an unrecognised mode, so `view` cannot write.
- **Nothing authorises the staged payload, and this did not change that.**
  `getRequestPayload` has no check in front of it and neither does the `@readonly
  ChangeRequests` entity — the whole payload is already readable by any
  authenticated user through `$expand`, which is how the "reading staged data"
  recipe further down works. Closing that needs the role model this file keeps
  deferring: restricting `getRequestPayload` to steward-or-requester today would
  **break every approval**, because an approver is neither.

#### Filtering on the change-request columns (2026-08-28)

Asked for directly: a requester wants to filter the list by status ("show me my drafts", "what is
in approval"), and status is exactly the one column S/4 has never heard of. Forwarding such a
filter to the remote read the way `BusinessPartnerCategory` already is would fail the whole read -
S/4 would answer "property not found", not "no matches".

- **`referencedFields` (`srv/search-results.js`) walks a WHERE clause the same way `valueOf` reads
  it** (`ref`/`xpr`/`list`/`func`) and returns every field it names. The READ handler compares that
  set against `PARTNER_FIELDS` - the fixed column list S/4 actually understands - and any field
  outside it flips the read into a different branch entirely.
- **That branch fetches the full matching partner population and filters everything in memory**,
  the same trade-off already made for a read with no `$top`: `mergeLocalPage` merges the pending
  entries and the fetched partners, runs `matchesWhere` against **`entry.row`** (not
  `entry.searchable`, which was built only for `matchesTerms`'s free-text search and never carried
  the computed change-request fields at all), sorts by `byRequestedAtDesc`, and pages the result
  locally - so the `$count` this branch returns is exact, unlike the remote path's own string-`$count`
  workaround.
- **A `console.warn` names the field(s) that forced it**, the same discipline the "no `$top`"
  warning already follows: an expensive read must never happen silently.
- **`$orderBy` is untouched by any of this** - sorting on a change-request column is still refused
  (`NonSortableProperties` keeps all of them, `RecordStatus` included), for the same reason as
  before: the staged half is sorted in memory, so sorting on one would silently sort one half only.
  Only *filtering* was widened.
- **`FilterRestrictions.NonFilterableProperties` now holds only `ResultKey` and
  `RecordStatusCriticality`** - a synthetic key nobody types and a bare colouring int, neither of
  which means anything as a value to filter *by*. Every other change-request column moved out, and
  into `UI.SelectionFields` (see above) so "Adapt Filters" actually offers it.
- **A mixed filter (a remote field AND a change-request field) still works correctly**, because
  the local branch does not try to split the WHERE clause and forward half of it - it evaluates the
  *whole* clause against the *whole* merged population once fetched. Splitting would be the
  performance optimisation; correctness came first.

### The request screen's message area (2026-08-24)

**The strips live in a collapsible `Panel`** (`maintenanceMessagePanel`), like the
duplicate findings below them. A submit reports several at once; information-only
noise must not push the form off screen.

- The **header carries the leading message**, elided to one line, with `(+N more)`
  for the rest — so a collapsed panel still says what it holds. The strips are
  ordered so a Warning leads, which is what makes that worth reading.
- **Anything above Information opens the panel itself** (`messagesNeedAttention`).
  A blocked submit or an approver's rejection reason is not something to make
  somebody click for; an Information-only set stays shut, which is the case the
  panel exists for.
- `expanded` is bound **one-way**, so a render re-applies it: expanding an
  information-only panel and then editing a field collapses it again. Accepted
  deliberately over a state flag that all thirteen `state.messages = …` sites would
  have to remember to set — that is the version that goes stale. If the re-collapse
  ever annoys somebody, the fix is the flag plus a fingerprint, not a formatter.

**The duplicate findings follow the request into the approval task.** They were
written to `CheckFindings` at submit and **never read back**: the approve screen
built its panel only from a check it ran itself, which it does not, so an approver
opening a task saw an empty panel — indistinguishable from "no duplicate was
found", which is the one wrong answer this whole feature refuses to give.
`getRequestPayload` now returns `FindingsJson` and `_loadStagedRequest` feeds it to
the same `_setDuplicatePanel`, so the requester's panel and the approver's are one
piece of code. Two details:

- **`duplicate_check` findings only**, and the same `isStale` filter the exposed
  `CheckFindings` view applies — `CheckFindings` also holds the validation and
  registry findings, which are a different report, and a resubmit's superseded
  verdicts would otherwise come back alongside the current ones and make one pair
  read as several.
**And the validations follow it too** (2026-08-24). `CheckFindings` only ever held
`duplicate_check` rows, so a VIES name mismatch, a VAT number VIES could not
confirm, a GLEIF statement or a `warning`-level configured rule was reported to the
requester at submit and then dropped — the approver judged the request without the
findings it was submitted with. `recordValidationFindings` stores them on both
submit paths and `getRequestPayload` returns them as `ValidationsJson`.

- **Written after the blocking gate**, so nothing blocking is ever stored: a
  blocking validation leaves the request a draft and never reaches this point.
- **Written before the duplicate check**, so an outage in that check cannot cost the
  warnings the submit already produced.
- **Superseded, not deleted**, on a resubmit — same as the duplicates, so an earlier
  verdict stays auditable.
- **Rendered as strips, not in the duplicate panel**: they are statements about this
  record, not a list of other partners to compare it against. `_validationMessages`
  is the shared mapper, so the approver's strips and the requester's Check strips
  cannot drift.
- **Appended after the mode branches.** Every branch *assigns* `state.messages`, so
  setting them earlier puts them where the next branch wipes them. Order is: the
  branch's own message (it explains the screen, and the collapsed panel header shows
  the first one), then the submitted warnings, then who has it now.

- The approver's rows carry **no candidate name**: `candidateName` is not a
  staging column, so the title is the partner number (or `pending request <id>`)
  and the stored `message` carries the sentence. Add the column if the name matters
  more than that.

### `BusinessPartnerFullName` is derived, never stored (2026-08-24)

It is a **standard S/4 field**, not one this app added, and
`srv/external/API_BUSINESS_PARTNER.edmx` marks it
`sap:creatable="false" sap:updatable="false"` — S/4 composes it from the name
components and refuses to be told it. That is why the maintenance screen shows it
uneditable (`generate-maintenance-metadata.js` carries the flags through) and why
making it editable would gain nothing.

It is also absent from the **Field Properties** catalog, correctly:
`payload-fields.js` is generated from `db/staging.cds`, which has no such column,
and a profile cannot govern a field nobody can fill.

The gap that mattered: a **pending create** has no such name anywhere. S/4 has
never seen the partner and staging does not hold the field, so the approver's task
was being handed a blank where the partner's name belongs. `srv/partner-name.js`
composes it — the category decides which fields to read (1 person, 2 organisation,
3 group), because S/4 discards name fields that do not match the category, and an
empty answer falls through the other groups rather than leaving a request unnamed
for a human to read.

**One composed name, two consumers**, so the search list and the approver's task
can never name the same requested partner differently: `stagedFullName` in
`srv/search-results.js` *is* `fullNameOf`, and `buildBusinessPartnerInput` wraps
the root row in `withFullName`.

**Never write it into a request payload**, and this is the trap worth remembering:
`sanitizeEntityPayload` excluded it on **update** all along and excluded *nothing*
on create, so a value sitting on the staged root would have been forwarded to S/4
on the post and rejected — a request that fails at the last step. It cost nothing
while nothing could produce such a value; composing one is exactly that. Hence
`ROOT_CREATE_EXCLUDED_FIELDS`, which is the create-path counterpart and holds
`BusinessPartnerFullName` and `BusinessPartnerName`. Other derived root fields
(`BusinessPartnerUUID`, `CreatedByUser`, `CreationDate`, …) are still unguarded on
create; nothing produces them today, and the same reasoning applies if anything
ever does.

**On the screen it is filled by `_refreshFullName`**, from `previewName` — the same
category-driven composition, client-side. Two rules make it safe and honest:

- **A committed name field recomposes it** (`_onFieldCommitted`, `recompose: true`),
  so it fills in as soon as Name 1 is typed rather than waiting for a post.
- **So does a name accepted from a proposal, and so does the Additional Fields dialog**
  (both fixed 2026-08-27). Neither fires `_onFieldCommitted` — `_applyProposals` writes
  straight into `state.root` — so accepting a VIES-proposed "Alluvion BV" over a typed
  "Test" left the full name reading "Test". Both now recompose, and both are **guarded on a
  name field having actually changed**: recomposing on every Apply would overwrite S/4's own
  derivation on a partner read from S/4, which is what the rule below exists to prevent.
- **An existing value is otherwise left alone.** On a partner read from S/4 that
  value is S/4's own derivation, and replacing it with a composition would show
  something S/4 does not say. A staged request always arrives without one, so
  loading a request composes it.

Writing it onto `state.root` is safe on both counts that matter: staging has no such
column so `stageable()` drops it, and `ROOT_CREATE_EXCLUDED_FIELDS` keeps it out of
the create S/4 would reject. A value to show, never one to store.

**The AI assistant's suggested draft never fires `_onFieldCommitted`, so it never
recomposed the name either** (fixed 2026-08-27). `_onCreateRoute` writes
`OrganizationBPName1`/etc straight onto `state.root` from the parsed draft — that
is not a user editing an `Input` control, so the commit-triggered recompose above
never ran, and the full name stayed blank until the requester separately touched a
name field by hand (typing Name 2, say, then recomposed off both fields at once and
looked like Name 2 was what had been missing). `_onCreateRoute` now calls
`this._refreshFullName(true)` itself, right after `setData` so `previewName` reads
the draft's fields rather than the empty state it replaced. Safe to call
unconditionally: on a plain `BusinessPartners/create` with no draft, `previewName`
composes nothing from an empty root and the existing no-op guard
(`!composed || root.BusinessPartnerFullName === composed`) leaves the screen alone.

### Who has it now — the processors strip (2026-08-24)

Every change request screen leads with one Information strip saying which step the
request is on and who is holding it: `Current step: Approval - with
julien@alluvion.eu, Sales Approver`. `getRequestPayload` returns it as
`ProcessorsJson`; `srv/request-processors.js` maps a status to a step, a list and a
sentence.

**The approvers are what CAP SENT the workflow, not who the workflow gave the task
to.** They are re-resolved from the `WorkflowRules` table against the payload as it
stands, so two things can make them wrong: the table may have been edited since the
submit, and — today — **Arthur's process ignores `approvers` entirely** (see
"Workflow rules"). It becomes the real answer only once the process routes on the
list, and it must never be labelled as SBPA's assignment before that lands.

**That caveat belongs in the code, not in the strip.** It was in the strip until
2026-08-24 — *"With the approvers below, as sent to the workflow."* — and Maarten had
it removed: the names are already in the same sentence, so "below" was wrong, and
"as sent to the workflow" told a requester nothing they could act on while reading as
a hedge. A note is now shown **only when there is something a reader can do with it**,
which is the empty case: no rule named an approver, so look in the inbox.

The rest is deliberate:

- **Approvers are resolved only while the status is `inApproval`.** For a draft they
  would name people who are responsible for nothing yet.
- **A requester is always `kind: 'user'`**, whatever their user id looks like. Only
  the approver half of the rules table can name a role, and the `@` rule that tells
  them apart is the same one the wire uses.
- **`submittedBy` outranks `createdBy`** — whoever sent it is who it is with.
- **The steps nobody holds say so.** `approved` is waiting on the workflow to post,
  not on a person; `failed` says a steward has to pick it up and that it will not
  retry itself. Naming somebody who cannot act would be worse than naming nobody.
- **An empty approver list is a legitimate answer**, as everywhere else that table
  is read: it says the workflow routes it itself and that the holder is only visible
  in the approver's inbox.
- **`rejected` reads as the rework it has become.** Nothing writes it any more, but
  it cannot be dropped from the enum, so it must not fall through to "nobody".
- **The strip goes LAST**, after every mode branch has set its own messages — both
  so none of them can overwrite it, and because each of those messages explains the
  screen the requester is looking at: why a rework link offers nothing, why a
  request is read-only, what a rejection said. The panel header shows the *leading*
  message, so leading with the step collapses the explanation out of sight. It was
  prepended for half a day and that is exactly what it did. It leads on its own
  when nothing else spoke, which is the plain approve screen.
- Best-effort, like every other read of the workflow rules: a table that cannot be
  read costs the strip, never the screen.
- **Suppressed entirely on the rework screen** (2026-08-26, asked for). The rework
  branch already sets its own message explaining why the requester is looking at
  this screen; "Current step: Rework - with &lt;requester&gt; ... Sent back to the
  requester, who resubmits it or withdraws it." on top of that read as noise, not
  new information — the requester already knows the request is theirs to act on.

**Removed from the screen entirely on 2026-08-28** ("haal de infomessage uit de
app waar de melding current step zegt wie approved, dit is niet meer nodig" - not
needed any more). `processorMessage`, `parseProcessors` and `state.processors`
are gone from `BusinessPartnerMaintenance.controller.js`, and `_loadStagedRequest`
no longer appends anything after `submittedWarnings`. **Only the client-side
reading of it went** - `srv/request-processors.js`, `ProcessorsJson` on
`getRequestPayload`, and every rule above about how the step and the approvers are
resolved are all untouched, so this stays available to build a different surface
on later without re-deriving any of it.

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
- **GLEIF is a last resort, not a second opinion** (tightened 2026-08-27, Maarten:
  *"the quality of GLEIF data seems to be less than that of VIES"*). It is a member
  state's own register against self-reported LEI reference data. So `enrichCandidate`
  searches GLEIF only when **both** of these hold:
  - **A name *and* a country are filled in.** `acceptedEntities` is what makes a
    GLEIF hit safe, and its country filter cannot run on a record that carries no
    country — a name alone is how a Belgian company ended up under a Dutch entity's
    number on 2026-08-14. The country may come from the root `Country` or the first
    address; `primaryCountry` reads both.
  - **No VIES check came back `VALID`.** Once a member state has confirmed the VAT
    number, GLEIF cannot improve on it. A VIES *outage* or no VAT number at all
    leaves nothing confirmed, so the fallback does apply.

  `requireCountry: false` is the one opt-out and it is opt-in only: the assistant's
  "who is this company?" prefill (`registryEnrichment` in
  `srv/business-partner-service.js`) has a typed name and nothing else, and its answer
  is a suggestion in chat the requester reads, not a value proposed into a field. The
  check pipeline never passes it — `test/registry.test.js` asserts that too.

#### The CVI configuration check (2026-08-25)

`srv/checks/cvi-checks.js` adds one validation, `cvi_configuration`, on all three
gates. It answers **will this partner actually synchronise?** — CVI turns a business
partner into a customer and a supplier, and whether it can is decided by S/4
customizing nobody filling in the form can see. A role the BP category may not carry
is accepted by the screen, staged, approved, and only then refused by S/4, after an
approver has spent their time on it.

It reads `CviConfigService`'s remote sets (see `srv/cvi-config-service.cds`), backed
by eight CDS views in S/4 package `ZMDM_LIGHT`. Four rules and one derivation today:

- **A role its BP category may not carry.** `TB003` gives role → role category,
  `TB003A` gives the category's allowed BP categories (person/organisation/group).
  Reported against the offending `BusinessPartnerRoles` row, one per role, so a
  requester sees all of them at once.

  **This rule was wrong twice, and both times for the same reason: the flags are
  booleans, not `'X'`.** Every CHAR(1) flag in these sets arrives as `Edm.Boolean`
  — look at any of them in `srv/external/ZSRVB_MDMLIGHT_VH.cds`. A comparison
  against `'X'` therefore reads *every* row as blank. Version one read blank as
  "forbidden" and fired on `FLCU01` and `FLVN01` on an organisation, the two most
  ordinary combinations in the product; the fix for that — "a row with no flags set
  restricts nothing" — then made the rule permanently *silent*, because with
  booleans no row ever looks like it has a flag set. `isSet` now accepts both
  representations (fixed 2026-08-25), and the tests use the boolean form on purpose:
  the earlier `'X'` fixtures are why a broken rule had a green suite.

  The no-flags-set guard stays, but it is a guard and not a description of any
  system: **on S4A all 166 `TB003A` rows have at least one flag set**, and `FLCU01`
  carries all three. The claim that S4A's flags were unmaintained was wrong — the
  rows were finally read on 2026-08-25.
- **Postprocessing switched off**, when the request asks for a role at all. PPO off
  means a synchronisation error is dropped rather than queued, so the partner
  silently never becomes a customer. Reported **per row of
  `CviPostprocessingControl`** rather than against a hardcoded sync object name — a
  constant guessed wrong would match nothing and report nothing, forever.

Three decisions worth not reversing casually:

- **`warning`, not `error` — `ROLE_CATEGORY_SEVERITY` is the knob.** The two failure
  costs are not symmetric: a warning on a combination that would have worked is
  noise, while blocking a legitimate partner leaves a requester unable to submit and
  with no way to argue. Move it to `error` once the rule has been seen to be right on
  real data at a real customer.
- **A configuration that cannot be read reports itself and never blocks.** The
  pipeline turns a *thrown* validation into a blocking error, which would be more
  severe than anything this stage itself reports — an unreachable S/4 would stop
  every submit over a warning. So the read is caught and returned as a warning
  saying it did not run, rather than letting "no findings" read as "checked and fine".
- **Configuration, not SAP's verdict.** Transaction `CVI_FS_CHECK_CUST` is a module
  pool with no callable API and its judgements move with support packages. These
  rules are derived from the customizing itself and stated in terms of the request.

One rule that was considered and is **not** built, deliberately:

- **Contact person synchronisation.** `CviContactMapping` reports the switch, but
  MDM Light does not stage contact persons at all (there is no such node in
  `db/staging.cds`), so there is nothing in a request for the rule to fire on.

##### Number assignment (added 2026-08-25)

The third rule, and the one with teeth. **Does the grouping on this request line up
with the account group CVI will use, so that a number actually gets assigned?** Off by
one flag, nothing synchronises and nobody is told.

Finding the tables was the work. `CVI_FS_CHECK_CUST_SUBROUTINES` names them itself —
`select` in `select_data_customer` / `select_data_vendor` and the fills in
`CVI_FS_CHECK_CUST_STARTSCREEN` — which is how the first five views were found too:

| Table | What it holds |
|---|---|
| `TBD001` / `TBC001` | grouping → customer / supplier account group, plus the same-number flag (direction BP → account) |
| `CVIC_CUST_TO_BP1` / `CVIC_VEND_TO_BP1` | the same for the inbound direction. **Both empty on S4A** |
| `TB001.NRRNG` | the grouping's BU_PARTNER number range |
| `T077D.NUMKR` / `T077K.NUMKR` | the account group's DEBITOR / KREDITOR number range |
| `TBD002` / `TBC002` | which BP role category actually creates a customer / supplier |
| `MDSC_CTRL_OPT_A` | which directions are switched on |

Three new views (`Z_I_CVI_NUM_ASGN_CUSTOMER`, `Z_I_CVI_NUM_ASGN_VENDOR`,
`Z_I_CVI_SYNC_DIRECTION`) and four new columns on `Z_I_CVI_ROLE_CATEGORY` carry them.
The intervals stay where they already were, in `CviNumberRanges`; the new views expose
the number range *keys* only, which is the link nothing had before. What the rule
reports, in this order:

1. **The direction is off.** No active `MDSC_CTRL_OPT_A` row means the account is
   simply never created. SAP's report checks the mirror image — "maintained but
   inactive" — and never this one, and "on but nothing maintained" is the case that
   bites.
2. **Nothing maintained for the grouping.** No `TBD001`/`TBC001` row means CVI has no
   account group to create with. On S4A **nine of 23 groupings have no customer row
   and fifteen have no supplier row, `MDM0` among them.**
3. **Same number set, intervals differ.** Message 023 of `CVI_FS_CHECK_CUST`, with
   both ranges and both intervals named — "the number ranges do not match" alone
   sends the reader to two SPRO screens to find out which.
4. **Same number not set and the account's range is external.** Nobody supplies that
   number: the requester cannot (no field for it) and CVI will not (not its range to
   draw from). Messages 022/031 turned around — SAP checks this for the inbound
   direction only. On S4A this fires on `0002 → KUNA`, and on `0002`, `GPEX` and
   `Z001` on the supplier side.

##### The account group derivation (added 2026-08-25)

The rule's counterpart, and the reason it was worth exposing `TBD001` rather than only
judging it. **For direction BP → Customer, S/4 takes the customer account group from
`TBD001` by grouping — it is not a free choice, it is a lookup**, and the only place
it existed was a SPRO screen the requester cannot see. `cvi_account_group` fills
`Customers.CustomerAccountGroup` and `Suppliers.SupplierAccountGroup` from it.

It runs on Check and Duplicate Check only, through `runRequestChecks` — submit and
resubmit still validate without deriving, unchanged since 2026-08-13. Two pipeline
guarantees carry it: a derivation **never overwrites a typed value**, and `createsRow`
invents a row **only when the section is completely empty**. So a request that already
carries supplier data gets the field filled and one that carries none gets the row it
needs, and neither case touches a second row somebody added deliberately.

Silent wherever it cannot be sure — no grouping, no role that creates the account, an
inactive direction, no assignment row, or more than one. That last case should not
exist (`TBD001` is keyed by grouping) and if S/4 ever produces it, deriving nothing
beats picking a winner. `numberAssignmentFindings` already says why nothing was filled.

**Because a derivation never overwrites, it needed a validation beside it.** A
requester who picks a different account group by hand keeps theirs, and S/4 then uses
`TBD001`'s anyway — accepted by the screen, quietly overridden afterwards, which is the
exact failure this module exists for. `accountGroupConflictFindings` reports the
contradiction against the offending row, naming both account groups. Validations run
*before* derivations, so it judges what the requester typed and never what was just
filled in.

Two things worth not undoing:

- **Which target a role reaches for comes from `TBD002`/`TBC002`, not from the role
  name.** Pattern-matching `FLCU*` would be shorter and would be a guess; a role whose
  category drives neither a customer nor a supplier (a contact person, say) is
  measured against no grouping at all, which is most of the noise avoided.
- **The inbound rows are exposed but never read.** MDM Light only ever creates business
  partners, so `CUSTOMER_TO_BP` / `VENDOR_TO_BP` describe a journey it does not make.
  They are in the views because leaving half a table behind is how the next person ends
  up re-deriving where it lives, and a test pins that a rule cannot mistake one
  direction for the other.

#### The S/4 standard checks only see accepted values (fixed 2026-08-27)

`runDerivations` returns a third payload, `systemDerived`: what was **typed**, plus only the
entries a derivation marked `system: true`. `checkStandard` runs on that, never on `derived`.

Before this, S/4 was objecting to postal codes VIES had merely *proposed* — an error a requester
cannot clear, because no field on the screen holds the value it is about. A proposal the requester
accepts is written into the payload by `_applyProposals`, so it arrives as a typed value on the
next press and is checked then. **Acceptance is the gate**, and nothing else had to change to
enforce it.

- **`cvi_account_group` is the only `system` derivation**, and the flag is load-bearing twice
  over: `TBD001` decides the account group whatever the screen says, so checking against it is
  checking reality — and it is what *creates* the `Customers`/`Suppliers` node, without which
  `ZMDML_BPCHECK` sends no relation node and the **customer and vendor tiers silently examine
  nothing**. Withholding it would have taken the whole tier out while still reporting a clean run.
- **The duplicate check still reads `derived`.** A value nobody accepted yet makes the comparison
  better without committing anyone to anything, which is the whole reason derive precedes match.
- **`systemDerived` is replayed from `applied`, not written in the derivation loop**, so an entry
  the pipeline refused to write (a typed value already there) is not replayed either. A keyed entry
  is replayed **by key**, not by index: this payload holds only the `system` entries, so a row's
  position in it is not the position it had in `derived`.

##### And they are not SHOWN until the proposals are answered (2026-08-28)

The half `systemDerived` could not solve, reported from the live app: *"if City for example is
proposed... the S4 check already triggers warning users that it's required... now user gets the idea
that they're missing info, while the derivations already filled it in for them."* Correct on both
sides — S/4 genuinely does not have the City, because nobody has accepted it yet — and reading, to a
requester, as a contradiction between a strip and the dialog on top of it.

**Filtering the stale findings out is not possible, and that is a property of the mapper.**
`bp-check.js` flattens every S/4 message to `{ severity, message }`, formatting the class and number
**into the text** and deliberately discarding S/4's own `field` — `MAINTAIN`'s
`BAPIRETM → BAPIRETI → BAPIRETC` anchors nothing to a field or a row anyway. So "was this message
about City?" can only be answered by a regex over prose or a hand-maintained `(class, number) →
field` map, which fails silently on everything not in it with no safe direction to fail. Worse,
removal is only half of it: an accepted value can make a **new** message appear (a filled city
brings a region/postal-code plausibility check; an accepted VAT number changes `VMD_API/043`), so a
removal-only reconciliation would hand back a cleaner list than S/4 would actually give — the
all-clear-from-a-check-nobody-ran this codebase refuses everywhere.

So the answer is **when**, not **which**. `checkRequest` returns `StandardJson` **separately** from
`ValidationsJson` (filtered by object identity out of `result.validations`, so it cannot drift from
what `runChecks` merged), and `_resolveStandardChecks` decides on the way out of the dialog:

- **Nothing to propose** → they were never held; they go up on the first press, one round trip, as
  before.
- **Nothing accepted** (Not Now, Escape, everything unticked, every value edited back to what it
  already was) → the payload is unchanged, so the held findings are exactly right. Shown as they
  are: **no second round trip, and no second vendor number.** A requester who declines the city
  *does* then see "City is required", which is the correct answer to what they just decided.
- **Something accepted** → what S/4 was told is out of date, so `_rerunStandardChecks` asks again
  with `Propose: false`. One extra round trip and one extra `NRIV KREDITOR/02` draw, on the press
  where a fresh answer is wanted anyway (gaps settled as acceptable 2026-08-26).

`_applyProposals` **returns the number of fields it changed** for exactly this, and the count is
what `afterClose` reads — not whether Apply Selected was pressed. The re-run replaces the message
set rather than merging: it is a real check of the new payload, and its declined proposals are
dropped rather than offered a second time inside one press, because pressing Check again is how a
requester asks for those. A re-run that fails says so as a warning, never as silence.

#### SPRO derivations: nine gaps, one open mechanism (2026-08-27)

The app derives the CVI account group, VIES/GLEIF addresses and the steward's own rules. **Nine
things SAP standard fills in and this app does not** are listed with their customizing sources in
`mdmlbpcheck/README.md` — partner functions, address language / time zone / transportation zone /
tax jurisdiction, tax classification rows, withholding tax types, search term, and reference-customer
defaults. Out of scope by decision: the BP, customer and vendor **numbers**, which CVI assigns at
post time.

**Partner functions need no new node** — `StagedCustomerSalesPartnerFunc` and
`StagedSupplierPartnerFunc` already exist, are catalogued, and are on the screen. Only the
customizing source is missing, which is true of every row in that table.

**The mechanism is settled (2026-08-27), and it is the deterministic one.** Four probe rounds
established that S/4 has no callable way to tell us what it would derive: `CL_MD_BP_MAINTAIN` is
**final**, the only two methods that hand the payload back enriched are **protected and private**
respectively, and all eight public methods take `i_data` as `IMPORTING`. A real `MAINTAIN` rolled
back would harvest everything but cannot be what a Check button does — it creates the partner, and
number assignment commits outside the LUW. So each derivation is read from its own customizing
through a CDS view, exactly the way `cvi_account_group` reads `TBD001`. Every source table is
confirmed to exist with data; the full write-up, including two wrong table guesses and the
`SEOCOMPO` visibility trap that cost a round, is in `mdmlbpcheck/README.md`.

**Do not copy `cvi_account_group`'s `system: true` flag onto these.** That flag says "S/4 will use
this whatever anyone ticks", which is true of the CVI account group and of nothing else here — a
derived language or partner function is a proposal like every other.

##### Two of them are live: `srv/checks/derivation-checks.js` (2026-08-27)

One stage, `sap_derivations`, reading `DerivationConfigService` with the same 60s cache
`cvi-checks.js` uses. It runs **last** in the derivation list — the pipeline never overwrites, so a
steward's configured rule and a VIES lookup both outrank a country default, which is the weakest
claim on any field here. On Check and Duplicate Check only; submit still validates without deriving.

- **Address language** from `T005-SPRAS`, on **every** address row. Unlike the registry lookup this
  is not a fact about one *place* that a second address would be wrong to inherit — every address in
  a country has that country's default language. This is the `FSBP_GENERIC/008` field.
- **Customer tax category** from `TSTL`, and the only multi-row derivation here. It proposes the
  ROWS; **`CustomerTaxClassification` is left empty on purpose** — that is a decision about the
  customer, not something any customizing table knows. Only fires when the request asks to be a
  customer, and never into a section the requester already filled.
- **A country with several tax categories is said out loud.** The pipeline creates only the first
  row of an empty section, so the others come back as a `field`-less statement naming all of them.
  Covering one of five silently would read as "these are all of them", which is the answer this
  codebase refuses everywhere.

- **Address time zone** from `TTZ5S`, added 2026-08-27 along with `StagedAddresses.AddressTimeZone`
  (`ADRC-TIME_ZONE`). **Keyed by country AND region**, so an address with no region has nothing to
  derive — and that is said as a statement rather than skipped, because "no time zone appeared" and
  "your address needs a region first" are different answers. One statement however many rows are
  short of a region. Where a region carries several zones, `TZONEDFT` decides; where several exist
  and **none** is marked default, nothing is derived — that is a customizing gap, not a coin toss.
- **`TransportZone` is deliberately NOT staged.** `TZONE` holds valid zones per country and carries
  no determination data at all, so nothing could ever fill it. A column would be a field the
  requester has to type with no help, which is what this whole feature exists to remove.

**A created tax row needs TWO entries**, and the mechanism is worth knowing before adding a third
multi-field derivation: `createsRow` writes exactly one field, so the departure country comes from a
second entry that finds the row the first one made. `runDerivations` applies each entry to `derived`
as it goes, so within one stage a later entry sees an earlier entry's row. Without it the row would
carry a tax category and no departure country — half a `KNVI` key.

- **Mandatory customer partner functions** from `TKUPA` → `TPAER`, added 2026-08-27 once the link was
  found. `TKUPA`'s key is the **account group alone**; `T077D` carries no procedure and
  `T077D-KALSM` turned out to be output determination. Only **`PartnerType` = 'KU'** rows are
  proposed — `TPAR-NRART` is what stops a vendor function landing on a customer sales area, the same
  class of error `accountGroupConflictFindings` reports. **`BPCustomerNumber` and `PartnerCounter`
  are never proposed**: SAP defaults those functions to the customer itself, which on a create has
  no number, and the counter is S/4's to assign. Needs a `CustomerSalesArea` row, because the node
  is keyed by one; three extra entries fill that key from the row the requester already added.

- **Mandatory SUPPLIER partner functions** from `T077K-PARGE` → `TPAER`, added 2026-08-27 after
  Maarten spotted that only the customer side was wired. **The vendor link is a different table**:
  the customer procedure lives on `TKUPA`, the vendor one is three columns on the account group table
  itself, one per level — `PARGE` purchasing organisation, `PARGT` sub-range, `PARGW` plant,
  confirmed from the served `sap:quickinfo` rather than inferred. **Only `PARGE` is joined**, because
  the app stages a purchasing-organisation row and nothing below it; `SupplierSubrange` and `Plant`
  are therefore never filled. Mirrors the customer stage otherwise, with the guard inverted:
  `PartnerType = 'LI'`, because procedure `AG` carries `LF` (vendor) and schema `0001` carries `AG`
  (customer), so each side would otherwise propose the other's functions.

###### All of the mandatory functions, and beside what somebody typed (2026-08-28)

Reported from the live app the day after the paging fix landed: `AG` derived, and *"I think there
are 4 mandatory?"* Both stages proposed the FIRST mandatory function and named the rest in a
`field`-less statement — not a decision, a workaround: `createsRow` could only invent a row into a
**completely empty** section, so one row was all the pipeline could carry.

**`rowKey` is what lifted it.** An entry may now name the row it belongs to, and `rowMatchesKey`
(`pipeline.js`) decides whether that row is already there. So `createsRow` may append **beside**
rows somebody added deliberately, because the key says which row this is — the guard that used to
be "the section is empty" is now "no row already carries this key". An entry **without** a key keeps
the old rule exactly, and that asymmetry is the design: *"fill in the city"* says nothing about
which address it belongs to, so there is no safe row for it to add.

- **Every entry of one row carries the same key**, which is how the three that complete a sales
  area find the row the `createsRow` entry made. Nothing counts indices any more — the previous
  version relied on the section being empty so that index 0 was the row just added, which stops
  being true the moment a second row can be proposed.
- **The reported `index` is where the row actually landed** (`indexOfRecord`), because the dialog
  groups on it — see "A whole derived row is one line" below.
- **A blank level is not a key.** The sales area contributes only the levels the requester filled
  in; a blank compared against a row that HAS that level fails, and the section would then collect
  a second copy of every row. Guarded in the derivation *and* in `rowMatchesKey`.
- **A blank on the EXISTING row counts as a match**, because the entry's own key fields are what
  would fill it: a requester who typed `AG` and left the sales area empty has the row this
  derivation was about to add, so it is completed rather than duplicated. A row the request is
  deleting (`action: 'D'`) holds nothing and matches nothing, mirroring `liveRows`.
- **A partly-filled section is no longer a reason to say nothing.** `if (liveRows(...).length)
  return []` is gone from both stages: a requester who entered `AG` themselves gets `RE`, `RG` and
  `WE` proposed and their own row left alone.
- **The statement went with it.** "One row is proposed; add the others by hand" existed to cover
  what the pipeline could not do. The tax-category one **stays** — that is a genuine "one of five"
  report about a decision no customizing table can make (`CustomerTaxClassification`), not a
  workaround. Multi-row is now available to it if it is ever wanted.

Which derivations are customer-only, and why it is not an oversight: **tax categories** — `KNVI` has
no vendor counterpart, vendors carry no tax classification node. **Withholding tax** is symmetric in
being absent from both: `T059P` has no mandatory flag, so there is nothing to propose unasked on
either side. Address language and time zone are BP-level and have no customer/vendor split at all.

##### The rule about what a derivation may say (Maarten, 2026-08-27)

**A requester never reads "you could have X if you filled in Y."** They fill in what they know, and
the system completes whatever it can. So a derivation that cannot fire for want of an input derives
nothing and **says nothing** — no strip about a missing region, no note about an absent sales area.
A message they cannot act on and did not ask for is noise, however true it is.

Two things this does **not** cover, and both still speak:

- **What the derivation did but only partly.** "This country has 5 tax categories, one row is
  proposed" reports the result, not a prerequisite. One of five read as all five is a wrong answer;
  the region note was merely unasked-for advice.
- **Settings that could not be read at all.** A derivation that silently did nothing is
  indistinguishable from one that had nothing to do, which is the failure this codebase refuses
  everywhere.

##### The customizing reads are paged, and were not (fixed 2026-08-27)

**The remote value-help service caps a response at 100 rows.** `cvi-checks.js` and
`derivation-checks.js` both read their customizing with a bare
`service.run(cds.ql.SELECT.from(entity))` and used the answer as the whole table. Twelve reads,
every one of them silently truncated. `srv/checks/config-reader.js` is the fix and both files now
call `readAllOf`.

How it presented, because the shape of this is worth keeping:

- Tables **under** 100 rows were complete, so most checks worked. `taxCategories` (51) and
  `supplierFunctions` (12) were always right.
- `DerPartnerFunctionAccGrp` is keyed `(AccountGroup, PartnerFunction)` and account group `0001`
  alone is 18 rows, so page one never reached `DEBI`. Correct customizing, a valid payload, and
  **nothing proposed**.
- `countries` and `timeZones` were capped too and nobody noticed, because `BE` is early
  alphabetically.

Two decisions inside `config-reader.js`:

- **`skip` advances by what arrived, never by `pageSize`.** Ask for 500, get 100, start the next
  read at 100. The server's page size is its own business and is not worth discovering.
- **The loop ends on an EMPTY page, not a short one.** `readAllPages` in
  `business-partner-service.js` stops on a short page, which is right when the caller sets the page
  size and is exactly wrong here — the read that lost `DEBI` was short *because* the server capped
  it. One extra round trip per table per cache period, against a 60s cache.

Diagnosing this took three rounds of wrong guesses, all of them inference from partial data, and it
was `[sap-derivations]` in `cf logs` that ended it in one press. The log line is in
`derivation-checks.js#diagnose` and reports the five config **row counts** alongside every field the
builders branch on — because a truncated read looks exactly like customizing that says nothing.

Still unpaged, deliberately: `fetchWorkflowEntityRows` reads one partner's child rows, where 100 is
not a realistic count. Everything else on that list is local Postgres, where the cap does not apply.

#### Two standard-check messages nobody could clear (fixed 2026-08-27)

Both reported from the live app after the customer/supplier tier went on, and both were in the
ABAP mapper rather than in the request. Full write-up in `mdmlbpcheck/README.md`.

- **`VMD_API/043`** (EU vendor needs a VAT registration number) fired on every EU vendor because
  `ZCL_MDML_BPCHECK` never built a `TaxNumbers` node — `ty_sections` had no such member. Nothing
  typed on the Tax Numbers section reached the check. Same blind spot fed `CVI_API/007`.
- **`FSBP_GENERIC/008`** (LANGU in ADDR1_DATA) was *caused* by the mapper: `datax-langu` was set
  unconditionally, and a blank with the X-flag set means **clear this field**. `StagedAddresses`
  had no `Language` column, so every request cleared LANGU and then failed the required check.

So `StagedAddresses` gained **`Language`** (ADDR1_DATA-LANGU, `String(2)`), and it is on the
address section of the maintenance screen. **It is not `CorrespondenceLanguage`** — that one is
BP-level (`bp_centraldata-partnerlanguage`) and person-only on an organisation, which is `R11/336`.
Filling the correspondence language can never satisfy an address-level LANGU, and on an org it
buys a second error. Keep the two apart.

`payload-fields.js` is generated from `db/staging.cds`, so the new column reaches the rule catalog
with no further change; `BusinessPartnerMetadata.js` is regenerated by `npm run generate:metadata`,
which `build`/`build:cf` already chain.

#### The Why column is three words, with the sentence on hover (2026-08-27)

A derivation entry carries a short `label` beside its long `message`; the proposal dialog shows
`label` as **Why** and puts `message` in that cell's **tooltip**. Labels: `VIES check` /
`GLEIF check` (`registry-checks.js`, named after the source rather than the action — a requester
needs to know which register to argue with), `CVI customizing`, `Derivation rule`.

Normalisations get theirs from the **model**: `PROPOSAL_SCHEMA` requires `reason` *and* `detail`,
the prompt asks for at most three words and one or two sentences respectively, and `shortReason`
clamps to three words server-side whatever comes back. A proposal with no `detail` falls back to a
stated sentence rather than `''` — an empty tooltip reads as a broken one.

A field that was derived and then reformatted is still one row: the derivation's label leads (it
is why the field has a value at all) and the reformatting is appended to the **tooltip**, rather
than growing the label past three words.

#### A whole derived ROW is one line (2026-08-28)

Reported from the live app: *"I just entered Sales org, dist ch, division, and then the derivation
triggers for the partner function (which also has a Sales org, dist ch, div field) so to an enduser
it looks like it's filling in what I just entered."* A created row takes several entries —
`createsRow` writes one field and the rest complete its key — so with four mandatory partner
functions the dialog would have shown **sixteen** lines, twelve of them reading the sales area back
to the person who had just typed it.

`_proposalRows` groups derivation entries on **target + index** — which the pipeline resolves per
row, so entries of one row always share it and entries of two rows never do — and a group whose
lead entry carries a **`rowKey`** collapses to one line built by `_derivationRow`.

**The key is the boundary, and grouping on `createsRow` instead was a regression** — shipped and
reported within the hour: *"I can't choose or edit anything in the address popup anymore?"*
`registry-checks.js:42` sets `createsRow` on **every** address entry when there is no address row
yet, so Street, Postal Code, City and Country collapsed into one line with only Street editable.
A `rowKey` is what says the other entries **identify** the row rather than describe it — a partner
function's sales area is not a value anybody edits, it is *which row this is*. Address fields from
VIES are five independent values a requester may well want to edit or decline separately. So an
unkeyed row-adding entry keeps its own line and its own field name, and still says *Row added*;
`test/proposal-rows.test.js` pins the address case for exactly this reason.

For a keyed group:

- **The Field column names the SECTION** ("Customer Partner Functions"), not the field, because the
  row is what is being accepted; a field name alone reads as a field somebody still has to fill.
  A plain filled-in field is still named by itself, so nothing about those lines changed.
- **`subtext` under it carries the key** — "Sales area 1710 / 10 / 00" — visible without hovering,
  asked for directly. The Why column's tooltip still holds the whole sentence, which now says which
  sales area the row is for as well.
- **The row is accepted or declined WHOLE.** Only the lead is tickable and only its value is
  editable; the key fields travel with it as `extras` and `_applyProposals` writes them together.
  They were separate ticks resolved by index before, which breaks as soon as more than one row can
  be proposed: declining the second row shifted the third's key fields onto it.
- **Idempotence moved to the whole key.** `_applyProposals` used to refuse a row whose lead value
  already existed; `AG` under a second sales area is a different row, so it now compares every key
  field, with a blank on the existing row counting as a match — the same rule `rowMatchesKey`
  applies server-side.

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

#### Checks run on a button press, and only on a button press (2026-08-27)

**Derivations and proposals happen when the requester presses Check.** Nothing on
the form triggers a check by itself. Maarten, 2026-08-27: *"only trigger
Derivations/Proposals after a 'Check' button was triggered. Now it's firing a lot
when a user is typing because '+' or 'add' buttons trigger it as well."*

`_onFieldCommitted` survives and does local work only — it recomposes
`BusinessPartnerFullName` and redraws the change summary when `trackChanges` is on.
It makes **no server call**, and `test/check-triggers.test.js` pins that: no
`_executeAction`, no `checkRequest`, no `setTimeout`, no `_offerProposals`. Adding a
debounced check back here is a one-line change, which is why the absence is tested.

`_cancelPendingTrigger` keeps its name and has no timer left to cancel: it empties
`_declinedProposals`, so pressing a check button asks again. Every button that runs
a check still calls it first — Check, Duplicate Check, Save/Submit/Resubmit,
Withdraw — before the client-side validation, so a press that fails that check has
still superseded the earlier declines.

##### Why the automatic trigger was removed

Worth keeping, because the feature looked correct the whole way down and was not.
Between 2026-08-17 and 2026-08-21 the trigger acquired a guard for every double-dialog
reported against it, and **every guard worked as designed**:

- Hung off `change`, never `attachLiveChange`; never a `MessageBox`, never
  `state.busy`; one at a time, dropped rather than queued; a failure was a
  `console.warn`.
- `_cancelPendingTrigger` cleared `_idleTimer` and `_triggerTimer` and nulled
  `_pendingScope`, because a *scheduled* trigger fired the moment a button released
  busy (fixed 2026-08-19).
- `_buttonRun` dropped the result of a trigger a button had overtaken mid-flight,
  since the busy check happens before the await.
- `_rememberDeclined` keyed a decline on `target|index|field|proposed` rather than
  the payload, because `_lastTriggerKey` (`scope|propose|dataJson`) could not tell
  two checks over a changed payload apart (fixed 2026-08-21).

The premise was what was wrong: **opening a record dialog commits the cell behind
it.** So "+" and "Add" fired checks nobody asked for, mid-typing, repeatedly — and
no amount of de-duplication fixes a check that should never have started. The
mechanism cost an AI Core call and a remote round trip per accidental commit.

What is left of it, and why:

- **`Propose : Boolean` and `Scope : String(40)` on `checkRequest` stay.** The
  duplicate check still sends `propose: false`, and `checkStandard: standard && !scope`
  still keeps the SAP standard checks off a scoped call. They are simply no longer
  sent by anything automatic.
- **`_rememberDeclined` / `_isDeclined` stay** as the record of what was offered and
  refused. Nothing filters on it now — every dialog comes from a press, and
  "declining is not ticking it, and the next Check proposes it again" is this
  dialog's contract. `_emptyState` empties it too: declines belong to the record on
  screen.
- **Recorded in `afterClose`, not on the Not Now button** — Escape is a decline as
  well, and after *Apply Selected* the unticked rows are declines too.
- **One dialog at a time** (`_proposalsOpen`).

Gone entirely: `REGISTRY_TRIGGER_FIELDS`, `TRIGGER_DELAY_MS`, `TRIGGER_IDLE_MS`,
`_runTriggeredCheck`, `_scheduleTrigger`, `_flushPendingScope`, `_triggerInFlight`,
`_lastTriggerKey`, `_pendingScope`, `_triggerTimer`, `_idleTimer`.

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

A partner with an in-flight change request used to be **hidden** from the
Business Partner list so two people could not edit it at once. Since 2026-08-24
it is listed and **marked** instead — see "The merged search list" above.
`ACTIVE_REQUEST_STATUSES` still decides what counts as in-flight, and `failed`
is in that list on purpose, because a failed post is not atomic and may have
left the partner half-written. What it now governs is the **refusal to edit**
(`openEditPage` in `CustomActions.js`) rather than what the list shows.

Change requests have their own list (`ext/view/ChangeRequestList.view.xml`),
reached from the Change Requests button on the list report. **The button is
steward-only** (`{perm>/isDataSteward}`), and since the rules moved to their own
tile it is the last steward-gated action on the list report.

### The MDM Configuration Panel tile — its own app (`app/mdmrules`, 2026-08-17)

Rule configuration left the Maintain BP app's toolbar and became its own tile.
`app/mdmrules/webapp/ext/view/MDMRuleHub.view.xml` is the landing page: five
`GenericTile`s for **Duplicate Check Rules**, **Validation Rules**,
**Field Properties**, **Derivation Rules** and **Workflow Agent Determination**.

**Renamed on the screen 2026-08-25, not in the code.** The tile and page titles are now
"MDM Configuration Panel" and "Workflow Agent Determination"; every technical id is unchanged -
`app/mdmrules`, `sap.app.id` `mdm.md.mdmrules.manage`, the `MDMRules-manage` inbound and its
`MDMRules` semantic object, the `WorkflowRules` entity, the `WorkflowRuleList` route and the
`/service/duplicateconfig` path. Renaming any of those costs a re-point, a route change or a
migration for nothing a user can see - the same reasoning that keeps the service path named
`duplicateconfig` after it grew four more tables.

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

#### Gating derivations by role/field property, and re-validating at every gate (2026-08-31)

Asked for directly, "heel belangrijk": a derivation must not propose a value into a field the
current screen cannot edit, and the validations should run again at submit/resubmit/approve, not
only at the moment of a first Check. Two separate mechanisms, because they answer different
questions - "may this be shown" and "does this still pass" - and conflating them would have made
either one impossible to reason about alone.

**Gating what a derivation may propose.** `runDerivations`/`runChecks` (`srv/checks/pipeline.js`)
take an optional `fieldEditable(target, field)` predicate. An entry whose target field the
predicate refuses gets **no entry at all** - not written, not reported, not offered as a proposal -
the same "a requester never reads what they cannot act on" rule that already governs a derivation
with no prerequisite (see "The rule about what a derivation may say" above). A field-less statement
entry is checked the same way with `field` left `undefined`, which resolves to the entity's own
state via `effectiveProperty`'s cascade - a statement about a section the role cannot see is exactly
as unhelpful as a value it cannot edit. No caller passing a predicate means every field stays
editable, exactly the behaviour before this existed.

`runRequestChecks` (`srv/change-request-service.js`, backing both `checkRequest` and
`duplicateCheckRequest`) builds the predicate from `fieldState`, resolved for the **screen's own
role** - narrowed to the caller's specific BTP role the same way `effectiveFieldProperties` narrows
it, so "Approver Customer" is gated by its own profile rather than by every "Approver" profile in
the table. This is a **separate** resolution from the one already in `runRequestChecks` for the
mandatory-field validation gate, which stays hardcoded to `requesterContext(req)` on purpose - that
one is a security boundary (a client naming its own role could submit past a mandatory field), gating
a proposal is not, so the caller's own `Role`/`RequestType` are trusted for this half only. Both
actions gained `RequestType`/`Role` parameters for it; a caller that sends neither (an older client,
or a direct service call) resolves to `role: null`, which matches only `*` profiles - ungated for
anything scoped to a specific role, exactly as before this existed. The client sends them from
`_checkRole(state)`, the same `approve`/`datasteward`/else-`Requester` mapping `_loadStagedRequest`
already uses for `_loadFieldProperties` - so a Check pressed on the approve screen (the button stays
visible there; approve has never had its own gate on it) cannot open a dialog offering to fill in a
field the object page itself never lets an approver touch.

**Re-validating at every gate.** `submitRequest`, `resubmitRequest` and `decideDataStewardReview`'s
`complete` branch used to carry three literal copies of the same validation stage list. They now
share one function, `runSubmitValidations(req, payload)`, defined once beside `runRequestChecks` -
purely a deduplication, zero behaviour change, and it closes the drift risk of the three ever
disagreeing about what "the check" means.

**`decideRequest`'s approve path never ran any of this before** - it went straight from
`postedBP`/status guards to writing `status: 'approved'` and posting. It now calls
`runSubmitValidations` too, over `loadStagedPayload(changeRequest)` (the same `{root, sections}`
reconstruction `getRequestPayload` does, extracted so the two cannot drift on how they read staging).
A blocking result rejects the action outright - safe because nothing has been written yet at that
point, unlike a failed *post*, which is why that failure mode uses `ErrorMessage` instead (see
"Signalling the outcome" above): the request stays `inApproval`, the task stays open, and the
approver sees why rather than the partner being created against data that no longer passes. The
reasoning for approving is the last point before S/4 ever sees the request: the configuration behind
a rule (a mandatory field, a CVI account group mapping) can have changed since the request was
submitted.

**Derivations still never run on approve**, deliberately: nothing on the approve screen is editable,
so there is nobody left to show a proposal to even if one ran. This is the other half of "in
Approval stap niks tonen" - the first half is the predicate above, for the Check button; this half
is that the automatic re-check on Approve was never a derivation to begin with.

##### The silent version above was not what "geactiveerd" meant (revised the same day)

Reported back within hours: "als ik op de approve submit of resubmit button druk dan wordt die
check niet uitgevoerd" - a validation gate that only speaks up when something is WRONG reads as "no
check happened" when the data is fine, which is indistinguishable from what shipped before this
section existed. Asked directly what "the check" meant: **the full Check-button experience** -
validate, derive, and show what was found or proposed - not only a pass/fail gate.

`_runPreActionCheck` (`BusinessPartnerMaintenance.controller.js`) is that: `onSave` (Submit and
Resubmit, standalone and the embedded My Inbox rework action, which already calls `onSave` itself)
and `onApprove` both call it before doing anything else, from a button press - not from typing, not
scheduled, so it does not reopen the door "Checks run on a button press, and only on a button press"
closed. It calls `checkRequest` exactly as `onCheck` does and:

- **Blocks with the same message `onCheck` shows** on an invalid payload, before the real
  submit/resubmit/approve action is even attempted.
- **Opens the SAME `_offerProposals` dialog** when there is something to derive or reformat, and
  waits for it to close before letting Submit/Resubmit actually proceed - `_offerProposals` gained
  an optional `onResolved` callback for exactly this, fired once `_resolveStandardChecks` has
  settled. The requester still has to have seen and ticked (or declined) whatever it found; nothing
  auto-applies, same as pressing Check by hand. **Now two callers of `_offerProposals` share the one
  vetted dialog** - `onCheck` and this - never a second, cheaper way for a proposal to reach the
  screen.
- **Never opens that dialog for Approve** (`forApprove: true`, also skipping the AI normalisation
  call entirely - nothing there could be reformatted towards anyway). `decideRequest` takes no
  `DataJson`, so an approver "accepting" a proposal on that screen would have nowhere for the
  acceptance to go - the same reasoning that already kept approve out of every proposal-dialog path.
  Checked before the confirm dialog even opens, so a request about to fail validation does not first
  make the approver confirm they want to approve it.

The server-side `runSubmitValidations` gate above is unchanged and still runs on every one of these
three actions regardless of what the client did or did not check first - belt and braces against a
direct service call, and the actual security-relevant gate (`requesterContext` is still hardcoded on
every write path).

### The shared maintenance screen (`app/reuse`, 2026-08-20)

The Business Partner maintenance screen — the object page used for create, edit,
approve and rework — lives in **`app/reuse`**, not in either app that renders it:

```
app/reuse/src/mdm/md/businesspartner/reuse/
  controller/BusinessPartnerMaintenance.controller.js
  view/BusinessPartnerMaintenance.view.xml
  BusinessPartnerMetadata.js      (generated)
  BusinessPartnerAssistant.js
  css/maintenance.css
```

Two apps render it: `app/businesspartner` (the Work Zone tile) and `app/bptask`
(the My Inbox task UI). It moved there rather than being copied, because a second
copy of a 2,400-line controller drifts and nobody notices until the two screens
disagree about what a request contains.

**The screen was already freestyle** — a plain `sap/ui/core/mvc/Controller`, and a
view over `sap.m`/`sap.uxap` — which is what made the extraction cheap. It has no
`sap.fe` dependency and must not gain one: `test/task-form.test.js` fails if it
does, because the task app has no Fiori Elements libraries to satisfy it.

#### It is copied at build time, not deployed as a library

`tools/sync-reuse.js` copies the folder into each consumer's `webapp/reuse`
(gitignored, never edited), and each manifest maps the namespace onto it:

```json
"resourceRoots": { "mdm.md.businesspartner.reuse": "./reuse" }
```

So the module names are identical in both apps — `mdm.md.businesspartner.reuse.*`
— and there is exactly one copy in git.

**A deployed UI5 library would have been the textbook answer and is the wrong one
here.** An HTML5-repository library is addressed by its version-stamped URL, and a
stale version reference is precisely what made the task UI 404 on 2026-08-20
(`…manage-1.15.0/Component.js`). Copying at build time leaves nothing to resolve
at runtime. `app/reuse` is still shaped as a real UI5 library project (`ui5.yaml`
`type: library`, `.library`, `library.js`) so that decision can be revisited
without moving a file — but nothing loads `library.js` today.

Consequences worth knowing:

- **`npm run generate:metadata` writes into the library**, not into an app. Both
  consumers pick the new `BusinessPartnerMetadata.js` up on their next build.
- **Every build runs `sync:reuse` first.** `build` and `build:cf` in both apps
  chain it, and `mta.yaml` calls those. Editing `webapp/reuse` directly is
  pointless — the next build deletes it.
- **The controller attaches only to routes its host declares.** The partner app
  routes all six (create, display, maintain, approve, edit, rework); the task app
  declares only approve and rework. `onInit` skips a missing route rather than
  throwing, which would take the whole screen down instead of one entry point.
- **`ui5 build preload` bundles `webapp/reuse/**` under the consuming app's own
  namespace**, which is not the name the runtime asks for, so the shared modules
  load as individual files from `dist/reuse/…` and the bundle carries unused
  copies. It works and it is not free; excluding them from the bundle is a
  worthwhile follow-up, not a correctness fix.

#### The task app (`app/bptask`)

Third HTML5 app, same pattern as `app/mdmrules`: unique `sap.app.id`
(`mdm.md.businesspartner.task`), **shared `sap.cloud.service`**
(`mdm.md.businesspartner`), its own `xs-app.json` reusing the
`mdm-businesspartner-srv-api` destination, and one more entry in
`tools/package-html5.js` and in the app-content module's build commands.

**It declares no `crossNavigation` inbound**, deliberately: My Inbox resolves a
task UI by `sap.cloud.service` + `sap.app.id`, not by intent, so the
one-inbound-per-app limit in Work Zone standard edition never applies to it — and
it needs no tile, no catalog and no role assignment.

What stayed behind in `app/businesspartner`: the List Report, the object page, the
`CustomActions` toolbar wiring, and the `bpurl` **query-parameter** deep link
(`?changerequestid=`). What left: `sap.bpa.task`, the `inboxAPI` actions, the task
context load and the `PATCH task-instances/{id}` completion. The `env>/embedded`
model stays set — to `false`, always — because the shared view binds it to decide
whether to draw its own decision buttons, and in the task app it is sometimes true.

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

#### Multiple values per condition — built, withdrawn, and what it would take

**Every rule table takes ONE value per field.** Multiple values per condition were built on
2026-08-21 across all four tables and **withdrawn the same day** on Maarten's instruction, after
three deployed attempts failed. It is on the list for later; the notes below are what the next
attempt needs, because the idea is fine and the implementation route was not.

What was tried, in order, and how each one failed **in the deployed app**:

1. **A `MultiInput` whose tokens were written with `context.setProperty`.** The value reached the
   client model and never the server. It looked saved while navigating inside the app — the model
   cache was answering — and was gone the moment the app was left and re-entered.
2. **A hidden bound `Input` beside the token cell, writing through the binding.** That fixed the
   saving and broke the typing: the write path re-read the model to redraw the tokens, and through a
   two-way binding that read does not reliably see what was just written, so it returned the
   previous value and deleted the token a line after adding it.
3. **Drawing what was written instead of re-reading.** That exposed the worst one: `removeAllTokens`
   makes the control report every token as removed, the `tokenUpdate` handler computed the resulting
   list as empty, and the write went through the bound sink — so **opening a page blanked every
   stored condition value on it.** A `redrawing` guard stopped the loop and the cells still did not
   work.

The common thread, and the lesson for the next attempt: **a hand-managed aggregation alongside a
bound column is the wrong shape.** Every column on these pages that saves is written by a plain
two-way binding, and each fix above was another patch on the gap between the tokens and the
binding. Whatever comes next should make the binding the only writer from the start — a child
entity with one row per value and a real list binding, or `sap.ui.mdc`'s multi-value field, not a
`MultiInput` synchronised by hand.

What the withdrawal left behind, deliberately:

- **`srv/checks/value-lists.js` stays as a READ path.** Rows written while the feature was live may
  hold `BE|NL`, and `conditionHolds` (`srv/checks/rule-engine.js`), `holds`
  (`srv/ai/duplicate-engine.js`) and `resolveApprovers` still parse a delimited list and OR across
  it. A stored rule that silently stopped matching is the failure this codebase refuses everywhere
  else. A single value is a one-entry list, so the tolerance costs nothing.
- **`WorkflowRules.conditionValues` / `conditionValues2` keep their PLURAL names** and hold one
  value. `cds-deploy` cannot rename an element any more than it can drop one — the same reason
  `createsRow` and the four `cond*` columns are still in the model.
- **`app/mdmrules/webapp/ext/ListCell.js` was deleted**, not left dormant. Half a mechanism nobody
  calls is what the next person mistakes for a working one.

**`WorkflowRules.approvers` therefore holds one approver**, and several approvers are **several
rows** — which is what Maarten asked for originally ("an extra line can be used to add extra
approvers") and what `resolveApprovers` already merges. The role value help stays: an address is
typed, a role is picked, one per cell.

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
which `test/field-property-apply.test.js` proves exhaustively. **Nothing therefore
reads a precedence.** A `sequence` was modelled for one, removed on 2026-08-20 when
Maarten asked what the Order column was for — and **put straight back the same day
as dead weight**, because removing it failed `deploy_to_postgresql` four times over:
it had already reached the deployed model, and `cds-deploy` cannot drop an element.
So the column stands in `db/field-properties.cds` and nothing reads it, the same way
nothing reads `createsRow` on `DerivationRules` or the four `cond*` columns on
`DuplicateRules`. The merge is a join, so no profile is ever "first"; the grid shows
no Order cell and the resolver never sorts.

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

**"Both layouts" used to mean the two record-dialog forms, not the section's own
summary table — reported directly with a screenshot (2026-08-27): a field hidden
by a profile correctly disappeared from the Add/Edit Addresses popup
(`_createFieldGrid`/`_createFieldTable`, both already filtering on
`_isHiddenField`) but stayed as a column, and searchable, on the Addresses
section's own table.** `_summaryFields` just mapped `section.summaryFields`
straight to field objects — nothing there ever read a profile. `_renderSection`
now filters that result through `_isHiddenField` too, the same way the dialog
already does, so a hidden field is gone from the column list, the rendered
cells, and the search.

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

#### The approval role is BTP-sourced now, by naming convention (2026-08-27)

`Approver` and `DataSteward` stopped being fixed values the same day they were
first added. The first version kept all four (`*`/`Requester`/`Approver`/
`DataSteward`) and only *appended* BTP role collections alongside them; Maarten
asked for the hardcoded two to come out entirely, so a profile's role is now one
of `*`, `Requester` (`ROLES`/`ROLE_TEXT` in `field-properties.js` - the only two
concepts that are not a role collection), or a BTP role collection name.

- **The picker still sources from `workflowAgents()`** - the identical function
  the Workflow Agent Determination picker uses (see that section) - filtered to
  `type === 'Role'`, since a field property profile's role condition is about a
  screen/actor kind, not a named individual, so users stay out of this one.
- **The bare `MDMLIGHT` role collection itself is excluded**, here only (not from
  the Workflow Agent Determination picker) - it is the catalog-level role for the
  whole app, not a Requester/Approver/DataSteward-shaped one, and offering it
  would let a profile be scoped to "everyone with any access to this app" while
  looking like a deliberate, narrow choice.
- **A role is matched against the screen's own category by a case-insensitive
  PREFIX**, not an exact value any more - `profileMatches` in
  `field-properties.js`: a BTP role named `ApproverSales` or `ApproverFinance`
  both count as an Approver-category profile the way the literal `Approver`
  value used to, `DataStewardEU` counts as DataSteward, and so on. This is what
  makes the naming convention do real work: a steward names role collections by
  the layout they are meant to configure, and CAP tells them apart without
  needing to know any of their names in advance.
- **A profile saved before this change still matches.** `LEGACY_ROLES`
  (`['Approver', 'DataSteward']`) keeps the write guard accepting the literal
  values a profile may already carry, and `profileMatches` checks an exact match
  before ever falling back to the prefix - `cds-deploy` cannot rename a stored
  value any more than it can drop one, so an old row has to keep working exactly
  as it did, not merely keep saving.

#### Rendering is narrowed to the caller's own specific role (closed 2026-08-27)

The gap above did not stay open the same day it was written: a real customer
case hit it within hours. Two profiles - `Approver Customer` (hides Suppliers)
and `Approver Vendor` (hides Customers), each backed by its own BTP role
collection with different people in it - were both configured, and **neither
hid anything** for anyone. The reason was exactly the documented gap:
`effectiveFieldProperties` was always called with the bare literal `'Approver'`,
so `profileMatches`'s prefix rule matched BOTH profiles against EVERY approve
screen regardless of who was actually looking at it, and the join
("hidden" wins only when a profile that speaks says so, "visible" otherwise)
landed on "nobody's opinion about Suppliers other than one profile, nobody's
opinion about Customers other than the other" - which is visible for both,
for everyone.

- **`resolveEffectiveRole` (`change-request-service.js`) narrows `Approver`/
  `DataSteward` to the CURRENT user's own specific BTP role before
  `effectiveFieldProperties` resolves anything** - "Approver Customer" instead
  of the bare category, found via `specificRoleFor(email, category)`
  (`srv/wf/btp-agents.js`): the one of the CALLER's own `/Users` `groups` that
  starts with the category being asked about. `Requester` is deliberately left
  alone - `RESOLVABLE_ROLE_CATEGORIES` names only the two that are role
  collections at all; `requesterContext` already hardcodes `Requester` for its
  own, unrelated reason (whoever submits is the requester, not a role a client
  could name their way out of a mandatory field with).
- **`profileMatches`'s prefix check became bidirectional the same fix**,
  because narrowing the *asked* role to something specific breaks the direction
  that used to be the only one: a profile still carrying the bare legacy
  `Approver` (or one a steward deliberately left at the category level, meant to
  apply to every approver) needs to keep matching once the screen resolves
  `Approver Customer` for a specific person - `"Approver".startsWith("Approver
  Customer")` is false, so only checking the original direction would have
  silently stopped every broad profile from applying to anyone the moment
  resolution got precise. Checking both directions keeps `ApproverSales`
  matching the bare category (the original case) AND the bare category matching
  `ApproverSales` (the new one) AND two DIFFERENT specific roles apart from
  each other - neither `Approver Customer` nor `Approver Vendor` is a prefix of
  the other.
- **Ambiguous resolves to null, not a guess.** `specificRoleFor` returns `null`
  when a user's own groups carry **several** roles matching the category (as
  well as when none do), and the caller falls back to the bare category - the
  same "show everything rather than pick one arbitrarily" answer this screen
  gave before any of this existed, so a person with overlapping roles is no
  worse off than before, never silently shown a narrower screen than intended.
- **Best-effort, the same discipline as every other BTP read in this
  codebase**: an unreachable subaccount API, or a user resolving to no specific
  role, falls back to the bare category CAP always used before this - not a
  blocked render, not an error.
- **Only the rendering path changed.** `createFieldPropertyStages` (the submit-
  time enforcement) still runs on `requesterContext(req)`, always `'Requester'`,
  never touched by any of this - the security-relevant half of this design was
  already correct and stays exactly as it was.

The Workflow Agent Determination table's own gap - "Arthur's process ignores
`approvers` entirely" - is a different thing and still open: that one needs
Arthur's process definition to change, not CAP's own code, so there was nothing
here to close it with.

#### Critical fields, entity-level only, and who to notify (2026-08-26)

Three things changed together, all off the same `critical` column:

- **The Critical checkbox stopped saving.** `fieldPropertiesOf`'s read
  (`srv/duplicate-config-service.js`) selected `section`, `element`, `property` —
  never `critical` — so every reopen of the dialog rebuilt the tree with
  `critical: undefined` on every row, regardless of what was stored. The box
  looked cleared the moment the dialog was reopened, even though the save itself
  (`saveFieldProperties`) always persisted it correctly. Fixed by adding
  `critical` to that column list; the bug was on the read side only.
- **Critical is entity-level only.** `validateSetting` in
  `srv/checks/field-properties.js` refuses a row that carries both `element` and
  `critical: true` — "critical applies to the whole entity, not one field" — and
  the dialog greys the box out on a field row (`enabled="{= ${fp>kind} ===
  'entity'}"`) to match, guarded again in `onCriticalSelect` rather than trusting
  the binding alone. `resolveProfiles` still *reads* an older field-level critical
  row rather than dropping it — the same tolerance the withdrawn multi-value
  feature's delimited-list reader keeps — and the dialog's `_buildTree` never
  carries a field-level `critical` back into the editable tree, so a profile with
  one left over self-migrates to entity-level the next time someone presses
  Apply, rather than becoming unsavable.
- **Critical is a marker, not a gate — deliberately.** A first version blocked an
  empty critical entity with an error strip at the top of the screen; Maarten
  rejected that the same day. `createFieldPropertyStages` was reverted to enforce
  `mandatory` only, and `critical` contributes no validation stage on its own.

**The marker is drawn on the screen, not written as a message.** The maintenance
screen (`app/reuse/.../BusinessPartnerMaintenance.controller.js`) already loads
`effectiveFieldProperties` before every render; `_isCriticalEntity` reads its
`criticalEntities` list and `_markSectionCritical` appends "⚠" to the Object Page
section's own title (`section.setTitle`) when the section is critical — "Address
Data ⚠", not a strip, not a popup. Applied in `_renderSection` for the nine node
sections and in `_renderRootForm`/`_renderRootSection` for the two cards the root
section splits into (General Information, Names), since both render the same
`General` payload section and critical is decided per section, not per card.

**`criticalFields` became two scalar fields in the workflow context, not a list.**
`criticalfield` (lowercase on the wire, like every other key in this context —
the local variable in `srv/change-request-service.js` stays `criticalField` for
readability) is Arthur's BPA input parameter and takes exactly one value:
`'X'` or `' '` — never an array, and never one entry per entity the way the first
version sent it. `workflowContext` (`srv/change-request-service.js`) answers one
question: does this request fill in **any** entity a field property profile marks
critical? It reads `resolvedProperties(requesterContext(req)).criticalEntities`
and checks each with `sectionRows(payload, section)` — 'X' the moment one has a
row, ' ' otherwise, including when nothing is marked critical at all or the
profile table cannot be read. There is no per-entity detail in the payload; SBPA
is told *that* something critical was filled in, never *which* — the screen's "⚠"
is where a human sees which.

**`datastewards` is a flat array of e-mails, resolved the same way `approvers`
is — fresh at submit time, never through the `WorkflowRules` table.**
`srv/wf/data-stewards.js` resolves every BTP subaccount user holding this app's
own `DataSteward` role template (`xs-security.json`), because unlike
`btp-agents.js`'s `MDMLIGHT`-prefixed collections for the approver picker, a
`DataSteward`-carrying collection can be named anything, so membership has to be
resolved by role template rather than read off a naming convention. It shares
`btp-agents.js`'s HTTP client (`callApi`, now exported) rather than fetching its
own token, and follows the same best-effort discipline: never throws, resolves to
`[]` on any failure, cached 5 minutes. Sent as `string[]`, like `approvers` — the
same lesson applies: the deployed process validates the shape it declared, and an
array of objects is not what an array-of-strings input accepts.

**Shipped empty, diagnosed and fixed the same day against the live subaccount.**
The first version made two wrong assumptions, neither of which threw — both just
quietly resolved to nothing, so the symptom was `datastewards: []` on every
submit with no warning in the logs to point at why:

- **The role-collection detail call read the wrong key.** `GET
  /sap/rest/authorization/v2/rolecollections` already returns each collection's
  roles inline as `roleReferences` — there is no separate detail call needed at
  all. The first version made one anyway (`GET .../rolecollections/{name}`) and
  read its result as `detail.roles`, a key that does not exist on the response,
  so `carriesTemplate` was always false and no collection ever matched.
- **The per-user role-collection endpoint doesn't answer what it sounds like it
  should.** `GET /sap/rest/authorization/v2/users/{name}/rolecollections`
  answered `{ roleCollections: [], roleCollectionsBySamlAssignment: [] }` for a
  user confirmed (via `/Users`) to be a member of two collections — wrong for
  this purpose, live-tested rather than assumed. `GET /Users` already returns
  each user's own membership inline as `groups`
  (`[{ value, display, type: 'DIRECT' }]`, both `value` and `display` the
  collection name), which costs nothing extra since `/Users` is fetched anyway.

Diagnosed by running a small script as a one-off `cf run-task` against the
already-bound `mdm-businesspartner-authmgmt` credentials (same approach as
`tools/wipe-staging.js`'s env-var-passthrough trick) to print the real API
responses — the fix in both bullets above was copied from that live output, not
reasoned about from documentation. `test/data-stewards.test.js` pins both real
response shapes so a future refactor cannot reintroduce either wrong key.

#### Critical is Requester-scoped, and reflected read-only everywhere else (2026-08-27)

Asked for once profiles started being split by BTP role for approvers (see
"Field property profiles" and its "Applying them" section below): a request
carries **one** set of critical entities for its whole lifetime, decided once
by whoever files it, not one per role that happens to review it later. So
`critical` is now only ever **read** off a profile matching role `Requester`
(or `*`, which covers `Requester` along with everything else) — an Approver or
DataSteward profile's own `critical` column, if one is somehow stored, is
simply never consulted by the running app.

- **`resolveProfiles` (`srv/checks/field-properties.js`) computes critical from
  a SEPARATE matching set than the four property states.** `criticalMatching`/
  `criticalIds` re-run `profileMatches` against `{ requestType: context.requestType,
  role: 'Requester' }`, independent of whatever role the caller actually asked
  about — `entities`/`fields` (the mandatory/readOnly/hidden/optional states)
  keep using the caller's own `matching`/`ids` exactly as before. The two
  aggregations were kept apart on purpose rather than overloaded onto one set:
  they answer different questions ("what does this role see" vs. "what did the
  requester mark critical"), and entangling them would make either one
  impossible to reason about alone.
- **The Modify dialog only lets the box be ticked from a Requester-scoped
  profile.** `_openPropertyDialog` (`app/mdmrules/.../FieldPropertyProfileList.controller.js`)
  computes `canEditCritical = !role || role === "*" || role === "Requester"` —
  a profile with no role yet (a just-added row) counts as editable too, the
  same way it defaults to matching everything until something narrower is
  chosen — and stores it on the `fp` model as `/canEditCritical`. The checkbox's
  `enabled` binding in `FieldPropertyDialog.fragment.xml` gained `&& ${fp>/canEditCritical}`
  alongside its existing entity-row-only condition, and `onCriticalSelect`
  guards the same flag again in code, the same discipline the entity-only
  restriction already used rather than trusting the binding alone.
- **Every other role's dialog still SHOWS the box, ticked or not, just
  disabled** — a steward reviewing an Approver profile should still be able to
  see which entities the requester already marked critical, the same reasoning
  "hidden is honoured on the approve view" argues the other way for visibility
  of data. `fieldPropertiesOf` (`srv/duplicate-config-service.js`) now returns
  `{ settings, requesterCritical }` instead of a bare settings array —
  `requesterCritical.entities` is `resolvedProperties({ requestType, role:
  'Requester' }).criticalEntities`, the exact same runtime resolution the
  maintenance screen itself reads "⚠" from, reused rather than re-derived, so
  the config screen and the running app can never disagree about what critical
  means for a given request type. (Only `entities` is carried over — critical
  is entity-level only, so the field-level half of that resolved shape has
  nothing to contribute here.) `_buildTree` reads an entity row's displayed
  `critical` from `requesterCriticalEntities.includes(entity.section)` instead
  of this profile's own (normally empty, since editing it here is blocked)
  stored value whenever `canEditCritical` is false.
- **The reflection is read-only in the truest sense: Apply cannot write it
  back.** Without a guard, pressing Apply on an Approver profile — having
  touched nothing — would silently copy the Requester profile's own critical
  flag into the Approver profile's storage, which is exactly the kind of
  profile-owns-what-it-shouldn't bug this whole feature exists to prevent
  elsewhere. `_settingsFromTree` reads `canEditCritical` off the same `fp`
  model property and computes `entityCritical = canEditCritical &&
  entity.critical` / `fieldCritical = canEditCritical && field.critical`,
  using these — never the raw `entity.critical`/`field.critical` — for both
  whether a row is worth sending at all and what `critical` value it carries.


### Workflow Agent Determination — who approves what (2026-08-21)

`db/workflow-rules.cds` adds `WorkflowRules`, the fifth table on the MDM Configuration Panel
tile and the first one that is **not a check on the data**: it produces the
`approvers` list in the workflow context, and SBPA routes on it.

Read a row left to right as one sentence — *a **create** request whose
`Addresses.Country` is **BE, NL, FR or DE** is **approved** by **these three
people***. The columns are CR type, step, two condition pairs, and the approvers.

- **The table decides WHO, never how many approvals or in what order.** That
  stays on SBPA's side, the same way `decideRequest` records an outcome without
  knowing the chain. CAP does not check that a role exists either — roles live in
  SBPA, and a copy kept here would go stale.
- **An entry carrying an `@` goes out as a user, anything else as a role.**
  `resolveApprovers` returns `{ step, kind, value }` per approver, but **what crosses
  to SBPA is a flat array of the values** — see "What actually goes over the wire"
  below. `kind` stays derivable on either side from the `@`. The two halves are **entered** differently on purpose
  (2026-08-21): an address is free text nobody could offer a list for, while a role
  has to be spelled exactly as SBPA knows it, so the cell takes typing *and* offers
  a value help over the roles and the subaccount's users — see "The approver picker
  is sourced from the subaccount" below for where that list comes from since
  2026-08-26. The condition cells
  deliberately do not get it: a country is not a role. **There is no order column** — rows are additive, so
  every matching row contributes its approvers and nothing needs ranking. Asked for
  and removed on 2026-08-21, before anything was deployed: it was copied in from the
  other rule tables rather than wanted, and dropping a column after a deploy is what
  `cds-deploy` refuses to do.
- **Empty is a legitimate answer.** No rule matched, the table is empty, or it
  could not be read — all three resolve to `[]`, which is what every submit sent
  before this table existed, so SBPA reads it as "route it the way you always
  did". The store's failure mode is `field-property-store.js`'s, not
  `rule-store.js`'s, deliberately: a submit that failed because the approver table
  was unreadable would stop every request in the installation over a routing hint.
- **Resolved in `workflowContext()`**, so it happens after the validations and the
  duplicate gate, and is rebuilt after a rework — a resubmitted request is routed
  on the payload the requester fixed, not the one that was rejected. Best-effort,
  like `businesspartnerinput`.
- **All four CR types, and no `*`.** Unlike the field property profiles' closed
  list this table offers `block` and `delete`, because it is where a steward says
  who approves one and saying it early is harmless — `SUPPORTED_REQUEST_TYPES`
  still gates what can be submitted. There is no "any type" row on purpose: an
  approver list is not something to default.
- **`step` carries only `Approve`.** It is a column rather than an assumption
  because the next version of this table is meant to describe whole request types
  (Supplier creation, Customer creation) with several steps each, and a step added
  later must not be a column added later.

#### One value per column (the legacy two-pair shape)

Both condition values and the approver held a single value in the original design, like every
other rule table — see "Multiple values per condition" above for the version that was built and
withdrawn, and what the next attempt would need. The columns keep their plural names because
`cds-deploy` cannot rename an element. **Superseded for conditions by the `WorkflowRuleConditions`
composition below (2026-08-28)** — a rule is no longer stuck at exactly two — but every bullet here
still describes the legacy `conditionField`/`conditionValues`(+2) pair, which a rule saved before
that date still reads through, and still describes `approvers` exactly as it works today.

- **A condition here is always a statement about the partner.** A row of this table targets no
  section of its own, so any row of the named section satisfying the condition is enough — unlike
  the validation and derivation tables, where a condition on the rule's *own* section is evaluated
  per row.
- **Several approvers means several rows.** `resolveApprovers` merges every matching row and
  de-duplicates on step + value, so two rows naming the same person produce one approver.
- **The read path still tolerates a delimited list**, for rows written while multiple values were
  live.

#### As many conditions as a rule needs, side by side (2026-08-28)

Asked for directly: "Nu is dit beperkt tot 2 maar dit kunnen meer factoren zijn" — the two fixed
condition pairs above could never become three without a schema change `cds-deploy` cannot walk
back if it turns out to be one column too many, the same trap `createsRow` and the `cond*` columns
are already stuck in. `WorkflowRuleConditions` (`db/workflow-rules.cds`) replaces them: a real
composition, one row per condition, `Association to WorkflowRules` plus `field`/`operator`/`values`.
"Add Condition" grows one rule's own composition — genuinely per row (rule A can have two conditions
and rule B five, each its own count), not a fixed number of always-visible slots.

**A free-text, line-per-condition column (`field = value1|value2` in a `TextArea`) was tried first
the same day and reverted the same day, on direct feedback: "ik wil dit naast elkaar zoals het
ervoor was... niet hoe het nu is".** The ask was never "fewer columns", it was "as many of the
original side-by-side Field/Value groups as a rule needs" — stacking them as lines of text solved
the *dynamic* half and broke the *side by side* half. `WorkflowRuleConditions` is what a real
composition looks like once "the binding is the only writer" (the lesson "Multiple values per
condition" above left behind, for a *different* problem — several values in ONE field, not several
conditions) is honoured for *this* problem too: no hand-parsed DSL, no line-splitting, one row, one
set of plain two-way-bound cells, rendered inline.

- **The view: a wrapping `FlexBox` templated over `dc>conditions`.** Each condition renders as its
  own small `HBox` — Field `Input` (the same `FieldValueHelp` fragment every condition cell on this
  tile has always used, unchanged), an operator `Select`, a Value `Input`, and a remove button — and
  `wrap="Wrap"` lets a rule with many conditions spill onto a second line inside the cell rather than
  growing the row forever sideways. An "Add Condition" button below the `FlexBox` creates a new child
  row against *that rule's own* `conditions` navigation via `_conditionsBinding` (a fresh
  `bindList("conditions", ruleContext, ..., { $$updateGroupId: 'ruleChanges' })`) — the same
  mechanism Duplicate and the Excel import share for adding a condition row under a given rule
  context, so nothing here depends on the OData v4 model supporting a deep-insert payload in one
  call. Remove reads the *condition's own* binding context (it lives inside the per-condition
  template) and deletes just that row.
- **Operators reuse `rule-engine.js`'s `COMPARISONS`** (`eq`/`ne`/`lt`/`le`/`gt`/`ge`/`contains`/
  `empty`/`notEmpty`) — asked for directly ("volgens mij alle mogelijke operatoren") rather than a
  smaller, WorkflowRules-only set, and served through `workflowRuleOptions()` the identical way
  `qualityRuleOptions()` already serves them to ValidationRules/DerivationRules. `conditionHolds`
  keeps the *shape* every condition here has always had — "some row of the named section, some
  listed value" — for every operator, not just `eq`: `Country != BE` holds when *some* address
  disagrees with BE, not when *every* address does, the exact same "any row is enough" reading the
  positive case has always had. `eq` alone keeps the wildcard/`|`-multi-value matching
  (`listMatches`) every other condition column in this app already has — a `*` pattern only ever
  meant "equal to, loosely". `empty`/`notEmpty` read the **raw** field value via `sectionRows`
  directly, never `fieldValues` (which filters empties out before either check would ever see one —
  found while writing the test for it, not assumed).
- **`joinConditions` (`srv/checks/value-lists.js`) was generalised to fold over N results, not just
  two** — `results.every(Boolean)` for AND, `.some(Boolean)` for OR, `!.some(Boolean)` for NOR. This
  is shared by all four rule tables' engines, but the fold is defined so it produces the *exact same
  answer* for 0/1/2 results as the old pairwise version did — a single condition still bypasses the
  logic entirely rather than letting NOR invert it, which is the one behaviour that had to survive
  unchanged. `ValidationRules`/`DerivationRules`/`DuplicateRules` still only ever pass 0/1/2 results
  themselves (their own `CONDITION_PAIRS` are untouched — this change was scoped to WorkflowRules
  only), so nothing about them changed; the shared fold could serve all four the day their own
  columns are generalised the same way.
- **`readConditions` prefers the composition and falls back to the legacy pair only while it has no
  rows.** A rule saved before 2026-08-28 keeps matching exactly as it always did, with no migration —
  the moment it gets its first real condition row, the legacy columns simply go stale (never written
  again, the same tolerance as every other dead column in these four tables).
- **Each condition validates on its OWN write, as its own entity**, not as a slice of the rule that
  owns it: `WorkflowRuleConditions` gets the same `guard()` treatment `WorkflowRules` itself does,
  with its own validator (`validateCondition`) rather than looping a fixed `CONDITION_PAIRS.entries()`
  — which is what made "as many conditions as it needs" simplify validation rather than complicate
  it: one row, one set of checks, no position-based "condition 1"/"condition 2" naming needed
  server-side any more (the client's own courtesy check in `_localProblems` still numbers them for
  the error message a steward reads).
- **No `sequence` column, deliberately, on `WorkflowRuleConditions` either** — AND/OR/NOR fold over
  these rows without caring what order they were added in, so there is nothing for a sequence to
  mean, the same reasoning `WorkflowRules` itself already gives for having no order column of its
  own ("rows are additive... nothing needs ranking").

#### Copy a rule, and bulk-edit the table in Excel (2026-08-28, asked for)

Two more asks landed the same day, both scoped to this one page:

- **Duplicate.** A "Duplicate" button beside Delete reads the selected row
  (`context.getObject()`), strips its identity and managed columns (`STRIP_ON_COPY`: `ID`,
  `@odata.etag`, `createdAt`/`createdBy`/`modifiedAt`/`modifiedBy` — sending any of those back on a
  `POST` is either ignored or rejected depending on the column, never something worth relying on),
  and feeds the copy into the same `binding.create()` call `onAddRule` already uses. **Its conditions
  are copied too** — each one individually created as its own new `WorkflowRuleConditions` row
  against the *fresh* rule's context via `_conditionsBinding`, exactly the way Add Condition creates
  one, rather than sending the whole nested array back as part of one deep-insert payload (which
  would depend on model support this app has never needed to trust). Nothing is saved automatically —
  same as Add Rule, it only populates the (now dirty) table.
- **Export to Excel / Import from Excel — really a CSV round trip, said so in the UI.** This repo has
  never taken a dependency on a spreadsheet reader/writer anywhere, front or back end, and real
  `.xlsx` is a zipped XML format nothing here can hand-parse. CSV needs none of that: Excel opens and
  saves it natively, and the button labels name the destination a steward actually cares about
  (“Excel”) while the file on disk is honestly `.csv`. `toCsv`/`fromCsv` are a small, hand-rolled
  RFC-4180-shaped codec (quoted fields, doubled embedded quotes, a real state machine for `fromCsv`
  rather than a naive split on `\n`). A UTF-8 BOM is prepended on export so Excel on Windows does not
  guess the system codepage and mangle a name outside ASCII.
  - **The columns mirror the page itself, not a packed DSL cell** — asked for directly ("ik wil
    eigenlijk de structuur hebben die ook zichtbaar is dan in de app"): `ID`, CR Type, Step, then
    `Condition 1 Field`/`Operator`/`Value` through `Condition 6` (`MAX_EXCEL_CONDITIONS`), then
    Logic, Approvers, Active. `ID` is the match key on re-import (blank or unrecognised creates a new
    rule, one matching a currently-loaded row updates its flat fields), so a steward can export,
    tweak simple fields, append whole new rows with their own conditions, and re-import the file.
  - **The condition-slot cap is a spreadsheet limitation, not a page one.** A rule can have more than
    six conditions on the page itself; export only warns and truncates (naming how many rules were
    affected) rather than failing or silently dropping data past the sixth unannounced.
  - **An existing rule keeps whatever conditions it already has on import — the file's condition
    columns are read only for a NEW row.** Replacing an existing rule's conditions on re-import would
    mean deleting contexts this code path never touched (they live in the page's own nested list
    bindings, not something `_applyImportedCsv` holds a handle to), and a silent partial replace is
    worse than a clearly communicated no-op: the toast counts how many existing rows had condition
    columns filled in anyway, so nothing is dropped unnoticed — edit an existing rule's conditions on
    the page itself.
  - **Import never saves by itself.** It only creates/updates rows on the page, exactly like Add
    Rule and Duplicate — the existing Save/Discard flow, and `_localProblems`'s validation, still
    have the last word before anything reaches the service.
  - **`isActive` is read tolerantly** (`true`/`1`/`yes`/`x`, case-insensitive) rather than matching
    only the literal word, because a business user filling this in quickly in Excel writes any of
    those as often as the exact string.

#### The approver picker is sourced from the subaccount, not from this app (2026-08-26)

Until now the value help on the approver cell offered this app's own three-entry
`ROLES` list (`Requester`/`Approver`/`DataSteward`, from `srv/checks/field-properties.js`)
— a concept that has nothing to do with who can actually be assigned an approval:
those three names are what the Field Property Profiles page conditions on, and
`Requester`/`Approver` are not spellings SBPA would recognise as a role collection or
a person. `srv/wf/btp-agents.js` replaces it with the subaccount's own **role
collections** and **users**, read live from the BTP Authorization Management API.

- **Role collections, not this app's own role concept — and only the ones meant for
  this picker.** A subaccount has a role collection for every application in it, so
  the list is filtered to those whose **Description** starts with `MDMLIGHT`
  (`ROLE_COLLECTION_PREFIX`) — Description, never Name: the prefix is a convention
  applied to the text an admin writes, not to the collection's own (often short,
  unrelated) name. `ROLES`/`ROLE_TEXT` in `field-properties.js` are **untouched** and
  still serve the Field Property Profiles page — a different picker, a different
  question ("which role is this profile for", not "who approves this").
- **Users too**, named by e-mail — the same address this app's own notifications and
  SBPA already use — falling back to the username for one with none.
- **A second, separate XSUAA instance.** The app's own `mdm-businesspartner-auth`
  (plan `application`) authenticates users into this app and has no access to the
  Authorization Management REST API; a dedicated `apiaccess`-plan instance
  (`mdm-businesspartner-authmgmt`, added to `mta.yaml`) is what SAP's own docs call
  for. Its service key carries `clientid`/`clientsecret`/`url` (for a
  `client_credentials` token, same shape as `mdmlight-bpa-uaa`) plus `apiurl` — the
  Authorization Management API host, a fixed region-wide address and not this
  tenant's own login URL. `btp-agents.js` refuses to guess one when `apiurl` is
  missing, the same discipline `ui-prefix.js` applies to a missing destination guid.
  It is a **managed** service, so its credentials land under VCAP's `xsuaa` group
  (told apart by name) rather than under `user-provided` like the BPA credentials.
- **A broad, subaccount-wide read credential**, deliberately scoped to nowhere else:
  it can list every role collection's name and description and every user's e-mail
  in the subaccount. `btp-agents.js` is the only module that ever sees it.
- **Best-effort, like every other BTP-platform read in this codebase**
  (`workflow-rule-store.js`, `processAutomation.js`): an unreachable subaccount API,
  or the service simply not bound yet, leaves the picker offering nothing rather than
  failing the page — the cell still takes a typed e-mail address or role name either
  way. The two lookups fail independently, so role collections still populate the
  picker even if the `/Users` call is the one that is down.
- **Cached 5 minutes** (`TTL_MS`), longer than the 60s the rule/profile tables use:
  role collections and subaccount users do not change on a per-minute cadence, and
  there is no reason to call BTP's management API on every dialog open.
- **The F4 dialog is a real two-column table, not `sap.m.SelectDialog`.**
  `RoleValueHelp.fragment.xml` was a `SelectDialog` (title/description/info on a
  `StandardListItem`) — that control wraps a plain `sap.m.List` with no column
  headers, and *Type* vs. *Name / E-mail* is exactly the distinction a combined
  role-and-user picker has to make visible, so it is now a plain `sap.m.Dialog` +
  `sap.m.Table` with two named columns, the same shape `FieldPropertyDialog.fragment.xml`
  already uses elsewhere on this tile. Selecting a row (`onRolesChosen`) reads the
  entry off its binding context — `{ type, value }` — before anything touches the
  list, the same ordering the field value help follows and for the same reason: a
  reset re-templates the rows and re-binds whatever now sits at the old position.
- **`Agent { type, value }`** is the new CDS type on `WorkflowRuleOptions.agents`,
  replacing the old `roles : array of Option`. Nothing else read that field.

##### What actually goes over the wire (fixed 2026-08-21)

`workflowContext` sends `approvers` as a **flat array of strings**, not the structured
list the engine produces. Julien found this the hard way: the deployed process declares
`approvers` as an array of strings and the runtime validates against it, so sending
objects failed **every submit** with

```
[340,5] /approvers/0 The value must be of string type, but actual type is object.
```

That is a create refused over a routing hint, which is the exact failure mode the
best-effort resolution was supposed to prevent — the guard covered a table that could
not be *read*, not a payload SBPA would not *accept*.

- **Flattened at the boundary only.** `resolveApprovers` still returns
  `{ step, kind, value }`; the `.map` sits in `workflowContext` and nowhere else.
- **What is genuinely lost is `step`.** Two steps arrive as one list. Restoring it is a
  process-side schema change to an array of objects, after which the map comes off. Do
  not "restore" it on this side alone — that is the change that broke every submit.
- **`kind` is not lost**, only implicit: an entry carrying an `@` is a user, on either
  side of the wire.

##### A role entry is resolved to real e-mails before it crosses the wire (fixed 2026-08-27)

Flattening to strings was not the last surprise this boundary had. Once the approver
picker started offering BTP role collections (see "The approver picker is sourced from
the subaccount"), an approver cell could hold something like `Approver Customer` - and
`workflowContext` sent that name through unresolved, on the assumption stated everywhere
else in this table's design: *"roles live in SBPA, and a copy kept here would go stale."*
That assumption was wrong for Arthur's process - it does not resolve BTP role collection
membership itself, so a role name reaching it as-is names nobody it can assign a task
to, and the request routes to an approver list of one string nobody can act on.

- **`workflowContext` now expands a `role` entry into its member e-mails itself**, via
  `emailsForRoleCollections` (`srv/wf/btp-agents.js`) - the exact lookup
  `dataStewardEmails` already used for its own fixed `DataSteward` role template,
  generalised to take any list of role collection names. A `user` entry (already an
  e-mail) is kept as-is; the two are merged and de-duplicated into `approverEmails`,
  which is what `approvers` on the wire actually is now.
- **The split happens in `workflowContext`, not in `resolveApprovers`.** The engine
  still returns `{ step, kind, value }` and stays offline and deterministic - resolving
  BTP membership is a network call, and mixing it into the same function that decides
  WHICH rows match would make an unreachable subaccount block a submit over routing,
  the one failure mode this whole table exists to avoid. `workflowContext` is where the
  structured list already gets flattened for the wire, so it is also where the one
  network-dependent step belongs.
- **Best-effort, the same as everywhere else in this codebase's BTP reads**:
  `emailsForRoleCollections` never throws, and a role that cannot be resolved (the
  subaccount API down, or nobody carries it) contributes nobody rather than costing the
  submit - the same trade `dataStewardEmails`/`workflowAgents` already make.
- **`fetchStewardEmails` in `data-stewards.js` is now a thin wrapper** around this
  shared function, kept only so that module's own `load()` and its tests read
  unchanged - the membership lookup itself (match a role collection name against a
  user's own `/Users` `groups`) is one piece of code, not two copies that could drift.
- **What still does not resolve: `processorsFor`'s own approver list**, the one behind
  the "who has it now" strip. That reads the same `WorkflowRules` table but is a
  rendering answer, not a wire payload SBPA has to act on, so a role name shown there
  unresolved is not the same failure - left as it is unless asked for.

**Save cannot claim what it did not do (2026-08-21).** A rule appeared to clear itself
after being created. `hasPendingChanges` answers for **one update group**, so a create
that never travelled leaves it false and the toast reports a save that did not happen —
from the outside, a rule vanishing. `_transientRows()` now asks the rows directly: a
context still transient after a submit was never written, and the page says so instead.
That guard is worth keeping, but it was **not** the cause: Maarten's next report pinned
it exactly — the row persisted and only the two list columns came back empty, which is
the `context.setProperty` write path above, not a submit that never happened.

**The guard itself had a race, and it is what made Add Rule need two presses of Save
(fixed 2026-08-31).** Reported live: adding a rule and pressing Save once always answered
"1 rule(s) were not saved... Reload before trying again" - and pressing Save again, with
nothing left transient by then, always succeeded. `submitBatch(UPDATE_GROUP)`'s own
promise can resolve before a freshly created context has actually flipped out of
`isTransient()` - a real ordering gap in the OData v4 model, not something a retry
happens to paper over by chance. `context.created()` is the promise that genuinely
completes a create, and it never settles LATER than `submitBatch`'s own promise, only
sometimes slightly after - so `onSave` now captures `_transientRows()` **before** the
submit and, once `hasPendingChanges` has ruled out a genuine rejection, awaits
`context.created()` (each wrapped in its own `.catch(() => {})`, since a rejected create
is already reported by that same `hasPendingChanges` check) for every row it caught, before
asking `_transientRows()` a second time to decide whether to show the warning. **Applied
to all four rule pages** (`WorkflowRuleList`/`ValidationRuleList`/`DerivationRuleList`/
`DuplicateRuleList`), since all four copy this exact save idiom and the race lives in the
model, not in any one page's code - `ValidationRuleList`/`DerivationRuleList`/
`DuplicateRuleList` never had the `_transientRows`/"not saved" guard to begin with, so
without this they could have lost a row exactly this way with nothing on screen ever
saying so.

**Still open, and agreed as the next step:** wiring SBPA to actually consume
`approvers`. Arthur's definition ignores the field today, so the list is sent and
nothing reads it — the table is inert until his process assigns its approver task
from it. And once that lands, offering multi-value conditions on the **other**
rule tables is the follow-up Maarten asked for; the encoding is already shared for
it, but each page needs its cell replaced and each engine needs `listMatches`
where it compares one value today.

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
  `Customers`/`Suppliers` are `deletable: false` here **on purpose and
  permanently** — `deleteBusinessPartnerEntity` rejects with 405 rather than
  issue a plain OData `DELETE` against `A_Customer`/`A_Supplier`, which S/4 does
  not support: a customer is retired via its own `DeletionIndicator` field, not
  a delete verb. Do not flip this flag to fix a delete-button complaint — see
  the staged maintenance screen's own `deletable` (`generate-maintenance-metadata.js`)
  for the correct place that actually changed, below.
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

- `decideRequest` records an outcome **and, on approve, creates the business
  partner** (changed 2026-08-25). It writes `approved` first, then posts: on
  success the request is `posted` with the number; on failure it goes to
  `reworkRequired` with the reason in `postError` and in the action's new
  `ErrorMessage`. `reject` sends it to `reworkRequired` and back to the requester
  — see "Rework" below. It is **not** terminal any more.
- `completeRequest` is the same step, for SPA's callback. Its `postedBP` guard
  makes it a no-op once approve has run; it still matters for a request approved
  before this change, or one whose approve handler died between the status write
  and the post. **Both entry points call one `postAndRecord`** so they cannot
  drift on what they write or signal.

This closes the TODO that used to sit further down: Arthur's process calls only
`decideRequest` and expects the partner to exist afterwards, and until now it did
not. `approved` is therefore a passing state, not a resting one. **`posted` is the
only terminal status**; a withdrawn request is deleted rather than parked in one.
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

- **The entry point was the deep link and nothing else — until a second one was
  added deliberately (2026-08-21): a My Inbox task, assigned to the requester,
  whose input carries `tasktype: "rework"`.** `reworkurl` still goes to SPA with
  the *initial* workflow context (alongside `bpurl`), because SPA owns the
  rejection branch and has it to hand there, and a task with no `tasktype` (every
  task built before this existed) still opens the approver's decision screen — so
  nothing already working needed its input mapping touched. The change request
  list stays steward-gated either way, so neither path is a substitute for the
  other existing; a workflow can use one, both, or keep only `reworkurl`. The
  screen still has to cope with a link opened twice, for whichever entry point
  reopens it. **My Inbox does not render an embedded app's `sap.m.Page` footer at
  all** (found 2026-08-24, `Component.js` had asserted the opposite in a comment
  for three days): every button in it was invisible on a task - Check, Duplicate
  Check and Back on the approve task, Resubmit and Withdraw on a rework task. Only
  Approve/Reject worked, because those come from `inboxAPI.addAction` rather than
  from anything the footer draws. Two different fixes for two different kinds of
  button, same day:
  - **Check/Duplicate Check moved into the object page header actions, and stayed
    there regardless of `env>/embedded`** (Maarten, later the same day): on a long
    create form the footer is a scroll away from the fields being filled in, and
    those two get pressed while typing. So unlike everything else on this list
    they are deliberately in the header standalone too, and the footer's own
    copies are gone rather than merely hidden there. Neither is a declared outcome
    either way - there is nothing to put in `sap.bpa.task.outcomes` for "run a
    check" - so the header was always the only way to reach them embedded.
  - **Resubmit/Withdraw went through the header too, briefly, then back out**:
    both ARE declared outcomes, so `_addReworkInboxActions` in `Component.js`
    wires them to `inboxAPI.addAction` instead - the same native action-bar
    location Approve/Reject already render in, rather than a second,
    differently-styled button. Pressing one does not complete the task directly
    the way Approve/Reject do: it only publishes onto the `"taskform"` event-bus
    channel Julien's inbox-loading fix uses, and the shared controller (subscribed
    in `onInit`) answers by running the exact `onSave`/`onWithdraw` flow the
    footer button would have run — Check, the duplicate-check confirmation dialog
    if one is needed, then the actual resubmit/withdraw. The task completes itself
    only *after* that flow actually succeeds, via `_completeEmbeddedOutcome` in
    the shared controller calling `completeOutcome` on the task app's Component —
    the same `PATCH task-instances` the approve path sends, without a
    `decideRequest` in front of it since `resubmitRequest`/`withdrawRequest`
    already recorded the outcome server-side. The footer's own Resubmit/Withdraw
    hide on `env>/embedded`, same as Approve/Reject always did — unlike
    Check/Duplicate Check, there is nowhere they need to stay doubled up: one
    place to press, and this time an inbox-chrome place that is reliably
    rendered.
- **Resubmit resumes, it does not restart.** The process instance stays parked
  through the rejection, and `resubmitRequest` signals it with
  `RESUBMITTED_SIGNAL` (`'resubmitted'`). One instance per change request means one
  audit thread on Arthur's side however many rework rounds happen. A request with
  no `processInstanceId` is refused rather than quietly given a fresh workflow,
  which would hand it two audit threads and possibly two approver tasks.
- **Resubmit runs every gate a first submit runs** — validations and the duplicate
  check with its confirming second press. The requester may have changed the very
  fields the duplicate check reads. Derivations still do not run on a submit path.
- **A failed signal no longer blocks the resubmit (reversed 2026-08-24).** It used
  to leave the request stuck at `reworkRequired`, on the same reasoning as a failed
  start leaving a submit in `draft` — but live testing showed the signal failing
  with `bpm.workflowruntime.rest.message.no.match` even for a genuinely reworked,
  valid request, because the parked instance was not (or not yet) actually waiting
  on `requesterCallBack`. That is a BPA-side gap (see "Not built on Arthur's side
  yet" below), not a reason to strand a correct rework. The signal is now
  best-effort, like `withdrawRequest`'s own callback always was: logged on failure,
  never blocking. **What resumes the process is the rework task itself completing**
  — the `PATCH task-instances` `_completeEmbeddedOutcome` sends once this action
  returns — the same way completing the approver's decision task resumes the main
  approval, no separate signal needed. `resubmitRequest` now returns `ContextJson`
  (the rebuilt `businesspartnerinput` included) so that PATCH can carry the
  reworked data as the task's own output, declared in `app/bptask`'s
  `sap.bpa.task.outputs`, rather than only through the signal above.
- **The approver's comment goes to `rejectionComment`, never over `reason`.**
  Overwriting was harmless while a rejection was terminal; now the requester
  reopens this record and would find their own justification replaced by the
  verdict on it — and then resubmit the approver's words as their reason. The
  comment leads the screen as a Warning strip, because "rejected" with no why is
  not something anyone can act on. **The strip stopped repeating the comment's
  own text on 2026-08-25** — it points at the conversation panel below instead
  ("See the conversation below for the reason"), now that the panel is the one
  place a comment's actual words are shown; showing it twice risked the two
  going out of sync if a later change touched one wording and not the other.
  `state.rejectionComment` still exists and is still read — only truthiness,
  never the text itself, so the strip still tells "a reason was given" apart
  from "none was recorded" (`claimRework`'s stopgap case, below).
- **Where that comment comes from (2026-08-21): a `TextArea` at the bottom of
  the approve screen's content**, bound to `context>/comment` — the same
  property `_decideOnServer` in `app/bptask`'s Component.js already reads for
  `decideRequest`'s `Comment`, so nothing on the server side changed. `context`
  is a model only `app/bptask`'s Component sets, so this only appears embedded;
  a standalone approve (dev testing only) has no comment path either way, same
  as before. Visible only in approve mode — a rework/edit screen has nothing to
  decide yet, and there is no equivalent field for it.
  **Moved to the top of the content, beside the message panel, the same day**:
  at the bottom it rendered but was cut off below the visible area — My Inbox
  does not reliably give an embedded app's own lower content room either, the
  same lesson the footer buttons already taught. The binding is unchanged, only
  its position in the view.
  **Moved again, 2026-08-27, to right after the conversation panel** (still
  well above the actual Object Page form, so the earlier cut-off risk does not
  apply — that was about the literal bottom of the whole page, not about being
  sixth among the header-area panels instead of second): typing a reply
  immediately under the thread it answers reads as what it is, where a box
  positioned near the top with no visible connection to any conversation did
  not. `reworkCommentBox`/`dataStewardCommentBox` moved with it, for the same
  reason and because all three boxes have always lived together in the markup.
- **The full conversation, not just the latest word (2026-08-24).** `reason` and
  `rejectionComment` on the header are unchanged — both still work exactly as
  before, and every existing reader of them still reads them — but they only ever
  held one side's latest message, which reads as amnesia the second round a
  request comes back. `ChangeRequestComments` is a new, append-only child entity
  (one row per message, `role` + `author` + `text`), and `decideRequest` /
  `resubmitRequest` both write to it *in addition to* the legacy fields.
  `getRequestPayload` returns it as `CommentsJson`; the screen renders it as a
  collapsible `Panel` (`commentsPanel`, oldest first, `StandardListItem` per
  message naming who said it) — **last of the panels above the form** since
  2026-08-27, see "Highlighting what changed" — on **every** mode
  that has a thread to show — approve, rework, view, draft.
- **Rework gets its own comment box, separate from the approver's.**
  `approverCommentBox` is embedded-only (`context>/comment`, a model only
  `app/bptask`'s Component sets) because approve is only ever reached that way in
  practice. Rework is not — the `reworkurl` deep link opens it standalone too
  (see below) — so `reworkCommentBox` binds to `maintenance>/reworkComment`
  instead, works in both, and is sent as `resubmitRequest`'s existing `Reason`
  parameter (declared since the action was written, never previously populated
  from the UI). Optional: a resubmit needs no explanation, only the edit itself.
  Echoed into the panel locally right after a successful resubmit, since the
  request becomes read-only from there and nothing reloads it again to pick the
  server's own copy up.
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
- ~~**Arthur's workflow still calls only `decideRequest`**~~ — closed 2026-08-25:
  approve posts, so a request no longer sits at `approved` waiting for a
  `completeRequest` nobody sends.

##### Signalling the outcome, and three traps found on the way (2026-08-25)

The instance is told the *result* of the post through its own trigger,
`waitForResult`, whose inputs are exactly `businesspartnerid`,
`businesspartnerfullname`, `status` (`success`/`error`) and `errormessage`.
`executionId` is `ChangeRequests.processInstanceId`, the same correlation the
decision triggers use. It has no `result` key, so it cannot go through
`sendTrigger`; `triggerPostResult` posts it through the same destination.

`SignalWorkflow: false` — the task form saying "completing the task already
delivers the decision" — deliberately does **not** silence this. The decision and
the result are different waits, and the process needs the result whichever way the
decision arrived. Signalling is best-effort and never throws: the partner exists in
S/4 whatever the call does, and losing it over a timed-out signal is the worse of
the two failures.

Three things that were broken or unsafe, found while wiring this and fixed with it:

- **`completeRequest` threw a ReferenceError on every completion.** It called
  `notifyWorkflow`, a `const` declared *inside* the `decideRequest` handler — so
  after creating the partner and writing `posted`, the handler died and the caller
  saw a 500. On the failure path too. `test/approve-posts.test.js` now pins that
  `notifyWorkflow` is only called where it is declared.
- **A status write immediately before `req.reject` never persists.** `req.reject`
  throws, CAP rolls the transaction back, and the write goes with it — so the old
  `failed` write was lost and the request stayed `approved`. That is why a failed
  post is **returned** as `ErrorMessage` with `Status: reworkRequired` instead of
  rejecting the action. Both screens read that field; an empty `BusinessPartner`
  used to mean "rejected" and now also means "the post failed".
- **Rework after a partial post could create a second partner.** A create whose
  post half-succeeds leaves a real partner in S/4; the requester reworks,
  resubmits, and the next approve would create another. So `postToS4` now persists
  the number the moment S/4 hands it over — before the child nodes, which can
  still throw — and `isCreate` is `requestType === 'create' && !businessPartner`,
  making the retry an update.

Still open, and Julien's call rather than the code's: a failed post from **My
Inbox** completes the task anyway. The decision stands and the task is done either
way, and the approver is shown the error — but if a failed post should leave the
task open instead, that is a change to `_completeTask` in `app/bptask`.

#### Data steward enrichment (2026-08-26)

A third loop, parallel to rework rather than a step inside it: a data steward can
be handed a request mid-approval to add or correct data, then send it back — to
the approver if they made it work, to the requester if they could not. Built by
copying rework's own shape wherever the two are genuinely the same thing, and
diverging only where the roles differ.

- **`checkAndEnrich` is its own status** (`db/staging.cds`), not a value of
  `reworkRequired` — a data steward's edit and a rejection are different events,
  and collapsing them would make the screen unable to tell "the requester is
  reworking this" from "the steward is". It joined `EDITABLE_STATUSES`,
  `ACTIVE_REQUEST_STATUSES` and `IN_PROGRESS_REQUEST_STATUSES` for exactly the
  reasons `reworkRequired` is in each: a payload someone may still edit, a
  partner still locked, a request still owned by a human. `WITHDRAWABLE_STATUSES`
  aliases `EDITABLE_STATUSES` (test-pinned), so a data steward who cannot make a
  request work may withdraw it the same way a requester withdraws a rework —
  accepted rather than special-cased, though nothing in the UI offers a Withdraw
  button in this mode today.
- **`claimDataStewardReview` is `claimRework`'s own pattern**: arrival on the
  screen (via the `datastewardurl` deep link or a My Inbox task carrying
  `tasktype: "datasteward"`) moves `inApproval` → `checkAndEnrich`, because
  nothing on Arthur's side calls a CAP action to make this transition — the
  process routing a task here is taken as the evidence, same as claimRework's own
  reasoning, and no workflow signal is sent for the same reason claimRework sends
  none.
- **`decideDataStewardReview` is two different existing shapes under one action**,
  picked by `Decision`: `'complete'` is **`resubmitRequest`'s own body** — persist,
  the same validation/duplicate-check gates, `Confirm` included, rebuild the
  workflow context, hand the **same parked instance** back to `inApproval`. A data
  steward enriching data is reworking the payload, just under a different status,
  so nothing about the gates changes. `'reject'` is **`decideRequest`'s reject
  branch** instead: no payload to persist, straight to `reworkRequired` with the
  steward's note on `rejectionComment`, because the steward could not make the
  request work and it goes back to whoever raised it — never back to the
  approver, who never asked the steward anything.
- **Both are placed after `withdrawRequest`, not beside `claimRework`.** Several
  tests slice `serviceJs` from `resubmitRequest` to `withdrawRequest` expecting an
  exact shape (an exact `workflowContext` call count, no workflow signal inside
  `claimRework`'s own slice); inserting the new handlers between `claimRework` and
  `withdrawRequest` would have landed inside those slices and broken assertions
  about behaviour that did not change. Ordering in the file is not the same as
  ordering in the CDS service definition, and does not need to be.
- **Two new signals, `DataStewardComplete` / `DataStewardRejected`, are
  unconfirmed placeholders** — like `WITHDRAWN_SIGNAL` was until confirmed,
  nothing on Arthur's side listens for either yet. `triggerRequesterCallback` is
  reused rather than duplicated: it was already generic, told apart only by
  `result`, and now carries four signals instead of two.
- **The screen is the same shared `BusinessPartnerMaintenance` screen**, in a
  fourth mode (`"datasteward"`, alongside `"approve"`/`"edit"`/`"rework"`/`"view"`),
  reached by `_onDataStewardRoute` and the route `ChangeRequests/{id}/datasteward`
  in both `app/businesspartner` and `app/bptask`. Editable like rework
  (`showSaveButton`/`showSaveRequestButton` both false, unlike rework, because
  there is no generic Save — only the two decision buttons below), and the field
  property profile is read under the `DataSteward` role rather than `Requester` or
  `Approver` — a role that already existed in `srv/checks/field-properties.js`'s
  `ROLES` for exactly this, unused until now.
- **Two buttons, not one primary action like rework's Resubmit.** *Complete
  Review* goes through `_sendChangeRequest("decideDataStewardReview")`, which gets
  it the same Check/duplicate-confirm dialog dance as Resubmit (it edits the
  payload too) and, on success, `_completeEmbeddedOutcome("enrich", ...)`.
  *Reject* is a plain decision — `onRejectDataStewardReview` confirms, then
  `_declineDataStewardReview` calls the action directly with no gates, mirroring
  `onReject`/`_decide`'s shape rather than `_sendChangeRequest`'s. A
  `dataStewardCommentBox`, not embedded-only (same reasoning as
  `reworkCommentBox`: the deep link reaches this screen standalone too), carries
  the steward's note either way.
- **The task app's outcome ids are `"enrich"` and `"reject"` — Reject reuses the
  approve task type's own id rather than a new one (changed 2026-08-26 on
  Julien's ask; the first version used `"decline"`).** `sap.bpa.task.outcomes`
  is one flat array across every task type this app handles, and an id only has
  to be unique **within** it, not per handler: `_addInboxActions` (approve type)
  and `_addDataStewardInboxActions` (data steward type) both register `"reject"`,
  each with its own callback, and that is safe because the two task types never
  coexist on one task instance — `_initTaskForm` picks exactly one branch per
  task, so only one handler for `"reject"` is ever registered at a time. Reusing
  the id also means the Lobby needs no new outcome mapped for the data steward
  step beyond `"enrich"`, which has no existing outcome to reuse. Both go through
  `_addDataStewardInboxActions`, event-bus-publish only like
  `_addReworkInboxActions` (never `_completeTask` directly, unlike the approve
  task type's own `"reject"`) — Complete Review needs the shared screen's gates
  to run first, and Reject needs `decideDataStewardReview`'s result before the
  task can be patched. `applicationVersion` was bumped `1.3.0` → `1.4.0` → `1.5.0`
  across the two changes (outcomes added, then the id reused), per the rule
  pinned in `test/task-form.test.js`: the Lobby only re-reads `sap.bpa.task` when
  the task is re-pointed at a new version.
- **The processors strip and the merged search list both learned the new status.**
  `request-processors.js` gained a `checkAndEnrich` branch (step "Data Steward
  Review", named by whichever `dataStewardEmails()` resolves — read only while the
  status actually is `checkAndEnrich`, the same discipline `approvers` follows for
  `inApproval`) and `search-results.js`'s `IN_PROGRESS_REQUEST_STATUSES` /
  `STATUS_LABELS` both list it, for the same reason `reworkRequired` is in both: a
  human still owns the request.
- **Not built on Arthur's side at all yet** — this is further behind than rework
  was at the equivalent point, because nothing routes a task to a data steward in
  the first place: which condition sends a request to `checkAndEnrich` instead of
  straight through approval, how the parked instance is told to wait for
  `DataStewardComplete`/`DataStewardRejected`, and re-pointing whichever user task
  in the Lobby is meant to render `mdm.md.businesspartner.task` for this step. CAP
  and the UI hold up their end (the status, the actions, the screen, the task
  type) and wait for the process side the same way rework's did before Arthur
  wired up the rejection branch.

#### Highlighting what changed (2026-08-27)

A data steward enriching a request, or a requester reworking one, edits a record
somebody else already filled in - and until now nothing on screen said which
fields that touched. `BusinessPartnerMaintenance.controller.js` now colours a
changed value **light red** and an added one **light orange**, and leads the
screen with a collapsible three-column list of exactly what moved.

**A baseline is required, and it is not the same baseline for every request
type.** `state.trackChanges` decides whether one is meaningful at all:

- **A plain new create has none, on purpose.** `state.trackChanges` stays `false`
  (the `_emptyState()` default) all the way through `_onCreateRoute` - there is
  nothing to compare a brand new record against, so "changed" would mean nothing
  and "added" would mean everything, which is the one wrong answer this feature
  exists to avoid giving.
- **Editing a live Business Partner** (`_loadBusinessPartner`, `_onEditRoute`)
  compares against the values exactly as read from S/4, a moment before the
  requester or steward can touch them - `state.originalRoot`/`originalSections`
  are cloned right after that read, and `state.trackChanges = editing`.
- **A staged request** (`_loadStagedRequest` - rework, data steward review,
  approve, view, and the requester's own not-yet-submitted draft) tracks changes
  everywhere **except** a create-type draft reopened by its own requester:
  `state.trackChanges = state.requestType === "change" || mode !== "edit"`. That
  one exception is the same reasoning as the plain create route - continuing your
  own unsubmitted work is not a round somebody else is reviewing.
- **A change-type request is judged against S/4's OWN current values, re-read
  live**, never against staging's own copy. Staging holds the *merged* result -
  the partner's original fields and this round's edits sitting in the same
  object - so cloning it would compare a record against itself. `_loadChangeBaseline`
  calls `_fetchLiveSnapshotForDiff`, which repeats `_loadBusinessPartner`'s own
  root-plus-sections read (reusing `_loadSection` so the two cannot drift) rather
  than trusting anything carried over from an earlier load. Best-effort, the same
  discipline every other live S/4 read in this codebase follows: a re-read that
  fails leaves the as-loaded snapshot in place (a diff one round behind) rather
  than none at all, logged with `console.warn` and never shown to the user - they
  came here to review a record, not to hear about a comparison that could not run.
- **A create-type staged request's baseline is server-persisted**
  (`ChangeRequests.baselineDataJson`, `db/staging.cds`) - **revised the same day**
  after the first version (clone `state.root`/`state.sections` as this screen
  loaded them) shipped a real gap: a data steward's edits coloured correctly on
  their OWN screen, but the moment the request moved on to the approver, THAT
  screen's own load re-snapshotted against itself and the colouring vanished -
  exactly the "also in the following steps" case that was asked for. `submitRequest`
  and `resubmitRequest` write `req.data.DataJson` into it the moment the status
  becomes `inApproval` - a first submit's baseline is trivially its own data,
  which is why nothing is highlighted on a brand new create until someone edits
  it later. `getRequestPayload` returns it as `BaselineDataJson`, and
  `_loadChangeBaseline` parses it into `state.originalRoot`/`originalSections`
  when present, falling back to the as-loaded snapshot when it is not (a request
  never yet submitted - `trackChanges` is false there anyway - or a parse
  failure, logged rather than thrown).
  **Deliberately NOT reset by `decideDataStewardReview`'s own `'complete'`
  branch, and — reversed later the same day — not by `resubmitRequest` either.**
  The first cut of this feature had `resubmitRequest` write a fresh
  `baselineDataJson` on the reasoning that a resubmit follows a rejection and
  starts a new round, so whoever reviews it next should see only what changed
  since then. That shipped and was wrong: it is backwards from what was actually
  asked for. The requester's OWN rework edits are exactly what the next
  reviewer - an approver, or a data steward again - is meant to see highlighted,
  the same way a data steward's edits already stay visible through to the
  approver. So `resubmitRequest`'s final `UPDATE(HEADER)` no longer touches
  `baselineDataJson` at all, and **nothing after the very first successful
  `submitRequest` ever writes this column again**, however many rework rounds a
  request goes through: the baseline set at first submit is what a create
  request compares against for its entire lifetime.
  **The same guarantee is what makes it work when a rejection sends the
  request back to the REQUESTER instead** (confirmed 2026-08-27, asked for
  explicitly): `decideRequest`'s reject branch and `claimRework` - the stopgap
  for the missing reject callback - both only ever write `status` (and, for
  `decideRequest`, `rejectionComment`); neither touches `baselineDataJson`. So
  by the time the rework screen loads, the baseline is still whatever
  `submitRequest` last wrote - the pre-steward data - and the requester sees
  exactly what the steward changed, the same colours the approver would have
  seen had the request been accepted instead. Nothing extra had to be built for
  this; it falls out of the same one column never being reset except at the
  very first submit.

**Rows are matched by CONTENT against the baseline, never by `record.__state`**
- revised twice the same day, and the second revision is the one that stuck.
The first version read `__state` directly (`"new"` set by the Add/Edit dialog,
`"modified"`/`"changed"` by an edit or an accepted proposal) and coloured the
row straight off it - wrong, because that flag is staged as the DB `action`
column and **survives every reload**: a row the ORIGINAL requester added still
comes back `"new"` when a data steward opens the very same request. The second
version kept content-matching but still used `__state === "new"` as a
**tiebreaker** for an unmatched row - also wrong, and for the identical reason:
editing ONE field of that same original row (City, say) still failed the exact
match, `__state` still said `"new"`, and the row was classified as an ADDITION
against an empty baseline (`{}`) rather than a CHANGE against its real one. The
reported symptom was exact: changing City painted the whole row and listed
every one of its fields - Street, Country, everything - as "changed" in the
summary, because none of them were actually being compared against anything.

`matchSectionRows(records, baselineRecords, fieldNames)` now runs in two
passes and reads `__state` **not at all**:

1. **Exact matches are consumed first** - every field equal, in either order of
   the two lists - so an untouched row is never coloured just because some
   OTHER row in the section moved, and two identical rows are never both
   matched to the same baseline row.
2. **Whatever is left is paired off by BEST MATCH** (changed 2026-08-31, was
   array order): the remaining current row and remaining baseline row sharing
   the most fields are paired first, picked greedily across the whole
   remaining pool, repeated until one side runs out. A row is a CHANGE against
   its best-remaining baseline for as long as any remain, and only becomes an
   ADDITION once they run out - i.e. only once this section actually ends up
   with more rows than the baseline had. A row's own history (whether S/4 has
   ever seen it) plays no part any more; only whether a same-shaped baseline
   row still exists to have been edited FROM does.

This is still not exact without a stable row key (staging has one, a cuid, but
`getRequestPayload` strips it before it ever reaches the client) - an edit is
paired with the best-scoring remaining baseline row, not necessarily the one a
person would say it "really" came from. But array order was worse than merely
imprecise, and a live report on 2026-08-31 is what found it: a section with
several rows, **none of them edited by the requester**, still lit up with
"random" changed fields. Two rows can each fail the exact-match pass without
either being a real edit - one genuinely changed, forcing a reindex, and
another merely drifted in formatting a reload can introduce (a trimmed space,
a recast boolean) - and array order then pairs whatever is left purely by
position, so the two could get shuffled against EACH OTHER: the diff reports a
change in every field neither person touched. `sharedFieldCount` scores every
remaining (current, baseline) pair and the highest score is assigned first,
which is what makes the common case - one row genuinely edited among untouched
ones - behave exactly as before (there is only ever one pair left to score,
so nothing about the ranking can move it) while a multi-row mismatch no longer
compounds into unrelated fields lighting up. Still not perfect - two rows that
are GENUINELY both edited, in a way that scores identically against each
other's baseline, remain a coin flip a stable key would settle outright - but
undercounting additions is still the safe direction on the side that remains:
it never invents a change nobody made, which a `__state`-based guess already
proved capable of doing twice.

**A DELETED row - reported 2026-08-28, "als er een lijn verwijderd is kan je dit
niet meer zien met kleurencode, maar moet dit bovenaan wel vermeld worden".**
Whatever is still unconsumed in `remaining` once every current row has been
matched or paired off is a baseline row nothing corresponds to any more - a row
somebody deleted. It used to be dropped on the floor at the end of the function;
it now rides along as `results.deleted`, a property on the returned array rather
than a second return value, so every existing caller that reads the result as a
plain per-record array keeps working unchanged and only `_refreshChangeSummary`
reads it.

- **There is no row left in the table to colour**, which is exactly the
  complaint: a deletion is invisible by construction once the record is gone.
  The change summary panel is therefore the only place left that can still say
  so, and it does - one line per POPULATED field of the deleted row (mirroring
  how an ADDED row lists every field it populated, just with the value sides
  read the other way: old value shown, new value `"(removed)"`, `kind:
  "removed"`). A deleted row that was never actually filled in (added, then
  removed again without ever being edited) still gets one summary line, "Row
  removed", so the deletion itself is not lost even though it has no field
  worth naming.
- **The header counts removals separately from field changes** - "3 fields
  changed, 1 row removed" rather than folding a removed row's several fields
  into one combined number, which would overstate how many edits actually
  happened. This is what makes the removal visible "at the top" (asked for)
  even with the panel collapsed, the same way every other panel's header
  already summarises what it holds without being opened.
- `ObjectStatus`'s existing two-way ternary (`added` → Warning, else → Error)
  needed no view change: `"removed"` already falls into the `else` branch, and
  the `newValue` text itself says `"(removed)"`, so it reads as a distinct kind
  even sharing Error's colour with `"changed"`.

**`_renderSection` and `_refreshChangeSummary` both call the same function**
over the same two arrays, so the row a table colours and the row the summary
panel lists fields for are always the same row, matched the same way.

**Root fields have no row to match, so they are diffed value by value** -
`fieldChangeKind(baselineValue, currentValue)`: nothing when both sides agree,
`"added"` when the baseline was empty and this one is not, `"changed"`
otherwise - which deliberately also covers a field that was **cleared**: undoing
a value that was there is a change to the record, not nothing.
`BusinessPartnerFullName` is excluded everywhere this runs, root and summary
alike - it is S/4's own derivation (see "`BusinessPartnerFullName` is derived,
never stored" above), never something a requester or steward typed, so a diff
entry for it would report a change nobody made.

**The colour lives on the control, not in a binding**, because the root form is
built imperatively (`_createFieldGrid`/`_createFieldControl`), not from a model
path - a field's background is fixed at the moment its `VBox` wrapper is
constructed. `_createForm`/`_createFieldGrid` gained an optional trailing
`baseline` parameter for exactly this, and `_onFieldCommitted` re-renders the
whole root form after every commit (`change`, not `liveChange` - the field has
already lost focus) so a freshly typed value gets its class the same way a
freshly loaded one does. `_renderRootSection` and `_openAdditionalFields` pass
`state.originalRoot`, gated on `trackChanges` the same way the row colour is.

**A CHANGED row colours only the cell(s) that actually differ, not the whole
row** - reversed the same day it was first built for the same reason as the
`__state` fix above: colouring the entire `ColumnListItem` for one changed
field is indistinguishable, to someone looking at the table, from the bug
where every field was wrongly reported as changed. `_renderSection` now walks
`summaryFields` per row and calls `fieldChangeKind` against `match.baseline`
for **that field only**, colouring just its `Text` cell. **An ADDED row is
still tinted whole** (`mdmAddedRow`) - every one of its fields genuinely is
new, so there is nothing selective left to compute, and the whole-row
treatment costs nothing there. There is deliberately no `mdmChangedRow` class
any more.

**A section's Add/Edit dialog gets a baseline too now** - reversed the same
day from "never": colouring only the outer row left nobody able to see, while
actually editing a record, WHICH field inside the dialog differed from what it
used to be. `_openExistingRecord` resolves the matching row through
`_rowBaseline` - the exact same `matchSectionRows` call `_renderSection`'s own
row colour comes from, so the dialog can never disagree with the row it was
opened from - and `_openNewRecord` passes `{}` (every field typed into a
brand-new row is an addition, same as the row itself once it lands in the
table). `_createFieldGrid` already took a `baseline` parameter; `_createFieldTable`
(the compact layout `_createForm` uses for Customer/Supplier's grouped fields,
which sit directly above their own child tables in the same dialog) gained one
too, colouring the field control itself since a table cell has no label
wrapper to carry the class the way the grid's `VBox` does. One thing this does
**not** do: track further edits live while the dialog stays open the way the
root form does on every commit - the colouring is computed once, when the
dialog opens, against the values as loaded.

Hosted child sections (the ones a grouped dialog renders inline via
`childSections` - Customer/Supplier's own sales-area or tax tables) needed no
separate work: they render through `_renderSection` like any top-level
section, so the row-level fix above already covers them.

**A value picked from the F4 help never coloured either, on a root field or
inside a dialog** (found the same day, from a live report: a data steward
changed a root field through its value help and nothing lit up). The root
cause is `sap.m.SelectDialog`'s own `confirm` event, which is not the target
`Input`'s `change` event - `_attachCommitTrigger` listens for `change`, so
`_onFieldCommitted` (the one place the root form's recolouring, the summary
refresh, a tax number's registry trigger, and the debounced auto-check all
live) never ran for a value chosen this way, only for one typed. `_openValueHelp`'s
`confirm` handler now calls `this._onFieldCommitted(this._valueHelpTarget.section,
this._valueHelpTarget.field)` directly, straight after writing the value -
reusing the function rather than copying pieces of it, so a value-help-driven
field ends up handled identically to a typed one, not almost.

**The summary panel is a genuine three-column table** (`changeSummaryPanel`,
`Field` / `Previous Value` / `New Value`), not `sap.m.SelectDialog`'s pseudo-
columns - the same reasoning "The approver picker is sourced from the subaccount"
above already applied to the Workflow Agent Determination F4 help. The colour
sits on the **New Value** cell, via `ObjectStatus`'s `state` (`Warning` for an
addition, `Error` for a change), rather than on the row - keeping the panel to
exactly the three columns asked for while still carrying the colour. Built by
`_refreshChangeSummary`, which is the one place root and section diffs are
turned into `{ field, oldValue, newValue, kind }` rows; a **new** section row
lists each of its own populated fields against `"—"` rather than trying to name
a baseline that does not exist for it, and a **changed** row is matched against
its own baseline row by `matchSectionRows` - the same function and the same call
`_renderSection` makes, so the fields listed here are exactly the fields of the
row shown red or orange in the table.

**The panel is collapsible and empty-hides**, the same shape every other panel
above the form uses (`_setDuplicatePanel`, `_setCommentsPanel`): `visible` is
bound to `changeSummary.length > 0`, and the header carries a count so a
collapsed panel still says how much it holds.

**The comment thread moved to be the last panel above the form** (asked for the
same day): `commentsPanel` used to sit second, right after the message panel: it
now comes after the duplicate findings and the new change summary, immediately
before the `ObjectPageLayout` - nothing stands between the conversation and the
Business Partner's own name any more except that conversation itself.

##### The change summary names WHY a field changed, not only that it did (2026-08-31)

Asked for directly, alongside the field-property gating above: "Proposal info meenemen naar Changed
Fields overview... User input vermelden als 'User change/input'." A row in the panel used to say a
field changed and to what; it could not say whether that value came from VIES, a steward's typed
correction, or an accepted normalisation - three very different things to an approver deciding
whether to trust it.

**A fourth column, Why**, added to `changeSummaryPanel`'s table using the exact convention the
proposal dialog's own Why column already established: the three-word `reason` shown, the full
`detail` sentence on hover (`wrapping="false"` plus a `tooltip` binding - see "The Why column is
three words, with the sentence on hover" above). Reusing the convention rather than inventing a
second one answers the "met/zonder hover?" half of the ask: consistency with the dialog the requester
already saw the same reason in.

**Content-matched, the same choice `matchSectionRows` itself made for rows.** `state.proposalProvenance`
(`{ root: { field: {value, reason, detail} }, sections: { sectionId: [ {field: {...}} ] } }`) is
written by `_recordProvenance`, called from every one of `_applyProposals`'s three write points - a
plain field, a row-creating lead field, and that row's own key `extras` (all sharing the row's single
Why, the same way `_derivationRow` already shows one Why for a whole keyed row). `_provenanceFor`
reads it back and returns the stored `reason`/`detail` **only while the field still carries EXACTLY
the value the proposal wrote** (compared through the same `displayValue` formatter both diff sides
already use); anything else - never proposed, or proposed and then typed over - is `"User
change/input"` with no tooltip. This is deliberately the same design as row matching: nothing has to
remember to *clear* an entry when a field is edited again, because a further edit simply stops
matching on its own. The trade-off is the same one already accepted for row provenance being
index-keyed rather than a stable id: a section row that reorders (matchSectionRows re-pairs against a
different baseline row) can point a stale entry at the wrong index, which is a cosmetic mislabel, not
a data problem - nothing here writes to the request payload.

**`proposalProvenance` resets with the rest of `_emptyState()`** - a provenance entry only ever
describes the record currently on screen, and is never sent anywhere: `getRequestPayload`/`DataJson`
carry no such column, `db/staging.cds` has none, and nothing about it crosses to S/4 or to the next
person who opens the request. It exists purely to answer "why does this cell hold this value" for the
person looking at it right now.

**A removed row's summary lines get no Why at all** (`why: ""`) - there is no current value left to
attribute a source to, only the value that used to be there.

#### The approve screen as a BPA UI5 Task Form

**The task form is its own app since 2026-08-20: `app/bptask`
(`mdm.md.businesspartner.task`), freestyle UI5.** It used to be this Fiori
Elements app — `sap.bpa.task` in its manifest, `Component.js` implementing the
inbox contract on top of `sap.fe.core.AppComponent`. SAP documents UI5 task UIs
for **freestyle** apps; FE as a task host is not a combination they bless, and
"we embedded a Fiori Elements app as a task form" is where an incident stalls.
See "The shared maintenance screen" below for how the screen is shared rather
than copied. The contract itself is unchanged, and still comes from SAP Help,
*Technical Information for Adapting the SAPUI5 Application*.

**The outcome labels are literal text, not `{{...}}` keys — do not "fix" them
back.** Maarten set them this way on 2026-08-20: `{{Approve}}` resolves out of
the app's own i18n bundle, which is not where the Lobby looks, so the two i18n
keys went with them. `inputs` and `outputs` stay as they are; they declare the
task context for the Lobby, while the runtime reads none of it — `Component.js`
fetches `/task-instances/{id}/context` itself and PATCHes the whole context back.
`test/task-form.test.js` pins the labels.

**Nothing in the app's own footer reaches anybody in My Inbox.** That is the trap
this section cost most time to: the footer renders standalone, the tests only read
source, and the inbox chrome quietly drops it. Anything that must be pressable on a
task goes in the header actions or through `inboxAPI.addAction`.

**Verified end to end on 2026-08-20**: the partner app opens from the Work Zone
tile (so `resourceRoots` resolves the shared screen at runtime), and Arthur
re-pointed the SBPA user task at `mdm.md.businesspartner.task`, which rendered.
The `inputs`/`outputs` schemas above are the ones that worked — Arthur emptied
them on the old app in `1f5988f`; that is not needed and was not carried over.
**Re-pointing the user task in the Lobby is a manual step**: the app id changed,
so the process definition had to be edited and released. A future task UI rename
costs the same step.

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
- **Verifying `manifest.json` over HTTP proves nothing about what the app is
  running.** `build:cf` uses `ui5 build preload`, and `Component-preload.js`
  **embeds the manifest** — the runtime reads it from the bundle, not from the file.
  So fetching `…/manifest.json` can show a fix that the running app does not have,
  because the bundle at an unchanged version URL is still cached. Cost half an hour
  on 2026-08-21. To test a task-app change, disable the browser cache or move the
  app version; to check what is live, look at the URL the app actually requests.
- **The OData `dataSources` carry the DESTINATION SERVICE INSTANCE GUID as a prefix,
  and that is what makes the destination resolve** (2026-08-21, identified 2026-08-25).
  Proven by requesting the same resource two ways from a launchpad session:

  ```
  /mdmmdbusinesspartner.mdmmdbusinesspartnertask/service/businesspartner/$metadata      500
  /5db4d34d-….mdmmdbusinesspartner.mdmmdbusinesspartnertask/service/businesspartner/…   200
  ```

  Without the leading UUID the approuter cannot tell WHICH DESTINATION SERVICE INSTANCE
  to resolve `mdm-businesspartner-srv-api` from. `/api/` never needed it because it
  resolves a **`service`** (`com.sap.spa.processautomation`) rather than a
  **`destination`**, so no destination lookup happens at all — which is exactly why that
  one route worked throughout and sent the diagnosis down two wrong paths (a stale app
  version, then browser cache).

  **It is the instance GUID of `mdm-businesspartner-destination-service`** — confirmed
  2026-08-25 with `cf service mdm-businesspartner-destination-service --guid`. It is NOT
  a Work Zone content provider id, which is what this file called it for four days and
  what sent the next search to Channel Manager: a content provider ID is "up to 20
  alphanumeric characters, dots, or underscores" (SAP Help, *Multi-Tenancy
  Consumption*), so a 36-character hyphenated UUID can never be one. Nor is it the
  app-host GUID, the other plausible candidate.

  **It is landscape-specific and created by this MTA**, so it does not exist until the
  first deploy of a given subaccount finishes. That is what makes build-time
  substitution awkward: `mbt build` fixes `manifest.json` inside the app zip before any
  resource exists. Shipping this to a customer needs one of the routes under "Deriving
  it" below, not a literal.
- **The OData `dataSources` are ABSOLUTE, on that same derived app path** (fixed
  2026-08-21) — `/mdmmdbusinesspartner.mdmmdbusinesspartnertask/service/…/`, not
  `service/…/`. Embedded in My Inbox the app is served out of the HTML5 repository
  at its **version-stamped** path, and `/service/*` is not proxied there, so a
  relative uri resolved against it and every OData call answered **500 without ever
  reaching CAP** — nothing in `cf logs`, which is what made it look like a server
  fault for an afternoon. The evidence, from one page load:

  ```
  …mdmmdbusinesspartnertask-1.2.0/service/changerequest/$metadata   500
  …mdmmdbusinesspartnertask-1.2.0/reuse/view/…view.xml              200
  …mdmmdbusinesspartnertask/api/public/workflow/…/context           200
  ```

  Statics come from the versioned path; the approuter applies `xs-app.json` on the
  **unversioned** one. `Component.js` was already building its `/api/` URL that way,
  which is why the task context loaded while the data did not. **`app/businesspartner`
  keeps its relative uris** — it is served at the approuter app path with a
  cachebuster, where relative resolves correctly. Do not "make them consistent".
- **The prefix is carried in the TASK CONTEXT, because nothing else can carry it** (2026-08-25).
  `workflowContext()` sends `prefix` (the destination service instance GUID, read out of
  `VCAP_SERVICES` by `srv/ui-prefix.js`); `_initTaskForm` reads it off the loaded task context and
  `_appPath()` composes `/{prefix}.{sap.cloud.service}.{sap.app.id}/` in front of the still-relative
  `dataSources` uri. **`manifest.json` declares no OData model**, because a `dataSource`-backed one
  is built at init, long before any context exists.

  **Only the GUID crosses the wire, not the whole path.** The app already derives
  `{service}.{appid}` for its `/api/` URL, so CAP never has to know which of the three UI apps a
  task belongs to, and renaming the task app costs no CAP change.

  **The ordering is the design.** `_loadPermissions` and `getRouter().initialize()` moved out of
  `init()` into `_begin()`, which runs only once the prefix is known: both read models, and the
  models cannot exist earlier. Standalone calls `_begin("")` — no prefix, relative uri, which is
  what `ui5.yaml`'s `fiori-tools-proxy` serves.

  **A task with no `prefix` is reported, never guessed.** Falling back to relative would resolve
  against the launchpad root and 404 every call, which reads as a broken service rather than an
  unmapped task input — the exact misreading that cost 2026-08-25.

  Three routes were considered; the other two are recorded so nobody re-runs them:

  1. **Derive it from the URL the component loaded from — TRIED AND REVERTED.** `_appPath()` built
     from `sap.ui.require.toUrl(getComponentName())` with the version stamp stripped. Deployed,
     every call 404'd: the resource root is `/mdmmdbusinesspartner.mdmmdbusinesspartnertask-1.2.0/`
     — versioned and **unprefixed**. The app is served from a path that does not name the
     destination service instance, while `/service/*` is only routed on one that does.

     **What made it look derivable was an ellipsis.** The 2026-08-21 evidence is written
     `…mdmmdbusinesspartnertask-1.2.0/reuse/view/…view.xml`, and the `…` sits exactly where a GUID
     would be. It was read as proof the prefix was present. When an abbreviated URL is the evidence
     for a claim about a URL, get the full one.
  2. **Route `/service/*` as a business service so no GUID is needed — RULED OUT.** A route may
     reference a `sap.cloud.service`, but only for a *Business Service*: one whose VCAP_SERVICES
     credentials publish `sap.cloud.service` and `endpoints`, "provided via the `onBind` hook in the
     service-broker implementation" (SAP Help, *Integration with Business Services*). SBPA qualifies
     as a subscribed SaaS that registers itself; this CAP app is a plain CF app behind a destination,
     so it would need a service broker and a SaaS-registry registration.
  3. **Build-time substitution — not possible in one pass.** The destination service instance is a
     resource of this same MTA, so its GUID does not exist until the first deploy of a subaccount
     finishes, and `mbt build` has already sealed `manifest.json` inside the app zip by then.

  `UI_PATH_PREFIX` overrides the lookup if a landscape ever needs it named by hand.
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
- **A service model is read through `_serviceModel()`, never straight off the view**
  (fixed 2026-08-21). The handover calls `_loadStagedRequest` from `onInit`, and a
  view has not inherited its component's models at that point — propagation happens
  when it is placed in the control tree. `getView().getModel("cr")` answered
  `undefined`, so the first action call popped **"Cannot read properties of
  undefined (reading 'bindContext')"** and the form opened empty. The accessor tries
  the view first, so every routed path is untouched, and falls back to the
  component — the same fallback the rule pages use for their `dc` model, for the
  same reason. Only the readers that can run before the view is placed use it; the
  value-help dialog and the assistant are opened by a press, long after.

#### Contract the SPA side depends on

Changing any of these breaks Arthur's process definition, so agree the change
first rather than "fixing" it locally:

- Approver task URL: `<app-url>#/ChangeRequests/{changeRequestId}/approve`
- Requester rework URL: `<site-url>#BusinessPartner-manage&/ChangeRequests/{id}/rework`
- Data steward review URL: `<site-url>#BusinessPartner-manage&/ChangeRequests/{id}/datasteward`
  (sent as `datastewardurl`, added 2026-08-26 - not yet used by any process definition, see "Data
  steward enrichment")

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
  `{ changerequestid, requesttype, businesspartner, emailadressinitiator, bpurl, reworkurl,
  datastewardurl, prefix, businesspartnerinput, bpduplicates, approvers, criticalfield, datastewards }`
- **`prefix` must be mapped onto the approval AND rework task inputs** (added 2026-08-25, agreed
  with Maarten). It is the destination service instance GUID, and it is the only way the task UI
  can learn its own OData path — see "The task app". Declared in `app/bptask`'s `sap.bpa.task.inputs`
  as an optional string, so a task built before it existed still opens; the app then reports the
  missing input rather than 404ing every call. **An undeclared key never becomes task context**, so
  sending it is not enough on its own — the process definition has to declare and map it.
- `approvers` is an **array of strings** from the `WorkflowRules` table — e-mail
  addresses and role names mixed, `kind` derivable from the `@`. It is **not** an
  array of objects: see "What actually goes over the wire" under "Workflow rules".
- `criticalfield` (lowercase on the wire, like every other key here) is a
  **scalar `'X'`/`' '` flag**, never a list — see "Critical
  fields, entity-level only, and who to notify". `datastewards` is an **array of
  strings**, resolved fresh from BTP role collections, the same shape discipline
  as `approvers` for the same reason.

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

**The Wikipedia branch never had a `suggestedAddress` (fixed 2026-08-26).** The
REST summary API is a prose extract, nothing structured, and Wikipedia is the
branch a well-known company *always* takes — it is tried first and wins
whenever a search hit resolves to a non-empty summary, ahead of the DuckDuckGo-
backed public-web fallback that is the only place `suggestedAddress` was ever
built. So `businessPartnerCreationSuggestion` (`srv/business-partner-service.js`)
kept getting `research.suggestedAddress === undefined` for exactly the
companies most likely to have one, and "Create Suggested Business Partner"
filled in General only — no address row, nothing else, whatever the chat prose
said about the company. `addressFromPublicWeb` now runs the same DuckDuckGo
snippet search the fallback path uses, as a **supplementary** call once
Wikipedia has already answered, and merges its result in. Best-effort like
every other lookup here: wrapped in its own `try/catch`, so a failed or
fruitless address search costs only `suggestedAddress: null`, never the
Wikipedia result it was enriching.

**`CorrespondenceLanguage` joined the suggestion the same day, inferred from the
address country — `COUNTRY_LANGUAGE` in `srv/business-partner-service.js`.**
Deliberately narrow: only `NL`/`DE`/`FR`/`GB` map to a language, because those
are the only countries in reach where one business language is unambiguous.
`BE` and `LU` are left silent on purpose — Belgium splits Dutch/French, Luxembourg
Luxembourgish/French/German — a wrong guess there is worse than an empty field
the requester fills in themselves. `_onCreateRoute`'s allowlist grew the one key
to match.

#### Registry enrichment joined the suggestion (2026-08-27)

**The suggestion vocabulary now reaches a `TaxNumbers` row, and it does so through
the same GLEIF/VIES tools the duplicate check already trusts** — asked for
directly: "die VIES Check enz ook in die AI assistent... dat hij die tools ook kan
gebruiken om die BP data uit te breiden". `registryEnrichment` in
`srv/business-partner-service.js` calls `enrichCandidate`
(`srv/ai/registry.js`) with the requested company name and no typed tax numbers,
which runs GLEIF's name search on its own (VIES has nothing to validate yet).

Two things make this **narrower** than "let the assistant use the registry
tools", deliberately:

- **A tax number is only ever proposed once VIES has confirmed it, and only for
  Belgium.** GLEIF's `registeredAs` is a local company number (for Belgium, the
  KBO enterprise number) and `registeredAt` is a GLEIF registration-authority id
  (e.g. `RA000402`) — **neither is an SAP `BPTaxType`**, and proposing either
  directly would silently mis-file or corrupt the tax number on create. A Belgian
  enterprise number doubles as the base of the Belgian VAT number (`BE` + 10
  digits, zero-padded from 9) — the one enterprise-number-to-VAT-number
  relationship this app already relies on elsewhere — so `belgianEnterpriseNumber`
  derives the candidate and `checkVatNumber('BE', ...)` has to answer `VALID`
  before `BPTaxType: 'BE0'` is proposed. Any other country's GLEIF hit still
  contributes name and address, never a tax number: the equivalent
  register-number-to-VAT relationship is not something this app can generalise
  correctly today.
- **Registry data outranks the DuckDuckGo research, never the reverse.** In
  `businessPartnerCreationSuggestion`, a confirmed VIES name/address wins, then
  GLEIF's, then Wikipedia's title, then the plain requested name — each source is
  more authoritative about what the company actually is than the one before it.
- **Best-effort like every other lookup in this flow.** `registryEnrichment`
  never throws: a GLEIF or VIES outage costs the enrichment, never the
  assistant's answer. It runs unconditionally alongside `researchCompany`,
  because unlike Wikipedia/DuckDuckGo it needs no prior "which company" step —
  GLEIF searches by name directly.

#### A VAT number typed directly in the chat is answered directly (2026-08-27)

`registryEnrichment` only ever reaches VIES *indirectly*, by chaining off a GLEIF
name match — so a requester who pastes a VAT number straight into the chat
("BP ING aanmaken met VIes nummer BE0403.200.393") got a Wikipedia summary and a
suggestion to "check the official VIES-checker yourself", even though the number
was right there. Reported directly: the assistant already has VIES, it should
use it. `extractVatNumber` finds a VAT number in free text (a VIES-recognised
2-letter country code followed by 7–14 digits, dots/spaces/dashes tolerated —
`nationalNumber` in `srv/ai/vies.js` already strips those), and `directVatLookup`
calls `checkVatNumber` with it directly, independent of whether a company name
was even resolved.

- **Answered whatever VIES says, not only when it confirms.** The old
  Wikipedia-only path went silent on a VAT number entirely; `directVatLookup`
  returns the raw verdict (`invalid` / `unknown` / `not_applicable`) too, and
  `directVatAnswerLine` turns it into a plain sentence ("VIES says VAT number
  BE0403200393 is not registered.") — because staying silent on a number the
  requester explicitly gave it is the exact failure being fixed.
- **A confirmed direct hit outranks a name-matched one.** When
  `directVatLookup` returns `VALID`, its name/address/taxNumber replace whatever
  `registryEnrichment` found by name — the requester asked about this number
  specifically, which is a stronger signal than an inferred name match. The
  same BE-only tax-number discipline applies (`registryEnrichment`'s own
  reasoning): a non-Belgian confirmation still contributes name and address,
  never a tax number.
- **`businessPartnerCreationSuggestion` can now be named by the registry
  alone.** A requester who pastes only a VAT number, no company name, used to
  get no proposal at all (`name` resolved to `''` and the function returned
  `null`). It now falls back to `registry?.name` after the text-based
  extractors, so a confirmed VIES hit is enough on its own to name the
  proposal.
- **`check.vatNumber` is always the national number, without the country
  prefix** — `checkVatNumber` returns it that way on every verdict, confirmed
  or not, so `directVatLookup` builds every branch off the check's own fields
  rather than the raw regex match. Building a display label from the raw match
  instead doubled the prefix (`BEBE0403200393`) the first time this shipped —
  caught by a test, not by inspection.

**The model was never told about any of this, and that was the real bug.**
`registryEnrichment`/`directVatLookup` results only ever reached
`fallbackAnswer`, the deterministic string used when AI Core is off or fails —
the live model's own prompt context (`promptContext` in
`srv/ai/business-partner-assistant.js`) carried `externalResearch` (Wikipedia/
DuckDuckGo) but nothing from VIES or GLEIF. So the model, running normally,
had no VIES data to work with and reasoned its way to "tell the user to check
VIES themselves" — a plausible-sounding answer built from a genuinely empty
context, not a fallback-string bug. `registryFindings` is now a fourth
prompt-context field (`{registry, directVat}`, alongside `askSapAiCore`'s
existing `fallbackAnswer`/`externalResearch`/`duplicateCandidates`) and the
system prompt says plainly what it is and that the lookup already happened —
without that instruction the model has no reason not to hedge with "I cannot
access VIES" the way it would for anything else outside its context.

#### A requested role gets a role row, and the account group follows the existing derivation (2026-08-27)

Asking the assistant to create a supplier or customer used to propose General/
Addresses/TaxNumbers only — no `BusinessPartnerRoles` row, which meant the
existing `cvi_account_group` derivation (see "The account group derivation"
above) had nothing to key off, so the Customers/Suppliers section stayed empty
too even though the requester asked for one by name. `detectRequestedRoles` in
`srv/business-partner-service.js` matches `customer`/`klant`/`afnemer` → `FLCU01`
and `supplier`/`vendor`/`leverancier` → `FLVN01` against the free-text question
(a plain regex, not a model call — always on, unlike the model-based intent
parser which is `ASSISTANT_INTENT_SOURCE`-gated) and both can fire at once.

**The suggestion adds only the role row, deliberately nothing else.** The
Customers/Suppliers section itself is left empty: `cvi_account_group` already
fills it from `TBD001`/`TBC001` the moment Check or Duplicate Check runs, and that
is the same proposal-only path every other derivation in this pipeline follows —
inventing the account group here would bypass the requester ticking it, the exact
thing "A derivation may create the row it needs" (above) was built to avoid.

#### The transport became one JSON blob, because a tax number is a row (2026-08-27)

**`SuggestedData` is no longer flat.** It used to be root fields plus five
hard-coded `Address*` keys; it is now `{ root: {...}, sections: { Addresses: [...],
TaxNumbers: [...] } }` — the same `{root, sections}` shape a staged request
payload already uses elsewhere in this codebase. The registry enrichment above is
exactly why: a `TaxNumbers` row is a child entity, and no amount of widening a
flat key list can express one.

- **The client-side transport followed the shape change.**
  `BusinessPartnerAssistant.js`'s "Create Suggested Business Partner" button no
  longer serialises `draft` into `?key=value&...` — it JSON-encodes the whole
  object into a single `?draft=...` query parameter
  (`HashChanger.getInstance().setHash("BusinessPartners/create?draft=" +
  encodeURIComponent(JSON.stringify(draft)))`). `SuggestedData` was already
  JSON-parsed into `draft` before this point (`resultInfo`), so nothing changed on
  that side — only how it crosses into the hash.
- **`_onCreateRoute` parses `query.draft` and applies the two halves
  differently.** Root fields still come off an explicit allowlist,
  `ROOT_DRAFT_FIELDS` (a module-level constant, same five keys as before) —
  kept as a named allowlist rather than merging `draft.root` wholesale, because
  the create route is still a URL a query string can be hand-built against, even
  though in practice `draft` is server-generated. Section rows are applied by id:
  any key in `draft.sections` that matches a known section on `state.sections` is
  taken as an array of rows, each stamped `__state: "new"` the same way a manually
  added row is — an unknown section key is silently ignored rather than refused,
  since the source is this app's own suggestion, not a user typing arbitrary JSON.
- **No manifest change was needed.** The `BusinessPartners/create:?query:` route
  pattern already accepts any query key; `draft` is just one more.

`externalResearchAnswer` gets the registry result as a third, optional argument
and appends one line the chat prose is missing otherwise: "VIES confirms NAME —
VAT number BE0…" when confirmed, "GLEIF lists NAME in CITY (not confirmed via
VIES)" when it is not. This is the chat surfacing the same registry lookup the
Suggested Business Partner data already carries — asked for directly ("de AI moet
… direct alle beschikbare data opjalen en voorstellen"), so the answer text and
the create-form suggestion are never telling the requester two different stories
about what was found.

**The chat is a coloured list of turns, not a growing block of plain text
(2026-08-26, asked for).** `BusinessPartnerAssistant.js` used to hold one
`TextArea` and a `transcript` string, appending `"You: "` / `"Assistant: "`
prefixes to it — legible only by reading the prefixes out of a wall of text
that kept growing. It is now a `sap.m.List` of `sap.m.FeedListItem`s bound to a
`JSONModel` of `{ role, sender, text }` turns, built by a **factory** rather
than a static template — a factory is what lets each row's *style class* (its
colour) depend on which row it is, which a template cannot. Three roles, three
CSS classes, all keyed off SAP's own semantic background tokens
(`--sapInformationBackground`/`--sapSuccessBackground`/`--sapWarningBackground`
in `css/maintenance.css`) rather than fixed hex, so the colours stay
theme-correct without this file knowing which theme is active:

- `bpChatUser` — the requester's own question.
- `bpChatAssistant` — every assistant reply, including the transient "Looking
  up live S/4HANA data..." placeholder, which `popMessage()` removes once the
  real answer (or an error) is known rather than leaving it stacked above it.
- `bpChatSystem` — the one-time intro line only. It is not a turn either side
  spoke, so it gets its own colour rather than reading as the assistant's
  first reply.

One `pushMessage(role, sender, text)` helper is the only writer, so the screen
and the colour can never drift from each other the way two independent code
paths eventually would. `conversationHistory` — the narrower `{role, content}`
list actually sent to the model as `ConversationJson`, capped to the last 10
turns — is unchanged and stays deliberately separate from the screen's own
record: the system intro and error text belong on screen, never in what the
model reasons over next.

### UI (`app/businesspartner`) — Fiori Elements, extended
This is a separate npm project (own `package.json`, own `node_modules`) driven
by `@sap/ux-ui5-tooling`/`@ui5/cli`, not by the root CAP project. It is a
standard List Report / Object Page Fiori Elements app
(`webapp/manifest.json`) with custom extensions layered on top rather than a
hand-rolled UI5 app:
- The **maintenance screen itself is not here any more** — the controller, its
  view, `BusinessPartnerMetadata.js` and `BusinessPartnerAssistant.js` moved to
  `app/reuse` on 2026-08-20 so the task UI can render the same screen. See "The
  shared maintenance screen". `scripts/generate-maintenance-metadata.js` still
  lives here but writes into the library; re-run `npm run generate:metadata`
  (also part of `build`/`build:cf`) after changing `MAINTENANCE_ENTITIES` on the
  service side or the maintained entities won't line up.
- `webapp/ext/controller/ListReportExtension.controller.js` — controller
  extension for list-report behaviour.
- `webapp/ext/CustomActions.js` — custom toolbar actions, calling the
  `askBusinessPartnerAssistant` and `saveBusinessPartner*` actions on the CAP
  service.
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

Before the very first deploy of a subaccount, verify `postgresql-db`'s plan
name — it varies by entitlement, and `mta.yaml` currently requests `free`:
```bash
cf marketplace -e postgresql-db
```

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
