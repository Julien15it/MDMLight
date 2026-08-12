# Configurable duplicate check — design

Status: **engine built 2026-08-12, not yet wired in and not yet run.**
`srv/ai/duplicate-fields.js` (catalog, normalisers, candidate bags) and
`srv/ai/duplicate-engine.js` (`evaluate`) implement everything below except
persistence and the admin page. No caller uses them yet — the live check is
still name-only via `rankDuplicates` in `srv/ai/name-match.js`, and
`DEFAULT_RULES` reproduces exactly that as a single row.

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

`weak` · `strong` · `definitive`

There is deliberately no "not relevant" indicator. A field that does not matter
is simply not configured. Switching a criterion off for a subset is expressed by
narrowing the conditions on the row that switches it *on*.

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

A rule the engine cannot evaluate — `semantic` today, or a field no longer in
the catalog — is **reported on `evaluate`'s result as `unevaluatedRules`, not
treated as a non-match.** "No duplicates found" produced by a rule that never
ran is the one wrong answer this check must never give.

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
| Tax number | uppercase, strip non-alphanumeric, then **prefix a bare number with the record's own country** — `0123.456.789` on a Belgian partner becomes `BE0123456789`. Stripping the prefix instead would make `BE0123456789` and `NL0123456789` the same definitive duplicate. A bare number on a record with no country stays bare, so it misses rather than false-positives |
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

`createNameIndex` currently holds name fingerprints only. Rules over tax number,
postal code and country mean the index must read
`A_BusinessPartnerTaxNumber` and `A_BusinessPartnerAddress` too and join them
per partner. Fine at current volume; state a ceiling and move to a
Postgres-backed index when it is reached.

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

Sparseness does change what a caller can conclude, though: a name-only candidate
can reach `Small chance` but rarely `Duplicate`, since definitive rules key on
identifiers the assistant does not have. The assistant should therefore present
its result as provisional and never as an all-clear.

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

`findIndexedDuplicates` becomes a thin wrapper that builds a candidate and calls
the engine; `rankDuplicates` is replaced by the rule-driven evaluator. Per the
convention in `CLAUDE.md`, the evaluator's helper functions go on `_internals`
with tests in `test/`.

## Open decisions

1. ~~**Does `Duplicate` hard-block the submit?**~~ **Decided 2026-08-12: no.**
   Submit succeeds and the check writes a `CheckFindings` row with severity
   `error` that the approver must clear. The approver is the override, so no
   separate override path is needed.
2. **Verdict storage on `CheckFindings`** — new column vs reusing `severity`
   (see above).
3. **Rule changes are not retroactive.** A request submitted under yesterday's
   ruleset and approved today was checked against the old rules. Re-check on
   approve, or accept it?
