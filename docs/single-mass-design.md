# Single/mass unification — design and implementation plan

Status: **analysis only. Nothing in this repo was changed to produce this document** — no
schema, no server code, no UI, no tests. Every claim below is grounded in the current code with
`file:line` citations, gathered by reading `db/staging.cds`, `srv/change-request-service.{cds,js}`,
`srv/search-results.js`, `srv/partner-name.js`, `srv/checks/*.js`, `srv/wf/*.js`, the shared
maintenance screen (`app/reuse`), and `app/bptask`.

## Goal, restated

A change request always holds a **collection** of records; "single" is a collection of one.
Every capability that exists for one record today — every field, every sub-entity, the Check
pipeline, derivation/normalisation proposals, field properties, submit, the workflow step,
posting — must work across many, with no code path that branches on "single vs mass" for
anything semantic.

---

## STEP 1 — Current build, area by area

### db/staging.cds — STRUCTURAL, but only if done the way the industry-standard "header → items"
pattern suggests. There is a cheaper, additive-only path (see STEP 2).

- `ChangeRequests : cuid, managed { ... }` (`db/staging.cds:39-98`) is the header. Two fields make
  "one request = one business partner" load-bearing at the schema level:
  - `businessPartner : String(10)` (`:52`) — the target/posted BP number, a scalar.
  - `postedBP : String(10)` (`:86`) — the posting idempotency guard, a scalar.
