# The check pipeline

<!-- paths: srv/checks/**, srv/ai/registry.js, srv/ai/normalise*, srv/checks/pipeline.js -->

**validate → derive → duplicate check**, and the order is the design: data that fails validation cannot
be a duplicate of anything, and data that is merely incomplete may be missing the very fields a
duplicate rule needs. Stages run over the **request payload** (`{ root, sections }`), not a flattened
candidate, so a derivation can name a row and the screen can write it back.

Three behaviours worth not "simplifying" away: a validation that **throws blocks**; a derivation that
throws **only reports**; a duplicate check that could not run is **reported**, never folded into an
empty result.

`VALIDATIONS`/`DERIVATIONS` are empty default registries. Stages are built per request in
`runRequestChecks` (`srv/change-request-service.js`) from `rule-store.js`, `registry-checks.js`,
`cvi-checks.js`, `derivation-checks.js` and `field-properties.js`. **Configured stages come first in
both lists**: validations because they are offline and a failing request should not cost a VIES call;
derivations because **the first stage to claim a field is the only one that speaks for it**.

**Pipeline guarantees:** `createsRow` invents a row only when the section is empty **or** — with a
`rowKey` — when no existing row already carries that key; `runDerivations` applies each entry as it
goes, so a later entry in one stage sees an earlier entry's row.

**The three stages AFTER the derivations run concurrently** (2026-09-03) — `propose` (AI Core),
`checkStandard` (the S/4 dry run) and `checkDuplicates`. None reads another's output and none writes
into the payload it is handed, so their old ordering bought only latency: on the data steward step a
model round trip and an S/4 round trip were charged back to back. **Three separate `.catch`es, not one
`allSettled`** — the three answers to "this did not run" are deliberately different, and a shared
handler would flatten them. Each is wrapped in `Promise.resolve().then(...)` so a stage that throws
*synchronously* still lands in its own fallback rather than escaping `runChecks`. The order the
validations and derivations run in is untouched and is still the design.

## A derivation over a filled field is a PROPOSAL, not a skip

It used to be dropped in silence, leaving the requester a warning and no way to act on it but retyping.
The entry carries **`overwrites: true` and `current`**; the dialog is where the requester keeps their
own value by unticking. Three things hold it together:

- **Proposing what is already there is not a proposal.** `sameValue` (trimmed, exact) drops it — that
  is what stops an accepted value coming back on the next press.
- **One claim per field.** `claimed` in `runDerivations` (a Set of `target|index|field`, added to by the
  created-row branch as well) replaces what "never overwrites" used to do for free: the country default
  must not offer to overwrite what VIES just derived. Stage order decides the winner.
- **`replay` follows `overwrites`**, so a `system` entry reaches `systemDerived` over a typed value. A
  **non**-system derivation is still not replayed over a typed value.

The same rule lives in `rule-engine.js`'s `runDerivationRule` fill branch (steward-configured rules) and
is filtered per-stage in `registry-checks.js` and `derivation-checks.js`.

## Two buttons, two questions

- **Check** — "is this record right?": validate, derive, normalise. **Nothing about duplicates.**
- **Duplicate Check** — "does it already exist?": validate, derive, match. Derivations run **in memory
  only** (a rule conditioned on a country nobody typed still has to fire).

Both stage nothing and share `runRequestChecks`; only the stage list differs, never the order.
**Submit/resubmit run the validations and the duplicate check, never the derivations** — a derivation
changes the data and the requester has to have seen what they are asking for.

## Checks run on a button press, and only on a button press

The automatic/debounced trigger was removed: **opening a record dialog commits the cell behind it**, so
"+" and "Add" fired checks nobody asked for, mid-typing, each costing an AI Core call and a remote
round trip. Every guard against the resulting double-dialogs worked; the premise was wrong.

- `_onFieldCommitted` does **local work only**. `test/check-triggers.test.js` pins that it makes no
  server call. Adding a debounced check back is a one-line change, which is why the absence is tested.
- `_cancelPendingTrigger` has no timer left and empties `_declinedProposals` so a check button asks
  again. Every check-running button calls it first.
- `_rememberDeclined`/`_isDeclined` are the record of what was offered and refused; nothing filters on
  it. Declines are recorded in `afterClose` (Escape is a decline; so are unticked rows after Apply).
  One dialog at a time (`_proposalsOpen`).

**One deliberate exception: the data steward review screen.** `_loadStagedRequest` calls `this.onCheck()`
itself — the same call a press makes — once loading is done, when `mode === "datasteward"` **and**
`state.requestStatus === "checkAndEnrich"`. This runs on **every** open and each run books a vendor
number in S/4. The cost is accepted: S/4's own verdict is what a steward is there to look at. **This is
the only page-load trigger in the app — do not generalise it, and do not build a debounced or
field-commit version.**

## Registry checks — VIES and GLEIF (`registry-checks.js`, `srv/ai/registry.js`)

One validation and one derivation sharing a single lookup (VIES throttles per member state).

- **VIES proposes, it never applies.** A VAT number VIES does not know **blocks**. A name or address
  disagreeing **warns** *and* proposes. `NAME_MISMATCH_SEVERITY` is the knob back to `'error'`.
- **The registered name is proposed over the typed one** (`nameDerivations`), only where the two
  disagree at the same bar the warning uses (`scoreAgainst` below `ACCEPT_SCORE`, so casing and
  punctuation are not a mismatch — that is `normalise.js`'s job). **Organisation only.** A name longer
  than the 40-character `OrganizationBPName1` is **split across `OrganizationBPName2`**, not truncated.
  GLEIF is deliberately absent: `acceptedEntities` only keeps close matches, so it has no disagreement.
- **A filled address field is proposed over only where the register disagrees**, graded by `sameText` —
  the same bar `differingAddressFields` uses, so the dialog cannot offer a "correction" the finding
  itself does not consider a disagreement.
- **Never block on an outage.** `vat_registered` is the check name for both "not registered" (error) and
  "could not confirm" (info — VIES answers `isValid: false` when throttled). Re-grade by **severity**,
  never by check name; `severityOf` exists for this.
- **GLEIF is a last resort, not a second opinion.** Searched only when a name **and** a country are
  filled in (a name alone once put a Belgian company under a Dutch entity's number) **and** no VIES
  check came back `VALID`. `requireCountry: false` is opt-in, used only by the assistant's prefill,
  whose answer is chat prose and never a proposed field value; a test pins that the pipeline never
  passes it.
- The derivation fills empty address fields on the **first** address row, VIES then GLEIF.

## The CVI configuration check (`cvi-checks.js`)

Answers **will this partner actually synchronise?** Reads `CviConfigService`, backed by CDS views in S/4
package `ZMDM_LIGHT`.

- **A role its BP category may not carry** — `TB003` role → role category, `TB003A` allowed BP
  categories. **Every CHAR(1) flag in these sets arrives as `Edm.Boolean`, not `'X'`** — this rule was
  wrong twice over exactly that. `isSet` accepts both. The no-flags-set guard describes no real system.
- **Postprocessing switched off** — PPO off means a sync error is dropped rather than queued and the
  partner silently never becomes a customer. Reported per row of `CviPostprocessingControl`, never
  against a hardcoded sync object name.
- **Number assignment** — `TBD001`/`TBC001`, `CVIC_*_TO_BP1` (inbound, both empty on S4A), `TB001.NRRNG`,
  `T077D.NUMKR`/`T077K.NUMKR`, `TBD002`/`TBC002`, `MDSC_CTRL_OPT_A`. The inbound rows are exposed but
  never read — MDM Light only creates BPs — and a test pins that a rule cannot mistake one direction for
  the other.
- **Severity is `warning`; `ROLE_CATEGORY_SEVERITY` is the knob.** Blocking a legitimate partner leaves a
  requester unable to submit with no way to argue. Move to `error` once seen right on real data.
- **A configuration that cannot be read reports itself and never blocks** — the pipeline turns a thrown
  validation into a blocking error, so an unreachable S/4 would stop every submit.
- **Configuration, not SAP's verdict.** `CVI_FS_CHECK_CUST` is a module pool with no callable API.
- Deliberately not built: contact person synchronisation — MDM Light stages no contact persons.

**`cvi_account_group`** fills `Customers.CustomerAccountGroup`/`Suppliers.SupplierAccountGroup` from
`TBD001`. Silent wherever it cannot be sure. It **proposes over** a hand-picked account group;
`accountGroupConflictFindings` stays beside it regardless, because S/4 uses `TBD001`'s whether or not
the requester ticks the row. Which target a role reaches for comes from `TBD002`/`TBC002`, **never from
the role name** — pattern-matching `FLCU*` would be a guess.

## SAP standard checks (`ZMDML_BPCHECK` via `bp-check.js`)

- **They only see accepted values.** `runDerivations` returns a third payload, `systemDerived`: what was
  typed plus only entries marked `system: true`. `checkStandard` runs on that, never on `derived` —
  otherwise S/4 objects to postal codes VIES merely *proposed*, an error a requester cannot clear.
  `cvi_account_group` is the **only** `system` derivation, load-bearing twice: `TBD001` decides the
  account group whatever the screen says, and it is what *creates* the `Customers`/`Suppliers` node,
  without which `ZMDML_BPCHECK` sends no relation node and those tiers silently examine nothing. A keyed
  entry is replayed **by key, not by index**.
- **They are held back until the proposals are answered.** `bp-check.js` flattens every S/4 message to
  `{severity, message}` and discards S/4's own `field`, so "was this message about City?" cannot be
  answered — and an accepted value can make a **new** message appear. The answer is **when**, not
  **which**: `StandardJson` is returned separately and `_resolveStandardChecks` decides on the way out of
  the dialog. Nothing to propose: shown on the first press. Nothing accepted: shown as they are, **no
  second round trip and no second vendor number**. Something accepted: `_rerunStandardChecks` asks again
  with `Propose: false`, replacing rather than merging. `_applyProposals` **returns the number of fields
  it changed** and that count is what `afterClose` reads.
- **They only run on the DATA STEWARD step.** `stewardStep` reads the screen's own `req.data.Role`.
  Same trust level as `renderRole` — nothing is written or approved on the strength of `Role`; what it
  decides is whether a dry-run costs a round trip and a vendor number, so a client that lied spends only
  its own.
- **`MAX_SEVERITY` is `'error'` since 2026-09-03**, which is the condition its own comment set: the
  messages had by then been seen right on real data — two requests approved and then refused at the
  post (`Partner role SP already exists`, a missing standard address), both reported by S/4 as `E`
  beforehand and both arriving as warnings a steward could walk past. An S/4 `W` is still a warning
  and `I`/`S` still info. `runChecks` still never lets a standard finding flip `valid`, so the
  pre-action gate still uses `_standardBlocks(findings)`: anything with `severity !== 'info'` blocks,
  and a non-array blocks too.
- **An S/4 `error` blocks the data steward COMPLETING the review** (asked for 2026-09-03), server
  side, in `decideDataStewardReview`'s complete branch — the screen's `_standardBlocks` is the
  courtesy version and a direct service call walks past it. Run through `runRequestChecks` with
  `stewardStep: true`, never `createBpCheckStage` directly: the checks must see `systemDerived`, and
  handed the raw staged payload they send no relation node at all and the customer and vendor tiers
  examine nothing. **The server asserts the step from the request's own status** — asking the client
  whether to gate would be no gate.
- **The gate cannot throw.** It answered `500` on its first day live and the screen lost the findings
  with it — no verdict *and* no data, which is worse than either alone. The check is wrapped: a run
  that could not happen is logged (`[steward-gate]`) and **stepped over**, because a check that could
  not RUN is not one that failed and an unreachable S/4 must not strand a review with nothing to fix.
  A refusal leads its list with *"Resolve the errors below before submitting this request."*, and the
  findings travel in `ValidationsJson` so the screen keeps them on strips until the next action.

**Two messages nobody could clear:** `VMD_API/043` fired on every EU vendor because `ZCL_MDML_BPCHECK`
never built a `TaxNumbers` node; same blind spot fed `CVI_API/007`. `FSBP_GENERIC/008` was *caused* by
the mapper setting `datax-langu` unconditionally — a blank with the X-flag set means **clear this
field**. So `StagedAddresses` gained **`Language`** (ADDR1_DATA-LANGU). **It is not
`CorrespondenceLanguage`** — that is BP-level and person-only on an organisation. Keep the two apart.

## Field lengths (`field-lengths.js`)

One validation, `field_lengths`, offline, registered beside `node_required_fields` and before any
remote call. Reads the **staging model** for every `cds.String` element carrying a `length` - no list
of fields is kept, so a column added to `db/staging.cds` is covered the day it lands.

Reported live 2026-09-04: a create passed `checkRequest` twice and then answered `submitRequest`
with a bare `500` - `value too long for type character varying(3)` on
`StagedCustomerTaxGrouping.CustomerTaxGroupingCode`. Nothing looked at lengths, so the requester got
no field name and no way to act, and the staged lengths mirror `API_BUSINESS_PARTNER`'s own, so S/4
would have refused the same value at the post.

- **Only strings are measured.** `Decimal`'s `length` is a precision and `Date` has none, so
  measuring either refuses a value nothing rejects.
- **`EXCLUDED` applies**, so `action`, `ID` and the backlinks are never measured.
- **The row is named, not just the section** (`target` + `index` + `field`), and the message carries
  the section as the requester sees it plus both numbers.

**The two tax sections are confusable because S/4's own labels are inverted.**
`CustomerTaxGroupingCode` is labelled *"Tax Category"* and takes **3** characters;
`CustomerTaxIndicators.CustomerTaxCategory` is labelled *"Tax Condition Type"* and is where a
4-character `MWST` belongs. The section title is therefore **"Customer Tax Grouping"**, not
"Customer Tax Categories" - a requester looking for "tax category" chose the wrong one and there was
nothing to catch it. `SECTION_TEXT` in `payload-fields.js` says the same. **Do not "restore" the
friendlier title.**

**The column cannot be widened to fix a case like this** - `cds-deploy` can neither drop nor retype
an element (`deployment.md`). Here it should not be: S/4 says 3 as well.

## SPRO derivations (`derivation-checks.js`)

One stage, `sap_derivations`, reading `DerivationConfigService` with a 60s cache. Runs **last** — a
country default is the weakest claim on any field. Check and Duplicate Check only.

- **Address language** from `T005-SPRAS`, on **every** address row.
- **Customer tax category** from `TSTL` — proposes the ROWS; `CustomerTaxClassification` is left empty
  on purpose. Only when the request asks to be a customer, never into a filled section. **A created tax
  row needs TWO entries** — `createsRow` writes one field, so the departure country comes from a second
  entry that finds the row the first made; without it the row is half a `KNVI` key.
- **Address time zone** from `TTZ5S`, keyed by country **and** region. Where several zones exist and none
  is default, nothing is derived — a customizing gap, not a coin toss.
- **`TransportZone` is deliberately NOT staged**: `TZONE` carries no determination data.
- **Mandatory customer partner functions** from `TKUPA` → `TPAER`; `TKUPA`'s key is the **account group
  alone**. Only `PartnerType = 'KU'`. Needs a `CustomerSalesArea` row; three extra entries fill that key.
- **Mandatory supplier partner functions** from `T077K-PARGE` → `TPAER` — **a different table**. Only
  `PARGE` is joined. Guard inverted: `PartnerType = 'LI'`, or each side proposes the other's functions.
- Customer-only is not an oversight: `KNVI` has no vendor counterpart.
- **Do not copy `cvi_account_group`'s `system: true` onto these.**

**The remote value-help service caps a response at 100 rows.** `config-reader.js`'s `readAllOf` is
mandatory for every customizing read (twelve were silently truncated). Two decisions inside it: **`skip`
advances by what arrived, never by `pageSize`**, and **the loop ends on an EMPTY page, not a short one**
— unlike `readAllPages` in `business-partner-service.js`, where the caller sets the page size. Still
unpaged deliberately: `fetchWorkflowEntityRows` and everything on local Postgres. `diagnose` logs the
five config **row counts**, because a truncated read looks exactly like customizing that says nothing.

## Cache TTLs and the warm-up (`warmup.js`)

**Measured 2026-09-03:** the first `checkRequest` after any pause took **9.96s**, the same press warm
took **0.67s**. About 4.5s of the gap was the destination handshake plus the paged customizing reads;
the rest was the first AI Core call. With a 60s TTL a requester who stopped to think re-paid it, so
the cost landed on a person rather than on boot.

- **All four customizing caches are 15 minutes**, not 60 seconds — `rule-store`,
  `field-property-store`, `cvi-checks`, `derivation-checks`. Free for the first two: `markStale` drops
  them on every write, so a steward's Apply is still live on the next press. For the other two this
  app cannot write the source at all, so the only cost is that an SPRO change transported into S/4 is
  picked up within 15 minutes instead of one.
- **`startWarmup()` fills all four at boot and refreshes them every 12 minutes**, fired and forgotten
  from `ChangeRequestService.init` the same way `checkMetadataDrift` is. The refresh is the half that
  matters — priming once only moves the first press. **The interval must stay strictly inside the
  shortest TTL** (pinned by a test): a refresh that lands after the expiry leaves exactly the cold
  press this exists to remove.
- **A refresh must force a real read**, or it is a no-op: every one of these returns the cache when
  it is not due yet. Hence `{ force: true }` and the dedicated `prime()` on the two remote stores,
  which reads first and swaps after — never a window where the cache is empty and a concurrent
  request pays the cold read itself, and a failed refresh keeps what was working.
- **One instance is assumed.** Scale `mdm-businesspartner-srv` past one and each instance warms and
  invalidates its own copy — a rule change would be live on the instance that took the write and up
  to 15 minutes stale on the others. Lower the TTLs again, or give the stores a shared cache.

## Normalisation (`normalise.js`)

AI Core proposes reformatting of **stored** data (casing, legal forms, whitespace, street conventions).
**Proposals only.** Normalising *for comparison* is solved deterministically in `duplicate-fields.js`
and is a different thing. A derivation says what the *right value* is; a normalisation only says how the
value that is there should be *written*.

`sanitizeProposals` drops a proposal for a field that was not offered or that changes nothing.
Identifiers (tax numbers, IBAN, BP number) are outside `NORMALISABLE`. Runs on **Check only** and
returns `[]` on any failure.

**Never reuse the same example word across two different corrections in `SYSTEM_PROMPT`** (fixed
2026-09-04, reported live: a real `StreetName: "Koedreef"` — already correct, `dreef` is a complete
street-type word, nothing to expand — came back proposed as `"Koedreef Straat"`). The capitalisation
example and the street-type-abbreviation example both used `"koedreef"`, and the model pattern-matched
the real input against the second example rather than reasoning about whether an abbreviation was
actually present. The prompt now names `Koedreef` explicitly as a must-not-touch example instead, and
the street-type example requires a genuine abbreviation marker (a trailing period or an unambiguous
truncation) before proposing anything.

## The proposals dialog

Derivations and normalisations share one dialog, everything ticked by default, `change` column saying
`Filled in`, `Replaced`, `Row added` or `Reformatted`. Derivations **no longer auto-apply**. A
`Replaced` row shows the typed value in **Current**; unticking keeps what was written.

- A field a derivation filled and the model then reformatted is **one row, not two**; the normalised
  value wins.
- The proposed value is an **editable input**. Clearing the field is a decline, not an instruction to
  blank what is there.
- A derivation carrying **no `field`** is a statement — it stays a message strip.
- **The Why column is three words, sentence on hover.** Labels: `VIES check`/`GLEIF check` (named after
  the source — a requester needs to know which register to argue with), `CVI customizing`, `Derivation
  rule`. Normalisations get theirs from the model; `shortReason` clamps to three words server-side. A
  missing `detail` falls back to a stated sentence.
- **A whole derived ROW is one line.** `_proposalRows` groups on **target + index**, and a group whose
  lead carries a **`rowKey`** collapses into one line: Field names the **section**, `subtext` carries the
  key, only the lead is tickable, key fields travel as `extras`. **The `rowKey` is the boundary, not
  `createsRow`** — grouping on `createsRow` collapsed VIES's four independent address fields into one
  line with only Street editable.
- Duplicate findings survive the dialog in a collapsed `Panel`. **Only a match ever changes that panel**,
  and only Duplicate Check and Submit match.

## Gating and re-validating

Two mechanisms, because they answer different questions ("may this be shown" vs "does this still pass").

- **Gating.** `runDerivations`/`runChecks` take an optional `fieldEditable(target, field)`; an entry
  whose target field it refuses gets **no entry at all** — not written, not reported, not offered. Built
  from `fieldState` for the **screen's own** role, which is a rendering trust level, not a security
  boundary. A caller sending neither `RequestType` nor `Role` resolves to `role: null`, matching only
  `*` profiles.
- **Re-validating.** `runSubmitValidations(req, payload)` is shared by `submitRequest`,
  `resubmitRequest`, `decideDataStewardReview`'s `complete` branch **and `decideRequest`'s approve
  path**. On approve it runs over `loadStagedPayload` and a blocking result **rejects the action
  outright**, safe because nothing has been written. The reason: configuration can change since submit.
- **`loadStagedPayload` must always assign an ARRAY** to `sections[section]`, whatever `config.many`
  says. `relation-checks.js` and `node-required.js` silently `continue` on a non-array — a real
  Suppliers row was invisible and the check reported "no Supplier record" over a row it never looked at.
- **Derivations never run on approve** — nothing there is editable.
- **`_runPreActionCheck`** is the client half: `onSave` and `onApprove` call it first, from a button
  press. It is the **full Check-button experience** — same `checkRequest`, same block message, same
  `_offerProposals` dialog. **Never add a second, cheaper way for a proposal to reach the screen.**
  **Never for Approve** (`forApprove: true`) — `decideRequest` takes no `DataJson`, so an acceptance
  would have nowhere to go.
