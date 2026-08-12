# Configurable duplicate check — design

Status: **engine built and wired in 2026-08-12.** The engine's own tests passed
in BAS (163 tests, 0 failures); the wiring commit on top of them has not been run
yet — there is no Node toolchain on the Windows machine.

The `Country` disqualifying row — the thing that makes an exact-name rule safe —
now works against existing partners, because the index carries addresses. See
"Index impact" below.
`srv/ai/duplicate-fields.js` (catalog, normalisers, candidate bags) and
`srv/ai/duplicate-engine.js` (`evaluate`) implement everything below except
persistence and the admin page. No caller uses them yet — the live check is
still name-only via `rankDuplicates` in `srv/ai/name-match.js`. `DEFAULT_RULES`
is **not** a like-for-like copy of it any more — see "A name-only candidate can
reach `Duplicate`" below.

Remaining: `DuplicateRules` persistence, the admin page, extending
`createNameIndex` to carry tax numbers and addresses, and replacing
`findIndexedDuplicates` / the submit path with calls to `evaluate`.

## Goal

Let a data steward express duplicate criteria as configuration instead of code,
including criteria that only apply under a condition — *"for Belgian partners,
an identical BE0 VAT number is a definitive duplicate"* — and see the effect of
a change before saving it.

## Shape: a BRF+-style decision table

One row is one rule. Condition columns may be left empty, meaning "any". This is
the mental model our SAP consultants already have, and it is the reason for the
row-oriented layout over a nested criteria/ruleset model.

| Seq | Country | Category | Grouping | Role | Field | Comparison | Threshold | Indicator |
|-----|---------|----------|----------|------|-------|------------|-----------|-----------|
| 10 | BE | 2 | | | `TaxNumber.BE0` | exact | | definitive |
| 20 | | | | | `Name` | fuzzy | 0.86 | strong |
| 30 | | | | | `PostalCode` | exact | | weak |

Row 20 has no condition: name always participates as a fuzzy strong indicator.
Row 10 applies only to Belgian organizations — natural persons are excluded by
the `Category = 2` condition rather than by an opt-out row.

**Conditions must hold on both records of the pair.** A rule written for Belgian
partners says nothing about a Belgian record compared with a German one. The
consequence is that a sparse candidate — the assistant's, which often carries
only a name — cannot fire a conditioned rule at all, which is the same reason it
cannot reach `Duplicate`.

### Indicators

`weak` · `strong` · `definitive` · `disqualifying`

There is deliberately no "not relevant" indicator. A field that does not matter
is simply not configured. Switching a criterion off for a subset is expressed by
narrowing the conditions on the row that switches it *on*.

`disqualifying` is **negative evidence**: if both records carry a value for the
field and the values differ, the pair is ruled out entirely — verdict `none`,
whatever the other rows found. Blank on either side still says nothing.

It exists because without it nothing could ever rule a pair *out*: two partners
with different VAT numbers are definitively not the same company, but a differing
value merely failed to contribute. That gap is what made escalating a name-only
match unsafe — a sparse candidate would have produced a *stronger* verdict than a
rich one whose identifiers disagreed. Fix the negative side and the escalation
becomes safe.

`disqualifying` never competes for strongest-per-field and carries no rank; it
short-circuits the pair instead.

### Two rows on the same field

Rows are additive: every row whose conditions match is evaluated. Where more
than one matching row targets the same field, **the strongest indicator wins and
the field contributes once**.

Contributing once is the point — a Belgian partner matching both row 10 and a
general name row must not count as two indicators off one field, which would
inflate the verdict.

Because there is no opt-out indicator, no row can ever weaken another, so
strongest-wins is unambiguous and **`Seq` carries no semantics**. It orders the
table for reading, nothing more. This is a simplification over an earlier draft
that needed first-match ordering; dropping "not relevant" removed the need, and
with it a trap where re-sorting the admin grid would silently change behaviour.

## Aggregation

Individual indicators collapse into one verdict per candidate pair. Fixed in
code, not configurable — a configurable ladder makes every result impossible to
explain to an auditor.

| Verdict | When |
|---|---|
| none | any `disqualifying` row found differing values — checked first, beats everything |
| **Duplicate** | ≥ 1 `definitive` |
| **Strong chance of duplicate** | ≥ 2 indicators, at least one `strong` |
| **Small chance of duplicate** | exactly 1 `strong`, or ≥ 2 `weak` |
| none | otherwise — a single `weak`, or nothing |

