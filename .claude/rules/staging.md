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

## The 31-section read: measured, and left alone

`getRequestPayload`, `loadStagedPayload`, `recordDuplicateFindings`, `withdrawRequest`, `postToS4` and
`writeStagedNodes` each walk all 31 `NODES` one query at a time — `writeStagedNodes` worst at a DELETE
plus an INSERT per section.

**It was instrumented and it is not worth restructuring.** `getRequestPayload` logged its own timings on
every screen open for one afternoon (2026-09-03): **25–28ms for all 31 sections, no section above 2ms**,
on the dev BTP Postgres with real staged requests. Evenly spread, so round-trip latency — but ~0.8ms of
it per section, far too little to pay for reading the sections in one composition expand
(`@cap-js/postgres` resolves those with JSON aggregation in a single statement) and nowhere near the
single slow section that would have meant a missing index on `request_ID`. The log is gone; the numbers
are in the code comment so nobody re-derives them.

**Do not reach for `Promise.all` here.** Inside a request handler these share the request's transaction,
so they queue on one connection and concurrency buys nothing. Re-measure rather than assume if the
section count or the rows per request change shape.

## Posting: the CVI window, and what a failure is allowed to claim

Two defects from one live report (2026-09-03): an approver was told the post had failed, the
requester opened the rework screen, and **the business partner was already there and active.**

- **`postToS4` waits for the Customer/Supplier record instead of reading once.** With CVI configured,
  creating the BP with an `FLCU01`/`FLVN01` role is what creates the customer or vendor — and S/4
  does that in **postprocessing, after the root create has already returned**. Read inside that
  window, `to_Customer` honestly 404s on a partner that is about to have one, and the post either
  refused a child (*"has no Customer record yet"*) or tried to CREATE the role node S/4 was already
  creating. `awaitRelationNumber` retries while the answer is "not there"
  (`RELATION_WAIT_ATTEMPTS`/`RELATION_WAIT_MS`, ~3s), then returns **null exactly as before** —
  absence is still the caller's to interpret. **When the wait succeeds the post simply carries on and
  the request lands on `posted`**; that is the fix, not a nicer failure. Waited for **only straight
  after a root create** (`createdRootNow`), the one moment the race exists — on a retry or a change
  request the partner has existed for minutes and a missing record is not coming. That narrowing is
  what lets the budget be generous instead of short.
- **A failure after the root create must not claim the partner does not exist.** `postToS4` persists
  `header.businessPartner` the moment the root create succeeds, so a header carrying one means S/4
  has the partner and something *later* failed. The comment and the task app's dialog now say
  *"Business Partner N WAS created … but the rest of the request could not be posted"*, and
  `BusinessPartner` survives on a **failed** decision so the client can tell the two apart. **Do not
  blank it out because the action failed** — that is the field the branch reads.
- **The mandatory partner functions are derived and shown, but NEVER POSTED** (`NOT_POSTED_NODES`).
  They come from `TKUPA`/`T077K` → `TPAER` — *the same customizing S/4's own determination procedure
  reads* — so creating the sales area is what makes S/4 create them, and posting them afterwards was
  a race that produced `Customer 331: Partner role SP already exists (only provided once)` and a
  rework. **Two fixes were tried and removed**: reading the rows back and posting an update, then
  re-reading and retrying after a failed create. Both foundered on the same thing — **the two sides
  do not spell the function the same way.** The derivation proposes `AG/RE/RG/WE`, S/4 answers about
  `SP/BP/PY/SH`: the same four functions, German against English. Any match between them is a guess,
  and none of it was needed to write a row nobody needed written. They are still derived, proposed
  and staged — a requester seeing which functions the account group implies is the whole value.
  **Accepted consequence:** a partner function added BY HAND is skipped too; nothing distinguishes it
  from a derived row once staged (both are `action: 'C'`). Narrowing it means re-reading `TKUPA` at
  post time, worth doing only when somebody needs to add one.
- **The status stays `reworkRequired` either way.** Something in the request did not land and a human
  has to finish it; the retry path is built for exactly that (`isCreate` flips to false once the
  number is known, and a created child row is flipped to `action: 'U'`).

## Address-owned children (Email/Phone/Fax/Website/Tax Number)

Added 2026-09-04, asked for: the same "open a record, add more detail" pattern Customer/Supplier's
`childSections` already had, but for `Addresses` — and the one child relationship in this schema that
does not fit the existing one-relation-value-per-section model at all.

