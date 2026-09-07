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
- **The new `AddressID` is DERIVED from a re-read, not taken on trust from the POST response**
  (2026-09-07, reported live: BP 639 was created and the post then failed *"Cannot post
  AddressEmails: its own address was not created in this run."*). The root create goes through
  `s4.run(INSERT)` and demonstrably answers with its own `BusinessPartner`, but an address has to be
  POSTed through the `to_BusinessPartnerAddress` navigation (SAP KBA 3109298, for the XXDEFAULT
  usage) — and that raw `s4.send` response is a shape **nothing in this app had ever read a field
  out of**. The recording added with this feature was written assuming it carried the key, and the
  earlier check-time refusals meant no create ever got far enough to find out.
  `createBusinessPartnerAddress` now captures the partner's address ids **before** the POST and
  takes the one that is there afterwards and was not there before. **A derivation, not a
  heuristic** — exactly one id can be new — and paid for only when the response gave nothing.
  Anything other than exactly one new id **picks none**: attaching an email to the wrong address is
  worse than the caller reporting it has no `AddressID` to attach one to.
  `normalizeRemoteRows` is `normalizeRemoteResult`'s every-row counterpart and exists because the
  on-premise V2 proxy answers a one-row read with a **bare object**, which an `Array.isArray` check
  reads as no rows at all — that alone would have made every second address claim the standard usage.
- **One address means one candidate: an unlinked child is LINKED to it, not refused** (2026-09-07,
  reported twice — BP 639 then BP 642). The client key is the weak link in the chain, and every way
  of losing it ends in `writeStagedNodes` with no `address_ID`. The `[stage]` warning answered it:
  `__addressKey=(absent)` on **all five** child sections, with exactly one known address key — and
  that key was a **UUID**, which `generateRowKey()` (`Date.now().toString(36)` plus random) cannot
  produce and only `cleanStagedRow`'s `__rowKey = ID` can. So the rows came from a staged **reload**,
  where a child is handed back `__addressKey = address_ID || null`: **once a request has staged an
  unlinked child, null is all it can ever offer again**, so resubmitting could never recover a link
  the first submit lost. That self-perpetuation is what made this worth fixing at the staging end
  rather than only in the client. `stagedAddressIds` (every staged address row id, keyed or not —
  `addressIdByRowKey` cannot count, since an unkeyed row is absent from it) drives it, and the
  stamped key is still tried first. **Deliberately NOT extended to several addresses**: with two,
  picking one would attach an email to an address nobody chose, and staging the wrong link is worse
  than refusing to post — that case keeps the warning and stays unlinked.
- **`postToS4` also falls back to the `AddressID` the row already carries.** A child read back FROM
  S/4 has the real key in its own staged column, so it needs no link at all — which is what makes a
  change or a delete of an existing email work even on a request whose link was never made. The
  resolved link still wins where there is one: on a create that is the id S/4 has just assigned, and
  the staged column is blank.
- **Two client-side holes closed with it, both latent.** `_renderAll` used
  `.forEach(this._renderSection.bind(this))`, and `forEach` passes `(element, index, array)` — so the
  **index** landed in `parentRow`, where a row object belongs. Harmless only because no
  address-owned child has a container of its own on the object page, so `addressRowKey(3)` answered
  null and the section drew unscoped. And `_onCreateRoute` stamped `__rowKey` on a draft's addresses
  but never `__addressKey` on its address-owned children — worse than unlinked at submit, because
  `_renderSection` scopes an address's child table BY `__addressKey`, so such a row was **invisible
  in the very dialog it would have to be fixed in**. Stamped in a second pass, since the draft lists
  its sections in any order and the address may not have had its key yet.
- **The two ways a child cannot find its address are different problems, and the message says
  which.** No `address_ID` at all means the LINK was never made (`writeStagedNodes` had no
  `__addressKey`, or none matching an Addresses `__rowKey`) — a client/staging question. An
  `address_ID` that resolves to nothing means the link is fine and the ADDRESS yielded no
  `AddressID` sections earlier. One message for both left a live failure with nothing to act on.
  `writeStagedNodes` also warns (`[stage]`) the moment a child ends up unlinked, rather than only at
  the post — by then the request is approved and a partner may already exist. It **warns, never
  throws**: a submit refused over a linkage detail the requester cannot see would strand them, and
  `postToS4` already refuses to post an unlinked child.
- **A candidate never resolves silently to nothing** — if an address-owned child's `address_ID` does
  not resolve to an entry in `addressIdByStagedRow`, `postToS4` throws (*"its own address was not
  created in this run"*) rather than posting a child with no `AddressID` at all, which S/4 would
  refuse anyway but with a far less useful message.
- **`AddressID` is an INJECTED field for these five, at check time.** It cannot exist while the
  request is being filled in — a brand new address has no S/4 key — so `node-required.js`'s
  `injectedFields` adds `AddressID` (and `BusinessPartner`) for every section in
  `addressChildNodes`, the same way it already skipped a relation number resolved at post time.
  Without it, Check and submit refused **every** new email, phone, fax, website and address tax
  number (2026-09-04) for a field the requester cannot supply and the post never reads from
  staging. **Scoped to the five owned sections, not to the field name**: `CustomerAddressInfo`,
  `CustomerAddressExtIdentifier`, `CustomerSalesAreaAddressInfo` and
  `CustomerUnloadingPointAddressInfo` also require an `AddressID`, and theirs is a real
  requirement the requester picks — nothing backfills those.
- **A parent key is addressed from the RAW row, not from the sanitized payload** (2026-09-07).
  `sanitizeEntityPayload` keeps only what is an element of the node's OWN entity, and
  `A_AddressEmailAddress`/`A_AddressPhoneNumber`/`A_AddressFaxNumber`/`A_AddressHomePageURL` key on
  `AddressID/Person/OrdinalNumber` and have **no `BusinessPartner` element at all** — while the
  parent they are POSTed under, `A_BusinessPartnerAddress`, keys on `BusinessPartner` AND
  `AddressID`. So the sanitize dropped the one value that could address the parent, and the create
  asked for it back: first `AddressEmails: enter required field(s) BusinessPartner.`, and past that
  `Enter a BusinessPartner number.` — after every check had passed. `parentKeyContext` now recovers
  the parent keys from the raw row and `saveBusinessPartnerEntity` validates and addresses against
  `{...parentKeyContext, ...payload}`; the POST **body** is still `payload` alone, so no node is
  sent a field its own entity has not got. `AddressTaxNumbers` was the only one of the five that
  ever worked, because `A_BusPartAddrDepdntTaxNmbr` does carry `BusinessPartner`.
  **Same defect, different node:** `A_BusinessPartnerContact` spells the partner
  `BusinessPartnerCompany` and has no `BusinessPartner` element either, and `postToS4` stamped
  `data.BusinessPartner` for a **role node only** — so contacts never had one to drop. That stamp
  is now unconditional: no maintenance node has both a relation field other than `BusinessPartner`
  and a `BusinessPartner` element of its own (audited against the imported EDMX), so it either sets
  what the relation field already set or sets what the sanitize drops.
- **A website row with no validity date cannot be ADDRESSED, and is refused rather than sent**
  (2026-09-07, after BP 562: *"Malformed URI literal syntax"*). `A_AddressHomePageURL` is the one
  address child whose key is not all strings — it adds `ValidityStartDate` (`Edm.DateTime`) and
  `IsDefaultURLAddress` (`Edm.Boolean`), so it is the only one that can hit this. The URL we built
  was
  `A_AddressHomePageURL(AddressID='1205',Person='',OrdinalNumber='1',ValidityStartDate=datetime'0000-12-30T00:00:00',IsDefaultURLAddress=true)`
  — the **form is right** (`Person=''`, a bare `true`, a `datetime'…'` literal); the value is not.
  `Edm.DateTime` starts at `0001-01-01`, and **`0000-12-30` is how CAP renders an SAP INITIAL
  date** — so a website row carrying no validity date reads back as one and cannot go into a key.
  `usableDateTimeKey` now refuses it and `resolveAddressChildKeys` throws naming the field, because
  a stated refusal beats a malformed request. **Deliberately NOT substituted** with `0001-01-01`
  or today: a key is an ADDRESS, and a different date addresses a different row, or none.
  **Only reachable on a change or a delete** — a newly added row is a POST through the navigation
  and has no key predicate at all, which is why every earlier run (all adds) never saw it.
  **The row is born that way, and that is the half worth fixing.** Read back through the facade
  (address 1205, 2026-09-07) BOTH website rows carry `"ValidityStartDate": "0000-12-30"` — so S/4's
  own serialiser emits a value its own URI parser rejects, and such a row can be neither updated nor
  deleted (delete builds the same predicate). They got that way because this app POSTs a website
  without a `ValidityStartDate`: it is part of the key, it is not on the screen, and S/4 then stores
  its initial date. `MAINTENANCE_ENTITIES.AddressHomePageURLs.createDefaults` now sends **today's
  date** on create — what the BP transaction itself defaults — so every row this app creates from
  now on stays addressable. `createDefaultsFor` applies a default only where the payload has
  nothing, so a supplied value always wins, and it is a FUNCTION so the date is the request's.
  **Rows created before this stay stuck** — unaddressable by any literal, so they cannot be repaired
  or removed through this API at all; that needs S/4 itself.
  **Still open:** whether S/4 accepts `ValidityStartDate` on the create POST at all (untested), and
  the deeper oddity that `IsDefaultURLAddress` is both a KEY part and an editable field — so ticking
  the default flag changes the key, which an update-by-key cannot express even with a good date.
- **`AddressTaxNumbers` is READ-ONLY: S/4 cannot create one through this API at all** (2026-09-07,
  reported live: BP 638 created, then *"Operation is not supported"*). The gateway answered the POST
  to `/A_BusinessPartner('638')/to_BusPartAddrDepdntTaxNmbr` with `/IWBEP/CM_MGW_RT/027 Operation
  'CREATE_ENTITY' not supported for entity type 'A_BusPartAddrDepdntTaxNmbrType'` — the entity set
  has **no create implementation**. **Not a wrong URL:** that navigation hangs off
  `A_BusinessPartner` and is the only route to this entity anywhere in the model —
  `A_BusinessPartnerAddress` has `to_EmailAddress`/`to_PhoneNumber`/`to_FaxNumber`/`to_URLAddress`
  and **no tax-number navigation**, so there is no address-parented route and no deep-insert route
  either. **And not visible in the checked-in model:** the entity set carries no
  `sap:creatable="false"`, so the copy reads as creatable — the same *"the imported models are
  copies and go stale silently"* trap as the `excluding {}` lists (`architecture.md`). Only the live
  system says otherwise, so **do not "fix" the config back from the metadata**.
  Closed at three levels: `creatable: false` + `notCreatableReason` on the entity (the post's
  refusal now says why instead of naming a role that has nothing to do with it), `creatable: false`
  + an `emptyText` in the generated screen metadata so the Add button is gone, and a new
  `node_not_creatable` validation so a row staged before this — or any direct service call — is
  refused at CHECK time rather than after an approver has spent their time and a partner exists.
  `node_required_fields` could never have caught it: it deliberately skips a non-creatable section,
  having no create rules to check. **Reading and deleting existing rows is untouched** — nothing has
  exercised DELETE on this entity, so guessing it away would remove a path that may work.
  **The other four are unaffected and do create.**
- **`OrdinalNumber` IS staged for the four non-tax children; the rest of their key is read back.**
  Their S/4 key is `AddressID/Person/OrdinalNumber` (`A_AddressHomePageURL` adds
  `ValidityStartDate` and `IsDefaultURLAddress`, the latter already staged). `StagedAddress*`
  declared none of it beyond `AddressID`, and `stageable` drops any field the staging entity does
  not declare — so the keys the read HAD brought back from S/4 were thrown away at staging time,
  and `postToS4`'s `U`/`D` branch hit `sanitizeEntityKeys` with *"Missing key field(s): Person,
  OrdinalNumber."* (2026-09-07). Live, not latent: the screen offers both paths (`deletable: true`,
  `EmailAddress` `updatable: true`). Adding a new child was never affected.
  **Only the ordinal is carried, and the split is the point.** An ordinal is an IDENTITY, not a
  derivable technical value: once a requester edits `EmailAddress` from `a@x` to `b@x`, staging
  holds `b@x` and nothing left on the row says which of the address's several emails it used to
  be — S/4 answers with all of them and no way to align. So it is staged, exactly the way
  `StagedAddresses.AddressID` and `StagedContacts.RelationshipNumber` are: S/4-assigned, blank on
  create, and absent from the generated screen metadata so no requester is asked for it.
  `Person` and `ValidityStartDate` are NOT staged, because they CAN be recovered — once the ordinal
  identifies the row, `resolveAddressChildKeys` reads them back on `AddressID` + `OrdinalNumber`,
  one read per changed or deleted row, and only when `action !== 'C'`.
  **A BLANK `Person` is the real key value, not a missing one** (2026-09-07, reported live:
  *"S/4 returned no Person for address 1367 row 1"* on the change after the create finally
  succeeded). `Person` is `ADR6`/`ADRT-PERSNUMBER` — the CONTACT PERSON a row hangs off — and it is
  blank for an **address-level** entry, which every row of these five is, on an organisation or a
  person alike. So `resolveAddressChildKeys` checks the field is PRESENT, not non-empty, and
  normalises `null` to `''`; and `sanitizeEntityKeys` takes a `blankable` list, fed from the new
  `blankableKeyFields: ['Person']` on the four. **Staging `Person` would not have helped** — the
  value being carried is blank either way, which is why the earlier "read it back" split was right
  for the wrong reason. `sanitizeEntityKeys` stays strict everywhere else: the emptiness test is
  what it was added for (every update once failed on *"Missing key field(s)"* because the keys
  travelled empty), so blank passes only where an entity declares it, an ABSENT key is still
  missing, and a blank the entity does not name is still refused.
  **It never returns a partial key.** No ordinal, a row S/4 no longer has, two rows sharing an
  ordinal, or a key part the read came back empty for all throw — a key missing a part addresses a
  DIFFERENT row than the requester picked, so an update would overwrite and a delete would remove
  something nobody chose. Same reasoning as *"a candidate never resolves silently to nothing"*
  above. A request staged before the column existed carries no ordinal and has to be raised again;
  the error says so.
  `AddressTaxNumbers` needs none of this: its key is `BusinessPartner/AddressID/BPTaxType`, all
  three staged or injected already.
- **`addressIdByStagedRow` is SEEDED from every staged address before the post loop runs,
  untouched rows included.** On a change request the address a new email belongs to usually needs
  no change itself, so its own row is `N` — and the loop's `if (!action || action === UNTOUCHED)
  continue` skips it *before* the recording, which then threw *"its own address was not created in
  this run"* for a child of a perfectly good existing address (2026-09-04). An untouched row
  already carries the real `AddressID` it was staged with, so seeding costs no S/4 round trip. A
  create's row has none yet and is not seeded; the loop still records what S/4 assigns. The throw
  now only fires for what it was written for: a child whose brand new address genuinely failed.
- **`node-required.js` must know `AddressID` is injected too, and `BusinessPartner` with it.**
  `injectedFields` already excluded the one relation field `postToS4` resolves and stamps itself
  (`Customer`/`Supplier`/`BusinessPartner`), on the reasoning that a field the post supplies can
  never be legitimately missing from staging. `ADDRESS_CHILD_NODES` was simply never passed into
  `createNodeRequiredStages`, so the check demanded both as if they were ordinary staged data;
  fixed by threading `addressChildNodes` through the same way `relationFields`/`roleNodes` are.

## Security gaps, known and open

- **Nothing authorises the staged payload.** `getRequestPayload` has no check in front of it and
  `@readonly ChangeRequests` is readable by any authenticated user through `$expand`. Restricting it to
  steward-or-requester today would break every approval, because an approver is neither. Closing this
  needs the role model.
- **`completeRequest` has no scope restriction** and writes to S/4 — any authenticated user can force a
  post. Restrict it to the SBPA technical user before this goes anywhere real.
