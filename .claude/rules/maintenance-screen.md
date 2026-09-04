# The shared maintenance screen (`app/reuse`)

<!-- paths: app/reuse/**, app/businesspartner/webapp/reuse/**, app/bptask/webapp/reuse/** -->

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
each consumer's `webapp/reuse` (gitignored, never edited) and each manifest maps `"resourceRoots":
{ "mdm.md.businesspartner.reuse": "./reuse" }`, so module names are identical in both apps and there is
one copy in git. **A deployed UI5 library is the textbook answer and the wrong one here** — it is
addressed by a version-stamped URL, and a stale version reference is exactly what 404'd the task UI.
`app/reuse` is still shaped as a real library project so that can be revisited; nothing loads
`library.js` today.

- **`npm run generate:metadata` writes into the library.** Both consumers pick it up on their next build.
- **Every build runs `sync:reuse` first** — editing `webapp/reuse` directly is pointless.
- **The controller attaches only to routes its host declares** — the partner app routes all six, the
  task app only approve, rework and datasteward. `onInit` skips a missing route rather than throwing.
- `ui5 build preload` bundles `webapp/reuse/**` under the consuming app's own namespace, which is not
  the name the runtime asks for, so shared modules load as individual files. Works, not free.

## Highlighting what changed

A changed value is **light red**, an added one **light orange**, and a collapsible three-column summary
leads the screen. `state.trackChanges` decides whether a baseline is meaningful:

- **A plain new create has none** — `_onCreateRoute` leaves it `false`.
- **Editing a live BP** compares against the values as read from S/4 (cloned right after the read).
- **A staged request** tracks changes everywhere **except** a create-type draft reopened by its own
  requester: `state.trackChanges = state.requestType === "change" || mode !== "edit"`.
- **A change-type request is judged against S/4's own current values, re-read live** —
  `_loadChangeBaseline` → `_fetchLiveSnapshotForDiff`. Staging holds the *merged* result, so cloning it
  would compare a record against itself. Best-effort: a failed re-read leaves the as-loaded snapshot,
  logged, never shown.
- **A create-type request's baseline is server-persisted** in `ChangeRequests.baselineDataJson`, written
  by `submitRequest` **only**. **Nothing after the first successful submit ever writes this column
  again** — not `resubmitRequest`, not `decideDataStewardReview`, not `decideRequest`'s reject branch,
  not `claimRework`. That is deliberate and load-bearing: a steward's edits stay visible to the approver,
  and a requester reworking sees exactly what the steward changed. A client-side snapshot cannot do this
  — the next screen's own load re-snapshots against itself and the colouring vanishes.

**Rows are matched by CONTENT, never by `record.__state`.** That flag is staged as the DB `action`
column and **survives every reload**, so a row the original requester added still comes back `"new"` for
the next person. `matchSectionRows(records, baselineRecords, fieldNames)` runs two passes:

1. **Exact matches consumed first** (every field equal, either direction), so an untouched row is never
   coloured because some other row moved, and two identical rows never match one baseline row.
2. **The rest paired off by BEST MATCH** — `sharedFieldCount` scores every remaining pair and the highest
   is assigned first, greedily. A row is a CHANGE for as long as any baseline rows remain and only
   becomes an ADDITION once the section genuinely has more rows than the baseline. Array order was worse
   than imprecise: two rows can each fail the exact pass without either being a real edit, and positional
   pairing then shuffles them against each other, reporting a change in every field nobody touched.

Still not exact without a stable row key — staging has a cuid, but `getRequestPayload` strips it before
it reaches the client. Undercounting additions is the safe direction: it never invents a change nobody
made.

**Deleted rows.** Whatever is unconsumed is a row somebody deleted; it rides along as `results.deleted`,
a property on the returned array so every existing caller keeps working. There is no row left to colour,
so the summary panel is the only place that can say so: one line per **populated** field (new value
`"(removed)"`, `kind: "removed"`), or one "Row removed" line for a row never filled in. **The header
counts removals separately.** `ObjectStatus`'s existing ternary needed no change.

- **Root fields are diffed value by value** — `fieldChangeKind`: nothing when equal, `"added"` when the
  baseline was empty, `"changed"` otherwise, **including a field that was cleared**.
  `BusinessPartnerFullName` is excluded everywhere.
- **The colour lives on the control, not in a binding** — the root form is built imperatively, so a
  field's background is fixed when its `VBox` wrapper is constructed. `_onFieldCommitted` re-renders the
  whole root form after every commit (`change`, not `liveChange`).
- **A CHANGED row colours only the cells that differ, not the whole row** — colouring the whole
  `ColumnListItem` for one changed field is indistinguishable from the bug where every field was wrongly
  reported. There is deliberately no `mdmChangedRow` class. **An ADDED row is still tinted whole.**
- **A section's `childSections` (Customer/Supplier's tax/company/sales-area blocks) render inside the
  parent record's Details dialog as collapsible `sap.m.Panel`s** (`_openRecordDialog`), one per child,
  reading and writing the same `state.sections` arrays a top-level section would. **Collapsed by
  default, expanded only when that child section already has a row** (asked for 2026-09-04 — a create
  with several empty child sections read as a wall of blocks nobody needed yet) — `hasData` is checked
  once, at open time, the same way the dialog's own change-baseline is.
- **Addresses' own `childSections` (Email/Phone/Fax/Website/Tax Number, added 2026-09-04) are scoped
  to the ONE address record they were opened from — Customer/Supplier's never needed this, because a
  request has only one Customer and one Supplier.** `state.sections.AddressEmails` etc. still hold
  every address's rows flat, the same way any section stores its own; `_renderSection`'s optional
  `parentRow` argument is what narrows the table, the Add button, and every row action back down to
  one address, via `__addressKey` (`addressRowKey(parentRow)` — a live BP's real `AddressID`, or a
  staged/brand new row's `__rowKey` until one exists). **Every index stays a TRUE index into the
  unfiltered array** (`trueIndices`, computed once) — `_openExistingRecord`/`_confirmDeleteRecord`
  still address `state.sections[section.id][index]` directly and never had to change, and `rowMatches`
  is still computed over every row of the section so a true index always finds its own baseline match.
  `parentRow` threads through `_openNewRecord` → `_openRecordDialog` → its own Apply button's
  re-render, so a child added or edited from inside a nested dialog re-renders scoped to the same
  address it was opened from, not the whole flat list. Absent for every other call site — a plain
  Customer/Supplier child, or any top-level section — where `scopeKey` is `null` and behaviour is
  unchanged from before this existed.
- **A brand new Addresses row needs a stable identifier before any child can be linked to it, and
  before it has a real `AddressID`.** `generateRowKey()` (a short random string, not a UUID library -
  nothing here needs cryptographic uniqueness, only uniqueness within one request) stamps `__rowKey`
  onto a new Addresses row from every path that can create one — `_openNewRecord`, the Business
  Partner Assistant's applied draft (`_onCreateRoute`), and a live BP's own addresses on load (where
  `__rowKey` is simply set to the real `AddressID`, since one already exists). A brand new
  Email/Phone/etc. row is stamped with `__addressKey` matching its parent's key the same way, in
  `_openNewRecord`. Neither `__`-prefixed field is ever sent to S/4 or shown on screen — `stageable`
  drops both server-side exactly like `__state`, and `cleanStagedRow` is what puts them back on the
  way out for `Addresses` and its five children only. See "Address-owned children" in `staging.md`.
- **A live BP's address-owned children cannot be read the way every other section is** — their own
  remote entity carries no `BusinessPartner` field at all, only `AddressID` (confirmed against the
  CSN), so `_loadBusinessPartner` reads each of the five sections once **per address** rather than
  once for the whole BP, merging the results into the same flat `state.sections.AddressEmails` etc.
  every other reader expects, each row stamped with `__addressKey = address.AddressID`. A section that
  fails for one specific address is named in the warning banner the same way any other section's
  read failure is, address number included.
- **The Add/Edit dialog gets a baseline too** — `_openExistingRecord` resolves the row through
  `_rowBaseline` (the same `matchSectionRows` call `_renderSection` uses). Computed once, when the dialog
  opens — it does not track edits live.
- **A value picked from the F4 help must be committed explicitly.** `sap.m.SelectDialog`'s `confirm` is
  not the `Input`'s `change` event, so `_onFieldCommitted` never ran for a chosen value.
- **The summary panel is a real four-column table** (Field / Previous Value / New Value / Why),
  collapsible, with a count in the header. The colour sits on the **New Value** cell.
  `_refreshChangeSummary` is the one place root and section diffs become rows.
- **The Why column names the SOURCE of a value**, using the proposal dialog's own convention.
  `state.proposalProvenance` is written by `_recordProvenance` from all three of `_applyProposals`' write
  points. `_provenanceFor` returns the stored reason **only while the field still carries exactly the
  value the proposal wrote** — anything else is `"User change/input"`. Nothing has to remember to clear
  an entry, because a further edit stops matching on its own. It is **never sent anywhere** — no staging
  column, no `DataJson` key.