**Every other child node relates via ONE value, resolved once and applied to every row** — a request
has exactly one Customer number and one Supplier number, so `RELATION_FIELDS` + `awaitRelationNumber`
can resolve it once per post and stamp it onto every `CustomerCompany`/`CustomerTaxGrouping`/etc. row.
A BP can have **several** addresses, each getting its **own**, **different** `AddressID` from S/4 —
and a brand new address has none at all until the moment it is actually created. So
`StagedAddressEmails`/`PhoneNumbers`/`FaxNumbers`/`HomePageURLs`/`TaxNumbers` each carry **two** things
that answer two different questions: an `address : Association to StagedAddresses` (which staged
address this row belongs to, resolvable before either has a real S/4 key) and a plain `AddressID`
column (what `postToS4`'s generic per-section loop actually reads to address the S/4 record — it
never expands an association).

- **`writeStagedNodes` resolves `address` from the client's own `__addressKey`/`__rowKey`, in the
  same write.** Addresses is written first (`PAYLOAD_NODES`' declaration order), each row's own `ID`
  assigned up front via `cds.utils.uuid()` rather than read back after insert, and mapped by
  `__rowKey` (the client's stand-in for a real AddressID it does not have yet). Every address-owned
  child section immediately after resolves `address_ID` from its own `__addressKey` against that map.
  `ADDRESS_CHILD_NODES` names the five sections this applies to.
- **`postToS4` backfills the REAL AddressID the same way, per row, not once for the whole section.**
  `saveBusinessPartnerEntity`'s create response — always returned, previously always discarded —is
  captured for `Addresses` specifically and recorded in `addressIdByStagedRow`, keyed by the staged
  row's own id (create or update: an update's row already carries a real `AddressID` from the read it
  was staged against). Each address-owned child then resolves its own `AddressID` from
  `addressIdByStagedRow[data.address_ID]` instead of `RELATION_FIELDS`'s uniform resolution, and
  `data.BusinessPartner` is set unconditionally the same way a role node's is — `sanitizeEntityPayload`
  drops it again for the four remote entities (Email/Phone/Fax/Website) that have no such field;
  `AddressTaxNumbers` (`A_BusPartAddrDepdntTaxNmbr`) actually needs it, unlike the other four, which
  nest under `A_BusinessPartnerAddress` itself (composite `parentKeyFields: ['BusinessPartner',
  'AddressID']` in `MAINTENANCE_ENTITIES`) rather than under `A_BusinessPartner`.
- **`cleanStagedRow` is the one place `__rowKey`/`__addressKey` reach the client** — `getRequestPayload`
  and `loadStagedPayload` both call it now instead of inlining the same destructuring. Every other
  section still has its own database id stripped, same as always; only `Addresses` (`__rowKey = ID`)
  and its five children (`__addressKey = address_ID`) get this, because that id is the only thing that
  can correlate a still-unsaved address to its children before an approval ever runs.
- **A candidate never resolves silently to nothing** — if an address-owned child's `address_ID` does
  not resolve to an entry in `addressIdByStagedRow`, `postToS4` throws (*"its own address was not
  created in this run"*) rather than posting a child with no `AddressID` at all, which S/4 would
  refuse anyway but with a far less useful message.
- **`node-required.js` must know `AddressID` is injected too** (fixed 2026-09-04, reported live the
  same day the feature shipped: Check refused a brand new address's own email with *"AddressEmails:
  enter required field(s) AddressID"* — exactly the row this feature exists to accept).
  `injectedFields` already excluded the one relation field `postToS4` resolves and stamps itself
  (`Customer`/`Supplier`/`BusinessPartner`) from the required-field check, on the reasoning that a
  field the post supplies can never be legitimately missing from staging. `AddressID` is exactly that
  kind of field for the five address-owned sections — resolved and injected **per row** instead of
  once per section — but `ADDRESS_CHILD_NODES` was never passed into `createNodeRequiredStages`, so
  the check still demanded it as if it were ordinary staged data. Fixed by threading
  `addressChildNodes` through the same way `relationFields`/`roleNodes` already are.

## Security gaps, known and open

- **Nothing authorises the staged payload.** `getRequestPayload` has no check in front of it and
  `@readonly ChangeRequests` is readable by any authenticated user through `$expand`. Restricting it to
  steward-or-requester today would break every approval, because an approver is neither. Closing this
  needs the role model.
- **`completeRequest` has no scope restriction** and writes to S/4 — any authenticated user can force a
  post. Restrict it to the SBPA technical user before this goes anywhere real.
