# Configurable duplicate check — design

Status: **design, not implemented.** Agreed 2026-08-11. Nothing in `srv/ai/`
implements this yet; today's check is name-only and hard-coded in
`srv/ai/name-match.js` (Dice ≥ 0.86 over three name fields).

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
| 40 | | 1 | | | `TaxNumber.BE0` | — | | not relevant |

Row 20 has no condition: name always participates as a fuzzy strong indicator.
Row 40 turns the VAT criterion off for natural persons, who legitimately have
none.

### Indicators

`not relevant` · `weak` · `strong` · `definitive`

`not relevant` exists to switch off a criterion a broader row switched on, which
only works if row order is meaningful — see below.

### Row precedence

Rows are evaluated in `Seq` order and **the first matching row wins per field**.
A specific row must therefore sit above the general row it overrides (row 40
above row 20 in spirit; renumber accordingly). Same semantics as a BRF+ decision
table with first-match, applied per field rather than per table.

Consequence for the admin page: `Seq` must be visible and editable, and the
table must default to sorting by it. A table that silently reorders rows changes
behaviour.

## Aggregation — the open decision

Individual indicators must collapse into one verdict per candidate pair.
Proposal, deliberately kept in code rather than config so it stays explainable:

| Verdict | When |
|---|---|
| **definitive** | any `definitive` criterion matched |
| **strong** | ≥ 2 `strong`, or 1 `strong` + ≥ 1 `weak` |
| **weak** | 1 `strong`, or ≥ 2 `weak` |
| none | otherwise |

Making this itself configurable is possible but turns every duplicate result
into something nobody can explain to an auditor. Recommend fixing it first and
revisiting only if a real case needs it.

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
| Tax number | uppercase, strip non-alphanumeric, optionally strip the country prefix (`BE0123456789` ≡ `BE 0123.456.789` ≡ `0123456789`) |
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

## Integration points

`findIndexedDuplicates` keeps its signature; `rankDuplicates` is replaced by a
rule-driven evaluator. Per the convention in `CLAUDE.md`, the evaluator's helper
functions go on `_internals` with tests in `test/`.

## Open decisions

1. **Aggregation ladder** — confirm or amend the table above.
2. **Does `definitive` hard-block?** Today a duplicate only hides the create
   suggestion button. A definitive hit could refuse the change-request submit
   outright.
3. **Where does this apply?** The assistant is advisory; the real gate is the
   staging submit path. Recommend the config drives both, since a rule enforced
   only in the chat window is not a control.
4. **Persons vs organizations** — likely different default rows rather than a
   different model, but confirm.