A lone weak indicator is not a finding. One shared postal code is not a signal.

## Blank is never a match

The single most important rule in the engine, and the easiest to get wrong: two
partners that both lack a VAT number must not count as an `exact` match on VAT.
Every comparison skips the criterion when either side is empty after
normalisation — it contributes nothing rather than contributing a match.

Without this, `definitive` on a sparse field marks the entire sparse population
as one duplicate cluster. Given our baseline (67% of BPs have no `SearchTerm1`,
~92% of addresses no email) this would fire immediately.

## Comparison types

| Comparison | Semantics |
|---|---|
| `exact` | equal after normalisation |
| `fuzzy` | Dice over fingerprint ≥ `Threshold` (today's behaviour) |
| `contains` | one normalised value contains the other |
| `semantic` | embedding cosine ≥ `Threshold` — **not yet available**, see below |

A rule the engine cannot **run** — `semantic` today, a field no longer in the
catalog, an unknown indicator — is reported on `evaluate`'s result as
`unrunnableRules` rather than treated as a non-match. "No duplicates found"
produced by a rule that never ran is the one wrong answer this check must not
give.

This is a config-health signal for the admin page and the deploy log, **not an
end-user message**. A rule correctly skipped because its conditions did not match
the pair — a BE row against a US partner — is normal and is never reported.

`semantic` is the extension point for the AI Core embedding work. It needs a
vector store, which we do not have: HANA Cloud was rejected on cost and
`pgvector` on the free `mdm-businesspartner-db` plan is unverified. Model the
comparison type as a value so adding it later is config, not a schema change.

## Normalisation

Per-field, applied before every comparison. Not configurable in phase 1 — each
field in the catalog carries its normaliser.

| Field kind | Normalisation |
|---|---|
| Name | existing `companyFingerprint` — casefold, strip punctuation, drop legal forms (`nv`, `bv`, `sa`, `gmbh`…) |
| Tax number | uppercase, strip non-alphanumeric, zero-pad the national part to the country's width, then **prefix a bare number with the record's own country**. Stripping the prefix instead would make `BE0123456789` and `NL0123456789` the same definitive duplicate. A bare number on a record with no country stays bare, so it misses rather than false-positives. Padding is what makes BP 208's three spellings of one number — `BE0448207405` (BE0), `0448207405` (BE1), `448207405` (BE2) — compare equal; without it the BE2 form matches nothing. Widths live in `NATIONAL_NUMBER_LENGTH`, today `{ BE: 10 }` |
| Postal code | strip spaces and dots |
| IBAN | uppercase, strip spaces |
| Street | casefold, strip punctuation |

This is where duplicate checks actually live or die — more so than any threshold
value.

## Field catalog

Admins pick a field from a catalog, they do not type OData paths. The catalog is
**code-defined**, mapping a logical name to its source entity, property and
normaliser.

The reason is not usability: the matching index has to physically carry every
field a rule can reference. An admin who could name an arbitrary field could
write a rule the engine cannot evaluate. Adding a field to the catalog is
therefore a code change plus an index change, by design.

Initial catalog: `Name`, `SearchTerm1`, `TaxNumber.<type>`, `PostalCode`,
`CityName`, `Country`, `StreetName`, `IBAN`.

**Prefer bare `TaxNumber` over `TaxNumber.<type>`.** Bare compares across every
tax type after normalisation, which is what catches one partner's BE0 against
another's BE1 — a real case in the sandbox. Use `TaxNumber.<type>` only when a
rule genuinely must be type-specific.

### What the sandbox data already says

`A_BusinessPartnerTaxNumber` holds 110 rows over 273 BPs, several per partner, so
well under half of partners carry a tax number at all — the ceiling on what any
identifier rule can achieve. And `BE0666471360` sits on **eight** partners
(5, 11, 13, 14, 15, 200, 218, 266), `BE0417497106` on three. A definitive
`TaxNumber` rule fires on those clusters immediately. Establish whether that is
real duplication or placeholder data before showing it to anyone.

## Persistence

CDS entity in `db/`, on the existing `mdm-businesspartner-db` Postgres instance,
alongside the staging tables.

```cds
entity DuplicateRules : managed {
  key ID          : UUID;
      sequence    : Integer;
      // conditions — null means "any"
      condCountry     : String(3);
      condCategory    : String(1);
      condGrouping    : String(4);
      condRole        : String(6);
      // rule
      field       : String(40);
      comparison  : String(20);
      threshold   : Decimal(3,2);
      indicator   : String(12);
      isActive    : Boolean default true;
}
```

Two notes:

- `managed` (from `@sap/cds/common`) gives `createdBy` / `createdAt` /
  `modifiedBy` / `modifiedAt` for free. A duplicate ruleset is effectively a
  control, so this is worth having from row one rather than retrofitted.
- Config lives in **rows, not columns**. Adding a criterion is an INSERT. This
  also sidesteps the deployer trap in `CLAUDE.md`: `cds-deploy` refuses to drop
  elements during schema evolution, so a column-per-criterion model would make
  every removed criterion a failed deployment.

## Admin page

Fiori Elements list report over `DuplicateRules`, `+` appends a row, inline edit,
sorted by `Seq`.

**Authorization is deferred** — agreed as a later TODO. Target is a
`MDMLight Steward` scope in `xs-security.json` on top of BTP/CF space access.
Until then the entity must not be exposed writable in a real tenant.

### "Test against current BPs"

Runs the active ruleset over the whole partner index and reports counts per
verdict tier plus sample pairs, without saving. This is what stops people tuning
blind into a config that flags everything or nothing.

Scaling caveat worth recording now: this is pairwise, O(n²). At our 261 BPs that
is ~34k comparisons — instant. At 50k BPs it is 1.2bn, and the test needs a
blocking key (compare only within the same country, or the same first-N
fingerprint characters) before it is usable. Not a phase 1 problem; do not
design it out of reach.

## Index impact

Done 2026-08-12. The index carries three child collections per partner —
`CHILD_SOURCES` in `srv/ai/name-index.js`:

| Collection | Entity | Columns kept |
|---|---|---|
| `addresses` | `A_BusinessPartnerAddress` | BusinessPartner, StreetName, PostalCode, CityName, Country |
| `taxNumbers` | `A_BusinessPartnerTaxNumber` | BusinessPartner, BPTaxType, BPTaxNumber |
| `roles` | `A_BusinessPartnerRole` | BusinessPartner, BusinessPartnerRole |

Only catalog columns are kept — the point is the matching fields, not a second
copy of S/4. Roughly 150 bytes a partner on top of the header, so a 200k index
moves from ~20MB to ~50MB. **That is the new ceiling to watch**; past it, move to
a Postgres-backed index rather than growing the resident one.

`Country` had to come from addresses because `A_BusinessPartner` has no country
field at all — verified against the sandbox, and worth knowing before anyone
proposes reading it from the header.

**Bank details are deliberately absent.** `IBAN` stays in the catalog marked
`indexed: false`: bank data resident in memory on every CF instance is a
different risk class from a postal code, and nobody has asked for an IBAN rule.
Adding it is one read plus one flag, but it is a decision, not an oversight.

### Delta cost, and the gap it leaves

A full rebuild reads every child row. A delta re-reads children **only for the
partners whose header just changed**, chunked 50 ids at a time so the generated
`$filter` stays sane. Cost therefore tracks change volume, not population.

The gap: a child edited without touching its header — a new address on an
otherwise untouched partner — is invisible until the daily full rebuild. That is
the same class of staleness as a deletion, and the same rebuild covers it.

### The admin page needs this

Each catalog entry now carries an `indexed` flag, exposed as `catalogFields()`
and `isIndexedField()`. A rule over a field the index does not carry contributes
nothing against an existing partner, **silently** — so the admin page must be
able to see the flag rather than let a steward configure a rule that does
nothing. This is the mechanism that keeps the field catalog honest as it grows.

## One engine, every caller

**Requirement: there is exactly one duplicate check.** It must not behave
differently depending on whether the assistant, the change-request submit or the
admin test button invoked it. This is the constraint that shapes the interface.

Today's entry point takes a name — `rankDuplicates(name, entries)`. That cannot
serve the submit path, which has a whole staged record rather than a string. So
the engine takes a **candidate record**: a field bag keyed by field-catalog
names.

```
evaluate(candidate, index) -> [{ partner, verdict, indicators[] }]
```

| Caller | Candidate built from |
|---|---|
| Assistant | extracted company name, plus country from research when present |
| Change-request submit | the staged nodes (`StagedGeneral`, addresses, tax numbers) |
| Admin test button | each indexed partner in turn, compared against the rest |

The assistant's candidate is sparse — often only `Name`. That works without a
special case precisely because **blank is never a match**: rules referencing
fields the candidate does not carry simply do not fire. The sparse-candidate
case and the missing-data case are the same code path, which is why that rule
is worth being strict about.

### A name-only candidate can reach `Duplicate`

Agreed 2026-08-12. With `disqualifying` in place it is safe for a name alone to
be definitive, because the only pairs that reach the name rows are ones whose
identifiers and countries do not contradict each other. `DEFAULT_RULES` encodes
this:

| Seq | Field | Comparison | Threshold | Indicator |
|-----|-------|------------|-----------|-----------|
| 5 | `TaxNumber` | exact | | disqualifying |
| 6 | `Country` | exact | | disqualifying |
| 10 | `TaxNumber` | exact | | definitive |
| 20 | `Name` | exact | | definitive |
| 25 | `Name` | fuzzy | 0.92 | definitive |
| 30 | `Name` | fuzzy | 0.86 | strong |

So for candidate "Alluvion NV": existing `Alluvion` and `Alluvion BVBA` share the
fingerprint `alluvion` and hit row 20; `Aluvion` scores 0.923 and hits row 25.
All three come back as **Duplicate**. A 0.875 match — one letter in a longer name
— stays at row 30 and reports **Small chance**.

Row 6 is what makes an exact-name-is-definitive rule defensible outside a
single-country tenant: "Delta NV" in BE and "Delta Inc" in the US share a
fingerprint but differ on country, so they never reach row 20.

Note that the rows above are *defaults*, not the ladder. A steward who finds
0.92 too eager moves it, which is the whole point of the table.

Sparseness still changes what a caller can conclude: an assistant candidate
carries no identifiers, so `disqualifying` rows cannot fire for it either and it
is trusting the name entirely. Present the result as provisional, never as an
all-clear.

### Persisting submit-time results

`CheckFindings` in `db/staging.cds` already reserves `candidateBP` and `score`
for duplicate findings, alongside `checkName`, `severity`, and the
supersede-on-recheck field. Submit-time verdicts belong there.

One gap: `score` is `Decimal(5,4)` and there is no column for the verdict tier.
Either map verdict onto the existing `severity` enum (`info` / `warning` /
`error`) or add a field — adding is preferable, since severity and verdict are
not the same concept. Note the deployer refuses to drop elements, so decide
before the first deploy that creates the column.

## Integration points

`srv/ai/duplicate-check.js` is the one entry point. `activeRules()` there is the
single seam a `DuplicateRules` table replaces later — nothing else in the app
decides what the rules are.

| Caller | Path |
|---|---|
| Assistant | `findIndexedDuplicates` → `nameIndex.match` → `evaluate` |
| Assistant, index unbuilt | `checkAgainstPartners` → `evaluate` over the rows already read |
| Change-request submit | `submitRequest` → `checkBusinessPartnerDuplicates` action → the same `findIndexedDuplicates` |
| Admin test button | not built yet |

`rankDuplicates` is **deleted**, not deprecated. A second ranking entry point
next to `evaluate` is precisely how the two would drift, and this repo has
already paid for that lesson twice. `name-match.js` is now name *scoring* only.

The change-request service reaches the check through a CAP action rather than by
requiring the module, so it shares this app's S/4 connection and the single
resident name index instead of building a second one.

Submit-time findings are best-effort: a check that cannot run logs and moves on.
Stranding a request in `draft` with an approval workflow already waiting for it
would be a worse failure than a missing finding.

## Open decisions

1. ~~**Does `Duplicate` hard-block the submit?**~~ **Decided 2026-08-12: no.**
   Submit succeeds and the check writes a `CheckFindings` row with severity
   `error` that the approver must clear. The approver is the override, so no
   separate override path is needed.
2. ~~**Verdict storage on `CheckFindings`**~~ **Decided 2026-08-12: its own
   column.** `CheckFindings.verdict : String(12)` was added alongside `severity`.
   Severity says whether someone must act, verdict says what was found; folding
   one into the other loses information the approver needs. Adding a column is
   safe — the deployer only refuses to *drop* them.
3. **Rule changes are not retroactive.** A request submitted under yesterday's
   ruleset and approved today was checked against the old rules. Re-check on
   approve, or accept it?
