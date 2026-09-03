# The MDM Configuration Panel tile and the rule tables

<!-- paths: app/mdmrules/**, srv/duplicate-config-service.*, srv/checks/rule-engine.js, srv/checks/rule-store.js, srv/checks/payload-fields.js, srv/checks/value-lists.js, srv/checks/data-scan.js, db/quality-rules.cds, db/duplicate-rules.cds -->

`webapp/ext/view/MDMRuleHub.view.xml` is the landing page: five tiles — Duplicate Check Rules,
Validation Rules, Field Properties, Derivation Rules, Workflow Agent Determination.

**Renamed on the screen only.** Every technical id is unchanged: `app/mdmrules`, `sap.app.id`
`mdm.md.mdmrules.manage`, the `MDMRules-manage` inbound, the `WorkflowRules` entity, the
`WorkflowRuleList` route, the service path `/service/duplicateconfig`.

**It is a second HTML5 app, not a second inbound. SAP Build Work Zone, standard edition exposes only
the FIRST `crossNavigation.inbounds` entry per `sap.app.id`.** Extra inbounds are dropped silently and
never reach the Content Explorer; SAP confirmed this as unsupported. Do not reintroduce a second
inbound, and do not read a missing tile as a deploy problem. A **local copy** in Content Manager was
tried, produced a tile that would not load, and stops reflecting later descriptor changes.

So: unique `sap.app.id` per app, **shared `sap.cloud.service`** (`mdm.md.businesspartner`) so no new
destination/app-host/XSUAA entry is needed, each app's own `xs-app.json` reusing the
`mdm-businesspartner-srv-api` destination, and **one** `com.sap.application.content` module at `path: .`
(two content modules pointed at one app-host each replace the other's content).

**`tools/package-html5.js` does the zipping, and that is not a style choice.** The generator's pattern
produced a **22-byte** `data.zip` here — deploying that would have shipped empty content and **deleted
both apps from the HTML5 repository**. The script refuses to emit a zip under 1KB. Verify before any
deploy: `unzip -l mta_archives/*.mtar | grep -i zip` must show app zips of real size.

The hub is the app root (route pattern `""`) and `Component.js` calls `getRouter().initialize()` itself
— no Fiori Elements AppComponent. Back from the hub is a cross-app intent to `BusinessPartner-manage`.

**Adding the app does not create the tile.** After deploying: refresh the HTML5 Apps content provider in
Channel Manager, add the app from the **Content Explorer**, assign it to a group, a catalog and a role,
and the role to the site.

## Who may open it: `Admin`, not `DataSteward`

Changed 2026-09-03, asked for. `DuplicateConfigService` is `@requires: 'Admin'` and the hub gates its
read-only hint and the AI switch on `perm>/isAdmin`; `xs-security.json` declares the `$XSAPPNAME.Admin`
scope and an `Admin` role template ("MDMLIGHT - Administrator") that grants it.

**The `DataSteward` role template is deliberately untouched and grants none of this.** It is what
`srv/wf/data-stewards.js` resolves into the workflow's data steward step, and reviewing a request is a
different job from maintaining the controls that judge it — someone who does the first should not get
write access to the second by carrying one role collection. `isDataSteward` is still reported by
`currentUserPermissions` for that step; only the panel moved.

**A scope no role template references can be granted to nobody**, so the two halves are pinned together
by a test. The BTP side is manual and does not travel in the MTA: add the deployed `Admin` role to the
role collection, then assign the collection to users — and separately give that collection the Work Zone
site role, or the tile stays invisible to people who now have the scope.

## The rule tables

`db/quality-rules.cds` (`ValidationRules`, `DerivationRules`), `db/duplicate-rules.cds`
(`DuplicateRules`) and `db/workflow-rules.cds` (`WorkflowRules`) share a BRF+-style decision-table shape,
all exposed by `DuplicateConfigService`. Read a row left to right as one sentence:

- Validation — *where `Addresses.Country` = BE, `General.Language` must be `=` NL*
- Derivation — *where `Addresses.Country` = BE, fill `General.Language` with NL* (and propose NL over a
  value that already says something else — the fill branch no longer skips a filled field)
- Workflow — *a **create** request whose `Addresses.Country` is BE is **approved** by these people*

**Fields are payload fields, not duplicate-catalog fields.** `payload-fields.js` is a second, different
catalog: `duplicate-fields.js` describes bags of *normalised* values for comparing two partners, while a
rule reads and writes the request payload with its real values. It is **generated from the staging
model**, never listed — add a column to `db/staging.cds` and the value help has it. Names are qualified
and always dotted. `PAYLOAD_NODES` is the single source of truth for section ids, and `NODES` in
`change-request-service.js` is derived from it.

**The Value column means two things and nothing else says which.** A value resolving to a qualified
catalog field is a **reference**; anything else is a literal — unambiguous because catalog names are
always dotted and a literal never can be. The derivation page's "Copied from …" hint is the only
feedback that a reference was understood as one; do not drop it. A same-section reference reads **the
same row**.

Semantics worth not "simplifying":

- **An empty field does not fail a comparison** — validations run before derivations, so a rule failing
  on an empty field would block the derivation about to fill it. `notEmpty`/`empty` are the exceptions.
- **Condition scoping is per row on the rule's own section.** A condition on any *other* section is a
  statement about the partner and holds when any row matches. (Workflow rules target no section.)
- **A rule the engine cannot evaluate blocks**, like a validation that throws.
- **Severity is a column** on validations — without it every validation would block.
- **An empty table contributes nothing and does not fall back to defaults.** The duplicate table is the
  exception: it falls back, because an empty table would switch the control off.

`rule-store.js` holds rows in memory (60s TTL, dropped on any write) and `createConfiguredStages` builds
**one stage per kind**, not per rule — the pipeline blocks on the first error a validation stage
reports, and a table of twenty rules has to report all twenty.

**The field picker is a dialog, not a ComboBox.** The catalog is several hundred fields and
`sap.m.ComboBox` filters on the **start** of an item's text. The dialog searches with `contains` over
the qualified code as well as the label, and **the qualified code is what is stored**. **Reset the
filter when the dialog OPENS, never when it closes, and read the selection off its binding context** —
resetting a JSONModel list binding re-templates the rows.

**Multiple values per condition were built and withdrawn** after three deployed attempts failed
(`MultiInput` tokens written with `context.setProperty` never reached the server; a hidden bound `Input`
fixed saving and broke typing; `removeAllTokens` reported every token as removed, which **blanked every
stored condition value on page open**). The lesson: **a hand-managed aggregation alongside a bound
column is the wrong shape** — whatever comes next must make the binding the only writer. What survives:
`value-lists.js` as a READ path (still parses `BE|NL`), and the stuck plural names
`WorkflowRules.conditionValues`. **`WorkflowRules.approvers` holds one approver; several approvers are
several rows.**

Still open: a custom message per validation row; rules for object types other than the BP — when MM
arrives, **copy the tables** rather than adding an object-type column.

## Condition slots and shared page mechanics

**Five fixed condition slots per rule, and the PAGE decides how many are drawn.** A genuinely unbounded
count needs a composition, which was built, deployed toward and abandoned twice — **do not try it a
third time.** WorkflowRules' value columns are plural, the other three singular — a stuck naming
difference; each `CONDITION_PAIRS` names its own.

- **"Add Condition" is table-wide, not per row** — it raises `view>/conditions`. Nothing is written.
  The ceiling comes from the service (`conditionSlots`) so page and schema cannot disagree.
- **Every slot above the first needs TWO `visible="{= ${view>/conditions} >= N }"` bindings** — its own
  column and the Logic column that leads into it. The cells carry none; `sap.m.Table` drops a cell whose
  column is invisible, and that is the only thing hiding them. Condition 2's pair was missing, so
  Delete Condition took the count to 1, greyed itself out and left the column it had just cleared on
  screen — a ghost holding a slot the engine no longer reads, with `tableWidthFor(1)` sizing the table
  for one condition and no Logic column. `test/quality-rules-page.test.js` counts the pairs on all four
  pages. **Condition 1 is never gated**, because it is never removable.
- **A saved rule reveals its own columns** — `_syncConditionColumns` (on `updateFinished`, from
  `_loadOptions`, after an import) raises the count to the highest slot any row fills and **never
  lowers it**. `_setConditionColumns` is the only writer of `view>/conditions`.
- **`getCurrentContexts()` holds `undefined` for a row that has not arrived**, and a context that has
  can still answer `undefined` from `getObject()`. `_loadOptions` syncs the columns while the row
  `$batch` is still in flight — this threw *"The rule options could not be loaded: Cannot read
  properties of undefined (reading 'getObject')"* on **all four** rule tiles while every options
  function answered **200**. Field Properties was the one tile that worked, because it draws no
  condition columns. It looked like a roles problem and was not. Both `_draftRules` and `_rowsUsingSlot`
  filter unloaded rows out.
- **"Delete Condition" removes the LAST shown slot and CLEARS it** on every row that holds something.
  Hiding alone is not enough — the values stay and the engine goes on matching a condition nobody can
  see. **Condition 1 is never removable.**
- **Discard must re-sync the columns by hand.** `resetChanges` restores properties on contexts that
  are already there — no row is added or removed, so `updateFinished` never fires and
  `_syncConditionColumns` never runs. Discarding a Delete Condition put the values back and left the
  column invisible until Add Condition revealed the slot, values intact. Safe to call directly
  because the sync only ever RAISES the count.
- **The toolbar is the PAGE's, not the table's.** Inside `<Table headerToolbar>` it inherited
  `view>/tableWidth`, so a narrow table ended mid-screen with the buttons stopping there and a column
  drag moved every button with it. It now sits above the `ScrollContainer`.
- **Widths are rem, not percentages** — a hidden column contributes no share of 100%. The table sits in
  a horizontal `ScrollContainer` and `view>/tableWidth` gives it something to overflow with, with
  `.mdmRuleTable { min-width: 100% }` making that width a **floor to overflow past, not the table's
  size**: columns decide whether a scrollbar appears, never how wide the table looks.
  `tableWidthFor` is the arithmetic (24rem per condition, 6 per Logic column of which there is one
  fewer, plus `SELECT_REM = 3`). The tests that added the declared `<Column width>`s up against it were
  removed as layout churn — **check the arithmetic by hand** when you add or resize a column.
  `_applyTableWidth` is the single setter, which is what stops Add Condition undoing a resize.
- **The engine folds LEFT TO RIGHT, one logic per gap** (`foldConditions`). `A OR B AND C` is
  `(A OR B) AND C`; there is no precedence. Zero and one condition behave exactly as before (a lone
  condition is itself, logic bypassed, so NOR cannot invert it). **A blank slot takes its own Logic with
  it** — `readConditions` drops it and carries each surviving condition's own preceding logic.
- **A blank comparator reads as `eq`** (`operatorOf`, like `conditionLogicOf` for a blank Logic) — every
  row stored before the operator column existed meant equality, so nothing was migrated.
  `empty`/`notEmpty` read the **RAW** value via `sectionRows`, never `fieldValues`. `eq` keeps wildcard
  and `|`-multi-value matching; every other operator is OR across the listed values. The duplicate
  engine's bag holds **normalised** values, so its `is empty` means "no value for that field at all".
- **`is empty`/`is not empty` are a COMPLETE condition with no value**, **named** by a shared constant
  (`EMPTINESS_COMPARISONS`), not signalled over the wire — a served `needsValue` flag that failed to
  arrive read as `undefined !== false` and refused a valid rule.
- **Operator labels are symbols.** `symbolOnly` takes everything before the double space `COMPARISONS`
  uses to separate symbol from gloss, returning word-shaped operators whole. The duplicate page's own
  `COMPARISON_TEXT` is a different vocabulary — how two RECORDS are matched — and is untouched.
- **The Value cell's expression binding needs `targetType: 'any'`** — inside an expression binding a
  referenced property is formatted into the bound control property's type unless told otherwise, so
  `${dc>conditionOperator}` on a Boolean `enabled` threw `FormatException` on every row. Applies to any
  expression over the typed `dc` model; the `view>` JSONModel carries no types.
- **Multi-select is `mode="MultiSelect"` and nothing else** — `sap.m.Table` draws the checkbox column
  itself, so no page declares a `<Column>` for it. Delete and Duplicate act in the same `ruleChanges`
  group so one Save writes them together, then `removeSelections(true)`.
- **Column resizing is `ext/util/ColumnResizer.js`**, shared. **What is draggable is the BORDER between
  two columns, never the column itself** — no reordering, no `dragDropConfig`, and a test pins that. The
  drag ends in `Column#setWidth`, not an inline style. Header cell → column is **by id first, by
  position second**. A resize widens the TABLE by the same delta, keeping a `calc(<n>rem ± <n>px)`.
  Field Properties passes no `onResize` — it is 100% wide with no horizontal scroll.
- **Save cannot claim what it did not do.** `hasPendingChanges` answers for one update group, so a
  create that never travelled leaves it false. **That guard had a race**: `submitBatch`'s promise can
  resolve before a freshly created context has flipped out of `isTransient()`. So `onSave` captures
  `_transientRows()` **before** the submit and awaits each row's `context.created()` before asking
  again. Applied to all four rule pages.
- **Duplicate a rule** — `STRIP_ON_COPY` then `binding.create(copy)`. Nothing is saved automatically.

**The controller glue is duplicated across the four pages deliberately** — heavy shared machinery is
extracted (`XlsxCodec`, `ColumnResizer`), per-page wiring reads better beside the page it wires. If a
fifth table ever needs it, extract it then.

## Excel import/export (`ext/util/XlsxCodec.js`)

A real `.xlsx`, hand-rolled with **no new dependency**, mirroring BRF+'s own decision-table up/download.
STORE-only entries sidestep DEFLATE on export; inline strings sidestep `sharedStrings.xml` on write.

- **Reading back must cope with what real Excel saves**: always DEFLATE and always
  `xl/sharedStrings.xml` once re-saved. Decompression uses `DecompressionStream('deflate-raw')`, so
  import is async where export is not.
- **A targeted XML scanner (`matchTags`/`parseAttrs`), not `DOMParser`** — it keeps every read-path
  function runnable outside a browser.
- **The attribute group must be lazy (`[^>]*?`).** Real Excel writes an empty cell as
  `<c r="D3" t="inlineStr" />` and a greedy group swallows the trailing `/`, so the tag reads as OPEN
  and consumes the next cell's content — silently shifting every column after it.
- **`xmlUnescape` is applied at each leaf text node**, separately from attribute values and never inside
  the generic tag scanner.
- **Columns are matched by header LABEL, not position.** `ID` is not a column on any page.
- **Import REPLACES the table wholesale**: delete every row, create one per non-blank file row. No ID
  matching. A header-only file clears the table. **Import never saves by itself.**
- **`isActive` is read tolerantly** (`true`/`1`/`yes`/`x`, and a real `t="b"` cell).
- Each page owns its own `xlsxColumns()` and `_applyImportedXlsx`.
- `test/xlsx-codec.test.js` loads the module by `new Function`-wrapping the AMD factory — **not**
  `vm.createContext`, which creates a separate JS realm and makes `assert.deepEqual` fail on
  structurally identical arrays.

## Check Current Data (`srv/checks/data-scan.js`)

The Validation Rules page's counterpart to the duplicate tile's "Test Against Current BPs": run the
**saved** ruleset against the partners that exist.

- **Knows nothing about S/4** — readers are handed in, so it is testable with plain objects.
- **Runs `runValidationRule`, the engine itself.** A scan judging the data by its own reimplementation
  would be a second answer to the same question.
- **Only the sections the ruleset actually reads are fetched**; `General` arrives with the partner.
- **The customer/supplier tree is read by the number `A_BusinessPartner` itself carries**, never by the
  partner number — CVI does not guarantee they are equal. `scanKeyFieldFor` derives the key column from
  `MAINTENANCE_ENTITIES`, covering all 31 sections without a second hand-kept map.
- **Every column of `A_BusinessPartner`, no projection** — a rule may name any General field.
- **A section that could not be read is NAMED in the report**, never treated as empty.
- **Capped at `MAX_PARTNERS` (2000) and refused above it** rather than answered on a slice.
- **Delegated to `BusinessPartnerService`**, like `testRuleset` — one S/4 connection.

Derivation deliberately gets no such button: it fills empty fields on the request in front of you, and
there is no population-wide verdict to preview.