- `general : Composition of one StagedGeneral on general.request = $self;` (`:102`) — the root
  identity node is **1:1** with the header, by explicit design (`:99-101`: *"General is 1:1, the
  rest match the object page sections."*). `customer`/`supplier` are also `Composition of one`
  (`:109-110`).
- Every other node — `addresses`, `roles`, `bankDetails`, `taxNumbers`, `identifications`,
  `industries`, the company/sales-area/purchasing-org children, plus ~15 more entities from
  `:430` to `:716` — is **already `Composition of many`**. The staging schema is not "singular"
  in general; it is singular specifically at the three root-identity nodes (`general`/`customer`/
  `supplier`) and at the header's own `businessPartner`/`postedBP` fields.
- Every `Staged*` entity's backlink is the same shape: `request : Association to ChangeRequests;`
  (e.g. `StagedGeneral:126`, `StagedAddresses:195`, `StagedRoles:215`, `StagedCustomer:268`,
  `StagedSupplier:283`, and identically on all ~25 more entities through `:708`). `CheckFindings`
  (`:375-399`) and `ChangeRequestComments` (`:408-421`) key to the header **only** — `CheckFindings`
  additionally carries loose `nodeName`/`fieldName` strings (`:382-383`) but no structural pointer
  to a specific row of a many-cardinality child.

**The trap**: `cds-deploy` can add an element and can neither drop nor retype one (documented
repeatedly in this codebase's own CLAUDE.md, most recently hit 2026-08-31 on `WorkflowRules`).
`request : Association to ChangeRequests` is part of every `Staged*` entity's type. Re-pointing
that association at a new `RequestItems` entity — the naive "insert an item layer between header
and staged nodes" design — is a retype of ~28 existing elements and would fail
`deploy_to_postgresql` identically on every retry, the same failure mode already documented for
`WorkflowRules.conditions`. **This naive shape is not viable as an in-place migration.** STEP 2
proposes an inversion that avoids it entirely.

### srv/change-request-service.js — STRUCTURAL at the submit/workflow boundary; UNCHANGED
everywhere else once the schema question is settled correctly.

Handler-by-handler (line numbers from `srv/change-request-service.js` unless noted):

| Handler | Single-record assumption | Would change under STEP 2? |
|---|---|---|
| `persist` (`:777-816`) | `SELECT.one`/`UPDATE`/`INSERT` keyed to one header ID | **No** — still one call per item |
| `writeStagedNodes` (`:564-604`) | One `changeRequest` id, one `payload.root` object (`:568-572`); collapses a to-one section to its first row (`:578-579`) | **No** |
| `loadStagedPayload` (`:1038-1065`) | `SELECT.one` for `general` (`:1039-1041`), one `{root,sections}` returned | **No** |
| `getRequestPayload` (`:1611-1675`) | `SELECT.one` for header and `general` (`:1612-1618`), one `{root,sections}` | **No** |
| `recordDuplicateFindings` (`:826-870`) | One `changeRequest`, one `businessPartner`, one candidate object (`:826-847`) | **No** |
| `buildBusinessPartnerInput` (`:520-549`) | Three `SELECT.one` reads (`:521-527`); `A_BusinessPartner` built as one object (`:535`); **`A_BuPaIndustry` is explicitly forced to the first row even though S/4 allows several** (`:541-543` — *"The workflow schema models A_BuPaIndustry as a single object even though S/4 ... allow several - take the first"*) | **No**, per item — see workflow note below |
| `postToS4` (`:1678-1811`) | One `header`, one resolved `businessPartner` (`:1683-1709`); child-node loop (`:1718-1808`) already posts arbitrarily many rows **per partner** | **No** — this is already exactly the "per-item posting with per-item idempotency" the goal asks for, because one item already *is* one header |
| `submitRequest` (cds `:38-59`; js `:1133-1218`) | One `persist`, one `workflowContext`, one `startWorkflow` call (`:1178`) | **Yes** — becomes a loop over items plus one group-level context |
| `resubmitRequest` (cds `:231-251`; js `:1222-1330`) | One parked `processInstanceId` guard (`:1232-1236`), one `triggerRequesterCallback` (`:1289`) | **Yes**, if the parked instance becomes group-level (see Phase 4) — **No** under the Option B workflow design (STEP 2) |
| `decideRequest` (cds `:185-206`; js `:1925-2036`) | One header, one `postedBP` guard (`:1937-1939`), `requiredApprovals`/`approvalsReceived` on the one header (`:2006-2034`) | **No**, called once per item; "approve all" is a UI loop over this unchanged action |
| `completeRequest` (cds `:213-221`; js `:2038-2061`) | Same shape as `decideRequest`'s approve branch | **No** |
| `claimRework` / `claimDataStewardReview` (`:1340-1354`, `:1413-1427`) | One header, one `postedBP` guard | **No** |
| `withdrawRequest` (cds `:318-329`; js `:1358-1403`) | One header, cascading deletes scoped to one `changeRequest` (`:1395-1400`) | **No** |
| `workflowContext` (`:609-706`) | Builds one SBPA context for one header — see dedicated note below | **Yes** |
| `runSubmitValidations` (`:1067-1077`) | Takes `(req, payload)`, resolves relation fields against one `businessPartner` (`:1075`) | **No** — called once per item |
| `runRequestChecks` (`:916-1022`, a closure inside `init()`, not a separate module) | `SELECT.one` header by `req.data.ChangeRequest` (`:939-943`); closures bake in one `BusinessPartner`/`ChangeRequest` for the standard/duplicate-check stages (`:1003`, `:1015-1016`) | **No** — called once per item, unchanged internally |

`ChangeRequests.requestType` (`db/staging.cds:40`) is `not null`, one scalar per header — under
STEP 2's design this is a **feature, not a limitation**: since each item stays its own
`ChangeRequests` row, a single submitted collection can already mix a `create` and a `change` in
the same batch with zero schema change, which the naive "one requestType for the whole batch"
design would have foreclosed.

### srv/search-results.js — ADDITIVE. No structural change required.

- `pendingCreateEntry` (`:82-112`) keys `ResultKey` as `` `CR:${request.ID}` `` (`:89`) and reads
  `entry.general` as one object (`:84-86`) — one row per `ChangeRequests` id, exactly matching one
  item under STEP 2's design.
- No loop over any many-cardinality staged child exists in this file today; the list's identity
  and full-name derivation are built entirely from the singular `general` node
  (`srv/partner-name.js:46-56`, aliased as `stagedFullName` at `search-results.js:80`).
- **Consequence**: if each "item" of a mass request stays its own `ChangeRequests` row (STEP 2's
  recommendation), this file needs **no code change at all** to "surface items individually" —
  it already does, one row per item, today. The only additive nicety would be a `GroupId`/badge
  column so a user can see which rows were submitted together.

### srv/checks/pipeline.js and the rule engines — CONFIRMED ALREADY PAYLOAD-PURE. Additive: call
N times, unchanged.

- `srv/checks/rule-engine.js`: `runValidationRule(rule, payload, model)` (`:254`),
  `runDerivationRule(rule, payload, model, mode)` (`:355`), `createConfiguredStages(...)` (`:530`)
  return `{name, run: async (payload) => ...}` closures over the rule rows, never over a request.
  No `cds.run`/`SELECT` anywhere in the file.
- `srv/checks/value-lists.js`: every export (`parseValueList`, `wildcardMatches`, `listMatches`,
  `joinConditions`, `foldConditions`) takes plain values/arrays only.
- `srv/checks/field-properties.js`: `resolveProfiles(profiles, settings, context)` (`:184`),
  `createFieldPropertyStages(resolved, model)` (`:268`) — pure over `(RequestType, Role)` scalars
  and an already-fetched config array; no per-ChangeRequest DB read.
- `srv/checks/workflow-rules.js`: `resolveApprovers({rules, requestType, payload, model})` (`:255`)
  — `rules` is pre-loaded, `payload` is one `{root,sections}` object; no DB call in the file.
- `srv/checks/payload-fields.js`: `sectionRows`, `resolvePayloadField`, `isEmptyValue`,
  `fieldValues` are all pure functions of their arguments.
- **The one exception is not in the engines** — it's the orchestration wrapper
  `runRequestChecks` in `change-request-service.js` (`:916-1022`, table above), which is keyed to
  one `req.data.ChangeRequest`. Under STEP 2, calling it once per item (unchanged internally) is
  exactly "the same path, called N times" the goal asks for — nothing inside the pipeline or the
  four rule-engine modules needs to change.

### app/reuse BusinessPartnerMaintenance — STRUCTURAL for a new list shell; the existing ~4000-line
screen becomes the per-item detail view, reused unchanged.

- `state` (`_emptyState()`, `:663-749`) is unambiguously single-record: `state.root` is one flat
  object (`:743-746`), `state.mode` one scalar (`:669`), `state.sections[id]` an array of children
  of that **one** root (confirmed by every `kind !== "root"` filter, e.g. `:785`, `:2146`, `:3502`).
  No array-of-roots, tab, or "records list" concept exists anywhere in this file today (checked and
  confirmed absent by the research agent).
- `_requestDataJson` (`:2142-2152`) builds exactly `{root, sections, deleted}` — one root.
  `_sendChangeRequest` (`:2242-2274`) sends `ChangeRequest`/`BusinessPartner` as scalars
  (`:2253, 2255`).
- `_loadStagedRequest` (`:3455-3694`) is called with exactly one `changeRequest` id from every
  route (`:3391-3432`) and from `app/bptask`'s event-bus handoff; it reads one `general` row into
  `state.root` unconditionally (`:3499`).
- `onCheck`/`onDuplicateCheck` (`:2612-2671`, `:2675-2748`) both send the single-item
  `{ChangeRequest, BusinessPartner, DataJson, RequestType, Role}` shape — the same shape
  `_runPreActionCheck` uses before Save/Approve.
- `BusinessPartnerAssistant.js` (`:52, 167-169, 200`) and the server-side `SuggestedData` builder
  (`srv/business-partner-service.js:1679-1699`) both produce/consume the identical
  `{root, sections}` single-record shape, confirmed on both the producer and consumer side.

**Consequence for STEP 2**: this entire controller — every route, `state` shape, save/check
payload builder — is exactly "the per-item detail view" already. Nothing in it needs to change.
What's new is a **shell above it**: a list view for a `RequestGroups` id that reads its member
items (via a query scoped to `group = X`, reusing `BusinessPartnerSearchResults`'s existing
per-row shape) and, on drill-in, routes to the *existing, unmodified* per-item routes.

### app/bptask — MINIMAL change, contingent entirely on the SBPA design choice in STEP 2.

- `_initTaskForm` (`Component.js:166-247`) requires exactly one `context.changerequestid` per task
  (checked at `:205, 219, 233`, each erroring if absent) and hands off to the shared screen via
  `_openApprove`/`_openRework`/`_openDataStewardReview` (`:263-349`), each carrying one
  `changeRequest` string.
- `_decideOnServer` (`:507-521`) sets a single `ChangeRequest` parameter on `decideRequest`.
- **If STEP 2 keeps one SBPA instance per item** (recommended, see below), `app/bptask` needs
  **zero changes** — every task My Inbox creates is still exactly what it is today, one task per
  item. "Approve all clean items" becomes a client-side loop this app's own change-request list
  runs over several individual `decideRequest`/`completeRequest` calls, not a native My Inbox
  batch action — worth stating plainly rather than implying My Inbox itself gains a "select many"
  capability it does not have.

### srv/wf/\* and the SBPA process — the process's own input schema is scalar, and the team does
NOT own it.

- `srv/wf/processAutomation.js`: `startWorkflow(definitionId, context)` (`:42-68`) POSTs one
  `{definitionId, context}` per call — one workflow instance per call, full stop.
  `triggerPostResult(executionId, inputs)` (`:126-128`) sends exactly
  `{businesspartnerid, businesspartnerfullname, status, errormessage}` — comment at `:119-125`
  states the contract is exactly these four fields, matched at the call site
  (`change-request-service.js:1850-1855`) with scalar values.
- `workflowContext` (`change-request-service.js:609-706`), field by field: `changerequestid`
  (`:665`), `businesspartner` (`:667`), `bpurl`/`reworkurl`/`datastewardurl` (`:669-675`, one
  change-request-scoped URL each), `businesspartnerinput` (`:678`, one object — see
  `buildBusinessPartnerInput`'s `A_BuPaIndustry`-forced-to-one-row comment above), `criticalfield`
  (`:699`, an explicit scalar `'X'`/`' '` — comment `:641-644` says outright *"a scalar flag, not a
  list ... asks one question, not one per entity"*) are **all scalar**. Only `approvers`,
  `bpduplicates`, `datastewards` are already array-shaped — but each is a list of *people or
  duplicate matches for the one item*, never a list of business-partner records.
- `srv/wf/btp-agents.js` and `srv/wf/data-stewards.js` are approver/notification-audience
  resolvers, confirmed to have no per-record structure and out of scope.
- `decideRequest`/`completeRequest` (`srv/change-request-service.cds:185-221`) both type
  `ChangeRequest : UUID not null` — a scalar reference by CDS type, not merely by convention.

**This is the load-bearing finding of the whole analysis**: the SBPA process definition Arthur
owns is single-partner-shaped **in its own declared schema**, not merely by this codebase's
choice (`buildBusinessPartnerInput`'s comment on `A_BuPaIndustry` proves the process's own input
type already collapses a many-cardinality S/4 field to one row). Making `businesspartnerinput` (or
any of the scalar fields above) list-shaped requires Arthur to change the process definition's
declared input schema — the same class of change CLAUDE.md already flags under "Ask before doing:
The SBPA contract ... changing any of it breaks Arthur's process definition. Agree the change
first." This is not a decision this codebase can make unilaterally, and STEP 2 does not assume it.

---

## STEP 2 — The plan

### The central design decision: invert the hierarchy, don't insert one

The naive shape — `ChangeRequests` (header) → `RequestItems` (new) → today's `Staged*` nodes —
requires retargeting every `Staged*.request` association from `ChangeRequests` to the new
`RequestItems` entity. That is a retype of ~28 elements and is not deployable in place (see STEP 1).

**The additive-safe alternative: add a new parent above `ChangeRequests`, not a new child below
it.**

```cds
/** A submitted collection of one or more items. A "single" request is a group of exactly one -
 *  there is no code path that treats a one-item group differently from an N-item one. */
entity RequestGroups : cuid, managed {
  processInstanceId    : String(60);   // ONE parked SBPA instance for the whole group
  requiredApprovals    : Integer;
  approvalsReceived    : Integer;
  approverSequenceJson : LargeString;
  submittedAt          : Timestamp;
  submittedBy          : String(120);
  items                : Composition of many ChangeRequests on items.group = $self;
}
```

And, purely additive on the existing `ChangeRequests` entity (new nullable elements only — no
existing element's type changes):

```cds
group    : Association to RequestGroups;  // null for a request created before this ships
sequence : Integer;                        // display order within the group; no other semantics,
                                            // the same convention DuplicateRules.sequence already uses
```

Everything each `ChangeRequests` row already *is* — its own `general`/`customer`/`supplier`,
its own `businessPartner`, its own `postedBP`, its own `requestType`, its own findings and
comments — is **completely untouched**. An "item" in the new model is not a new concept at all:
**it is today's `ChangeRequests` row, unchanged.** This is what makes the rest of the plan cheap:
every handler in the table above that operates on "one header" already operates on exactly one
item, with zero code change, because the item *is* the header.

**Migration mechanics**: `RequestGroups` is a brand-new entity (no risk). `ChangeRequests.group`
and `.sequence` are new nullable columns (additive, no risk, per the standing
`cds-deploy` rule). No backfill is strictly required — existing rows simply have `group = null`
and are read as "an ungrouped, standalone item" until the code paths below start always creating a
group. If a single migration script is wanted for cleanliness, `cds deploy --script` can backfill
one `RequestGroups` row per existing `ChangeRequests` row and set `group` accordingly — this is
optional, not load-bearing, and can be deferred indefinitely without blocking anything.

### The shared entry point

Refactor `submitRequest`'s current body (`change-request-service.js:1133-1218`) into two layers:

1. `submitOneItem(req, groupId, itemPayload)` — everything `submitRequest` does today
   (`persist`, `runSubmitValidations`, `recordDuplicateFindings`) **except** the workflow start,
   parameterised by an already-known `groupId` instead of creating its own. This is a pure
   extraction of existing code; no behaviour changes.
2. `submitRequest` (single-item, kept for backward compatibility with any direct caller) becomes:
   create one `RequestGroups` row, call `submitOneItem` once, build `workflowContext` for that
   one-item group, `startWorkflow` once. **This is "single-create constructing a one-item
   request and calling the identical path"** — literally the same function a mass submit calls
   with `Items.length === 1`.
3. A new `submitRequestGroup` action takes `Items : array of { RequestType, BusinessPartner,
   DataJson }`, creates one `RequestGroups` row, calls `submitOneItem` once per array entry
   (a loop, not a rewrite), aggregates one `workflowContext` for the group, starts one workflow.

`resubmitRequest`, `decideRequest`, `completeRequest`, `withdrawRequest`, `claimRework`,
`claimDataStewardReview`, `decideDataStewardReview` all keep operating on one `ChangeRequest`
UUID, **unchanged** — a "per-item" or "approve all" UI action is a client-side loop over these
same actions, never a new server code path per action.

### The workflow step: two designs, pick B first

**Option A — true unification.** One `RequestGroups.processInstanceId`, one SBPA instance for
the whole group, `businesspartnerinput`/`bpurl`/etc. become array-shaped. **Requires Arthur to
redefine the SBPA process's declared input schema** — the exact "ask before doing" class of
change CLAUDE.md already flags. Not something this team can land unilaterally, and there is no
guarantee it happens on any particular timeline.

**Option B — grouped items, independent instances (recommended for Phases 1-3).** Each item keeps
starting its own SBPA workflow instance exactly as `submitRequest` does today — `submitOneItem`'s
loop calls the *existing* `workflowContext`/`startWorkflow` pair once per item, unchanged. The
`RequestGroups` row is a CAP-side/UI-side grouping only: My Inbox shows N separate tasks (as it
does today for N separate requests), and this app's own change-request list visually clusters
them by `GroupId` and offers "decide all clean items in this group" as a loop over N ordinary
`decideRequest` calls. **This satisfies "ONE parked SBPA instance per request" at the level that
matters operationally today — per item — without asking Arthur for anything**, at the cost of not
literally having one instance span the whole group. State this trade-off plainly to the business:
Option B ships now; Option A is a negotiated follow-up, if the product ever needs a single
combined approval task for a whole batch rather than N individually-approvable ones.

### UI: the existing screen becomes the per-item detail view

- New: a list shell (a new route, e.g. `RequestGroups/{id}`) that reads the group's member items —
  a thin query, same shape `BusinessPartnerSearchResults` already returns per `ChangeRequests`
  row (`search-results.js:82-112`) — and renders them as rows.
- "Add a line": re-enter the existing create flow (`BusinessPartnerMaintenance` in `create` mode,
  completely unchanged) with one new fact threaded through: the `group` id already in progress.
  `_sendChangeRequest` (`:2242-2274`) needs exactly one new optional parameter (`Group`) passed to
  `submitOneItem`'s draft-save path — everything else in that ~4000-line controller is untouched.
- "Drill into a line": navigate to the *existing* per-item route (`ChangeRequestEdit`,
  `ChangeRequestApprove`, etc.) with that item's own `changeRequest` id — no new route logic in
  the detail screen itself.
- Save Request (draft, not submitted) already works per item today; a draft group is simply
  N draft `ChangeRequests` rows sharing one (not-yet-submitted) `group` — no new mechanism.

### Per-item approval

- `RequestGroups` does **not** need its own `requiredApprovals`/`approvalsReceived` under Option
  B — each item keeps its own (`ChangeRequests.requiredApprovals`/`.approvalsReceived`, unchanged
  fields, unchanged logic in `decideRequest:2006-2034`). "Approve all clean items" is: for each
  item in the group with no blocking finding, call the existing `decideRequest` action — a UI
  loop, zero new server logic.
- Partial approval falls out for free: some items in a group can sit at `inApproval` while others
  are already `posted`, because each item's status lives on its own row, exactly as today.
- The rework loop (`claimRework`, `decideDataStewardReview`, the `reworkRequired` cycle) is
  **entirely unchanged** — it already operates on one `ChangeRequests` row's own
  `processInstanceId` (Option B keeps this per item), so rework on item 4 of a 10-item group has
  zero interaction with items 1-3 and 5-10.

### Per-item posting and partial-failure handling

Already true today, per row, with zero new code: `postToS4` (`:1678-1811`) succeeds or fails
independently for one `header`. A group-level "post everything approved in this group" action is:
loop the group's items, call `postAndRecord` per item inside its own `try`/`catch`, collect
per-item results. Item 37 failing does not touch items 1-36's already-written `postedBP` — this
is the existing idempotency guard (`:1937-1939`, `:2045-2047`, written once at `:1881-1886`)
working exactly as it does for a single request today, just invoked N times instead of once.

### BusinessPartnerSearchResults surfacing items individually

No code change required (STEP 1 above) — one row per `ChangeRequests` id is already what
`search-results.js` produces. The only addition worth making, and it is cosmetic: an additive
`GroupId`/`GroupSize` field on the read projection so the list can show "3 of 5 in this batch" —
computed from the new `group` association, never changing `ResultKey`'s per-item identity.

---

## Constraints held

- **Determinism and fail-loud in the engines** — untouched. Nothing in `rule-engine.js`,
  `value-lists.js`, `field-properties.js`, `workflow-rules.js`, or `pipeline.js` changes; they are
  called once per item, exactly as they are called once per request today.
- **stage → check → approve → post** — untouched per item. The group adds no new stage; it adds a
  loop around the existing four.
- **ONE parked SBPA instance per request across rework rounds** — held **per item** under Option
  B (the only viable option without external agreement); a genuinely single instance across an
  entire N-item group is Option A, explicitly deferred pending Arthur's sign-off.
- **Additive-only schema changes wherever possible** — held exactly: one new entity
  (`RequestGroups`), two new nullable columns on `ChangeRequests` (`group`, `sequence`). Nothing
  existing is dropped or retyped.

---

## Phased rollout

**Phase 1 — Model, invisible.** Add `RequestGroups` + `ChangeRequests.group`/`.sequence`. Extract
`submitOneItem`; `submitRequest` calls it exactly as described above, always creating a one-item
group. **Zero visible UI change, zero SBPA change, zero risk to any existing flow** — this phase
only proves the abstraction holds by making every request, including today's, go through it.
Shippable alone.

**Phase 2 — Add-a-line and the list shell.** `submitRequestGroup` action; the list-shell UI;
"Add a line" wired into the existing create flow. Submitting still starts N independent SBPA
instances (Option B) — no negotiation with Arthur needed. Shippable alone once Phase 1 is live.

**Phase 3 — Grouped approval and posting conveniences.** The change-request list clusters by
`GroupId`; "approve all clean items" and "post everything approved in this group" ship as UI loops
over the unchanged per-item actions. Shippable alone once Phase 2 is live.

**Phase 4 — True single-instance workflow (Option A), if and when Arthur agrees.** Requires the
SBPA process's own input schema to accept an array for `businesspartnerinput`/related fields.
Independent of Phases 1-3 — nothing in them needs to be revisited or reverted if this phase never
happens.

---

## Irreversible, high-risk, or hard-to-hold-the-line items

1. **The naive header→items schema is a dead end, not a starting point.** If anyone attempts the
   "insert a `RequestItems` layer, reparent the `Staged*` nodes" design instead of the inversion
   above, it will pass code review, pass local tests, and then fail `deploy_to_postgresql`
   identically on every retry the moment it reaches a real Postgres — the same failure class this
   codebase has already hit twice on `WorkflowRules.conditions`. Flag this design mistake before
   it is written, not after a failed deploy.
2. **The SBPA process schema is the one thing this team cannot change unilaterally.** Option A
   is not a coding task; it is a negotiation. Treat "the workflow step is unified across the
   collection" as **aspirational** until that negotiation concludes, and ship Phases 1-3 (which
   deliver nearly everything in the goal) without waiting for it.
3. **"No branch on single vs mass" is hardest to hold in exactly one place: `workflowContext` and
   `buildBusinessPartnerInput`.** Under Option B these functions are called once per item,
   unchanged — genuinely branch-free. The moment anyone attempts Option A, these functions must
   grow real single-vs-many logic (build one context object vs. an array of them) unless the SBPA
   schema itself is redesigned symmetrically (e.g., "one context, one `items` array field, always,
   never a bare object") — which is itself a reason to insist Option A's schema be array-shaped
   from day one rather than "object for one, array for many."
4. **`ChangeRequests.requestType` staying per-item (not per-group) is a deliberate choice, not an
   oversight** — it is what lets a group mix `create` and `change` items for free. If a future
   requirement insists a whole group must share one type, that becomes a NEW validation rule in
   `submitRequestGroup`, not a schema change.
5. **Draft groups and `postedBP`'s retention question** (already an open "ask before doing" item
   in CLAUDE.md, unrelated to this design) gets slightly sharper under grouping: a group with 8
   posted items and 2 still in draft is a state this app has never had to represent before.
   Nothing in this plan requires resolving it now — it only requires *acknowledging* that "delete
   a group" is not equivalent to "delete N `ChangeRequests` rows" once any one of them carries a
   `postedBP`.
6. **Migration backfill is optional but not free if done.** A `cds deploy --script` backfill of
   `RequestGroups` for every historical `ChangeRequests` row touches every existing staged/posted
   request in the database exactly once — low risk in isolation, but it is the kind of one-shot,
   hard-to-rehearse operation that belongs in a maintenance window, not a routine deploy.

---

## One automated test that fails the build if single and mass ever diverge

**`test/single-mass-parity.test.js`** (name/location only — not written):

Take one representative `{root, sections}` fixture payload (reuse an existing test fixture, e.g.
from `test/quality-rule-engine.test.js` or `test/derivation-adds-row.test.js`). Run it through the
**real** `runChecks`/pipeline stages twice:

1. As the sole item of a one-item group (today's behaviour, unchanged call).
2. As item 2 of a 3-item group, with two arbitrary *different* filler payloads as items 1 and 3.

Assert the findings/derivations/proposals produced **for that one payload** are
`assert.deepEqual` in both runs. Because the pipeline and every rule-engine module are confirmed
pure functions of their own payload argument (STEP 1), this test is a direct, mechanical proof
that batching never leaks context between items — if a future change ever makes an engine read
"how many items are in this request" or "what item index am I," this test fails immediately,
independent of whether anyone thought to update it for the new code path.

A second, cheaper tripwire worth adding alongside it: a source-grep test (in the same style as
this codebase's existing structural tests, e.g. `test/quality-rules-page.test.js`) that fails if
`srv/checks/*.js`, `srv/change-request-service.js`'s `submitOneItem`/pipeline call sites, or
`workflowContext` ever contain a literal branch on `items.length`, `isMass`, `isSingle`, or similar
— catching the *intent* to special-case count even before a behavioural difference is observable.

---

## Recommendation

**Land Phase 1 now; hold Phases 2-4 for a concrete trigger.**

Phase 1 is additive-only, invisible to every existing user and integration, and costs almost
nothing to build or review — it only requires extracting `submitOneItem` from `submitRequest`'s
existing body and adding one new entity plus two nullable columns. Landing it now means the
"collection of one" abstraction is exercised by every request from day one, instead of being
retrofitted later under time pressure once a real multi-record ask arrives — and it eliminates
forever the risk of someone reaching for the naive, non-deployable header→items schema.

Phases 2 and 3 are genuine new feature surface (a list shell, grouped approval, grouped posting)
that should wait for an actual product requirement to build a mass-create/mass-approve flow —
building them speculatively risks shipping UI nobody asked for yet, in a codebase that already
documents "don't design for hypothetical future requirements" as a standing discipline.

Phase 4 should not be scheduled at all until Arthur has agreed to change the SBPA process's input
schema — it is an external dependency, not an engineering task, and treating it as anything else
risks the whole unification effort stalling on a decision this team does not control.
