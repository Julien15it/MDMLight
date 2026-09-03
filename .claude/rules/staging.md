# Change request staging (approve-then-create)

<!-- paths: db/staging.cds, srv/change-request-service.*, srv/search-results.js, srv/partner-name.js -->

**Nothing reaches S/4 until it is approved.** Creates used to post immediately and start the workflow
afterwards, so the approver reviewed something already live. **Do not reintroduce that order.**

1. User fills the create form (no Preview step — Check, Save Request and Submit Request are live on the
   empty form).
2. **Submit Request** writes to staging; **Save Request** stores a draft without starting anything.
3. The SBPA workflow starts and a task lands in the approver inbox.
4. The approver opens the same maintenance screen in approve mode, read back from staging.
5. On approve, CAP posts to `API_BUSINESS_PARTNER`. **SBPA never writes to S/4.**

`db/staging.cds` holds `ChangeRequests` plus one `Staged*` node per object-page section,
`CheckFindings` and `ChangeRequestComments`. `srv/change-request-service.cds` exposes
`ChangeRequests`/`CheckFindings` as `@readonly` and does every write through actions, so a status
cannot be forged from the client. `srv/change-request-service.js` never talks to S/4 directly —
posting is delegated to `BusinessPartnerService`, which owns the connection and payload sanitizing.

Every child node carries an explicit `request` backlink, so **the to-one compositions (`general`,
`customer`, `supplier`) need an `ON` condition too** — without it CAP puts a foreign key on the header,
duplicating the link and producing a schema that later fails to migrate.

## Statuses

`ACTIVE_REQUEST_STATUSES` is a **lock** (governs the refusal to edit, `openEditPage` in
`CustomActions.js`) and includes `approved` and `failed`, because a failed post is not atomic.
`IN_PROGRESS_REQUEST_STATUSES` (`srv/search-results.js`) is narrower — `draft`, `inApproval`,
`reworkRequired`, `checkAndEnrich` — and answers "is a human still holding this". **Do not collapse
them.** `posted` is the only terminal status; a withdrawn request is deleted. `rejected` is in the enum
and nothing writes it any more, but it cannot be dropped, so **no reader may fall through on it**.

`checkAndEnrich` is its own status, in `EDITABLE_STATUSES`, `ACTIVE_*` and `IN_PROGRESS_*`.
`WITHDRAWABLE_STATUSES` aliases `EDITABLE_STATUSES` (test-pinned). `reworkRequired` is an
`ACTIVE_REQUEST_STATUS` — the requester is about to edit and resubmit.

## The merged search list

The list report reads **`BusinessPartnerSearchResults`**, not `BusinessPartners`: live S/4 partners and
in-flight change requests in one result set, so a requester can see the company they are about to
request is already being created. A partner under an in-flight request is **marked, never hidden** —
the object page still reads `BusinessPartners`, so a hidden partner could not be opened for display.

Two kinds of row: a **pending create** has no partner number and is its own row (`ResultKey: 'CR:<id>'`,
`IsChangeRequest: true`), named by `stagedFullName`. A **change/block/delete** request is the existing
partner's own row (`ResultKey: 'BP:4711'`) carrying `RecordStatus`/`RecordStatusCriticality`/
`ChangeRequest`; its staged copy is never listed separately, or one company is reported twice.

The entity is `@cds.persistence.skip`; one READ handler merges:

1. **Staging is read first** and staged rows take the top of the list, which is what makes `pageSplit`
   exact — page 2 resumes the remote read at `skip - pendingCount`.
2. Staged rows are filtered **in memory** by `matchesWhere`/`matchesTerms`. An expression `matchesWhere`
   cannot evaluate **keeps** the row and logs `[search]`: a staged request wrongly shown is a nuisance,
   one wrongly hidden is the failure this list exists to prevent.
3. The remote read asks for a **fixed** column list (`PARTNER_FIELDS`) — one unknown field fails it all.
4. **`$count` arrives from the V2 remote as a STRING.** `partners.count + pending.length` concatenates
   (`"323" + 57` → `"32358"`). Coerce both sides.

- Computed columns are non-sortable (`NonSortableProperties`): sorting on one would silently sort the
  staged half only. `remoteOrderBy` drops anything S/4 has never heard of, `ResultKey` included.
- **Every filterable column must also be in `UI.SelectionFields`** — OData V4 Fiori Elements builds the
  filter bar from that list alone, with no "every property is a candidate" fallback.
- **Change-request columns are filterable.** `referencedFields` walks the WHERE clause and, if any field
  falls outside `PARTNER_FIELDS`, fetches the full matching population and filters in memory
  (`mergeLocalPage` against `entry.row`, not `entry.searchable`), sorts by `byRequestedAtDesc` and pages
  locally — so that branch's `$count` is exact. A `console.warn` names the fields that forced it. A
  mixed filter works because the whole clause is evaluated once against the whole merged population;
  splitting it would be the optimisation, and correctness came first.
- **A change request row opens read-only, for anyone**, via `ChangeRequests/{id}/display`. Editing a
  draft still means the steward-gated Change Requests list; an `inApproval` request is decided from the
  inbox against a real task. `onSave` refuses an unrecognised mode.

Change requests have their own list, reached from a **steward-only** button (`{perm>/isDataSteward}`).
Consequence accepted while only the dev team files requests: **a requester cannot reach their own saved
draft.**

## `BusinessPartnerFullName` is derived, never stored

A standard S/4 field marked `sap:creatable="false" sap:updatable="false"` — S/4 composes it and refuses
to be told it. Hence uneditable on the maintenance screen, and absent from the Field Properties catalog.

A **pending create** has no such name anywhere, so `srv/partner-name.js` composes it — the BP category
decides which fields to read (1 person, 2 organisation, 3 group), because S/4 discards name fields that
do not match the category; an empty answer falls through the other groups rather than leaving a request
unnamed. **One composed name, two consumers**: `stagedFullName` *is* `fullNameOf`, and
`buildBusinessPartnerInput` wraps the root row in `withFullName`.

**Never write it into a request payload.** `ROOT_CREATE_EXCLUDED_FIELDS` holds it and
`BusinessPartnerName`. On screen `_refreshFullName` recomposes from `previewName`, **guarded on a name
field having actually changed** — on a partner read from S/4 that value is S/4's own derivation.

## The request screen's message area

Strips live in a collapsible `Panel`. The header carries the leading message elided with `(+N more)`;
a Warning leads; anything above Information opens the panel. `expanded` is bound **one-way** so a render
re-applies it — accepted over a state flag all thirteen `state.messages = …` sites would have to set.

**The findings follow the request into the approval task.** `getRequestPayload` returns `FindingsJson`
(duplicate findings only, same `isStale` filter) and `ValidationsJson`, and `_loadStagedRequest` feeds
them to the same `_setDuplicatePanel`/`_validationMessages` the requester saw — one piece of code, so
the two screens cannot drift. Validations are written **after** the blocking gate and **before** the
duplicate check, and are **superseded, not deleted**, on a resubmit. Messages are appended **after** the
mode branches, since every branch assigns `state.messages`.

`srv/request-processors.js` (a "who has it now" sentence, `ProcessorsJson`) is **on the server and no
longer rendered** — kept to build a different surface on.

## The 31-section read, and the log that will decide what to do about it

`getRequestPayload`, `loadStagedPayload`, `recordDuplicateFindings`, `withdrawRequest`, `postToS4` and
`writeStagedNodes` each walk all 31 `NODES` one query at a time — `writeStagedNodes` worst at a DELETE
plus an INSERT per section. `getRequestPayload` logs `[staging] payload read: N sections in Xms,
slowest <section> at Yms` on every screen open, deliberately, because the fix depends on the answer:
**flat milliseconds ×31 is round-trip latency** (read the sections in one composition expand —
`@cap-js/postgres` resolves those with JSON aggregation in a single statement), **one slow section is a
missing index on `request_ID`**. Do not reach for `Promise.all` first: inside a request handler these
share the request's transaction, so they queue on one connection and concurrency may buy nothing.
Drop the log once the question is settled.

## Security gaps, known and open

- **Nothing authorises the staged payload.** `getRequestPayload` has no check in front of it and
  `@readonly ChangeRequests` is readable by any authenticated user through `$expand`. Restricting it to
  steward-or-requester today would break every approval, because an approver is neither. Closing this
  needs the role model.
- **`completeRequest` has no scope restriction** and writes to S/4 — any authenticated user can force a
  post. Restrict it to the SBPA technical user before this goes anywhere real.
