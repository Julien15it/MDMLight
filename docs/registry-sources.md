# External registry sources — GLEIF and VIES

Status: **built 2026-08-12, verified against the live APIs, never executed** — no
Node toolchain on the Windows machine, so `npm test` must run in BAS. Nothing
calls these modules yet.

`srv/ai/gleif.js` · `srv/ai/vies.js` · `srv/ai/registry.js` ·
`test/registry.test.js`

## The two sources do different jobs

| | Works from | Gives | Use |
|---|---|---|---|
| **GLEIF** | a name alone | LEI, legal name, trading names, registered address, **local company number** | the only thing that helps a name-only duplicate check |
| **VIES** | a VAT number | valid/invalid, and the registered name where the member state returns it | a submit-time data-quality check, plus name enrichment |

**VIES has no name search.** It cannot discover a company from a name and is
therefore useless for the name-only duplicate case. It is in the codebase for
validation and for enriching a candidate that already carries a number.

## Verified against the live APIs, 2026-08-12

### GLEIF

- `GET https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=<name>`.
  Free, CC0, no key.
- Paths: `data[].attributes.lei`, `.entity.legalName.name`, `.entity.otherNames[]`,
  `.entity.legalAddress.{addressLines[],city,postalCode,country}`,
  `.entity.status`, `.entity.registeredAt.id`, **`.entity.registeredAs`**.
- `registeredAs` is the local company number — for a Belgian entity, the KBO
  enterprise number. That is worth far more to a duplicate check than any name
  string, and it is why GLEIF beats a plain web lookup.
- `filter[lei]` accepts a comma-separated list and behaves as an OR; a LEI that
  does not exist is skipped rather than erroring.
- `fuzzycompletions?field=entity.legalName&q=<name>` returns
  `data[].attributes.value` plus `data[].relationships.lei-records.data.id`, so
  names and LEIs come back together and a second `filter[lei]` call fetches the
  records. `searchByName` runs this **only when the direct filter found nothing**,
  so the common case still costs one call.
- Coverage skews to larger and financial-market entities. A miss says nothing
  about whether the company exists.

### VIES

- `GET https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{CC}/vat/{number}`.
  Free, no key.
- **`isValid` alone is not the answer, and reading it alone is a real bug.** All
  three states were observed live:

  | `isValid` | `userError` | Means |
  |---|---|---|
  | `true` | `VALID` | registered — `name` and `address` populated |
  | `false` | `INVALID` | genuinely not registered |
  | `false` | `MS_MAX_CONCURRENT_REQ` | **member state throttled — answer unknown** |

  The third came back on the very first live call. Treating it as "invalid"
  would raise a false `error` finding on a perfectly good Belgian VAT number.
  `statusFrom` maps it to `unknown`, and an unknown produces an `info` finding,
  never an `error` — an unreachable member state is not a data-quality problem,
  and reporting it as one trains people to ignore the finding.
- Belgium returns name and address: `NV ACKERMANS & VAN HAAREN`,
  `"Begijnenvest 113\n2000 Antwerpen"`. **Germany returns neither.** Availability
  is per member state, so absent details are normal, not an error.
- A plain trailing house number is split into `HouseNumber`, because S/4 keeps it
  in its own field while VIES sends `"Koedreef 12"` as one line. Only when the
  rest of the street carries no digits, so `"Kerkstraat 12 bus 3"` stays whole
  rather than yielding `3` as the number. GLEIF is untouched — it sends
  `addressLines`, so its street keeps the number.
- A VIES value that **differs** from what was typed becomes a **proposal**, not a
  derivation: a derivation only fills gaps. Formatting-only differences are left
  to `normalise.js`, so the register and the model never propose the same field.
- Address formatting is the member state's own. `parseAddress` reads the last
  line as `<postal> <city>` when it can and keeps the whole thing in
  `rawAddress` regardless.
- Country codes are **not** ISO: Greece is `EL`, Northern Ireland is `XI`.

## Accepting a registry fact

`registry.js` merges facts into a candidate record so the one duplicate engine
can use them. The rule that matters:

**A registry hit is accepted only at `ACCEPT_SCORE` (0.92) — the same bar a name
match needs to be definitive — and an identifier is taken only when exactly one
entity clears it.**

A GLEIF name search returns loosely related entities. Adding a stray hit's
enterprise number to the candidate would not merely be wrong, it would
*manufacture* duplicates: the candidate would then match every partner carrying
that number definitively. Ambiguity is not a reason to guess, so two plausible
entities contribute names and no identifier.

Every added value carries its source in `provenance`. An indicator that depends
on a third party being up that day has to be explainable months later.

## Risk to keep in view

An enrichment-derived tax number feeds `disqualifying` rows as readily as
definitive ones, so a wrong `registeredAs` can *suppress* a genuine duplicate
rather than create a false one. That failure is silent. The 0.92-plus-single-hit
bar is the whole defence; do not lower it without replacing it with something
better.

## Findings the submit path reports

| Check | Severity | When |
|---|---|---|
| `vat_registered` | `error` | VIES says the number is not registered |
| `vat_registered` | `info` | VIES could not be reached or was throttled |
| `vat_name_matches` | `warning` | registered name disagrees with the typed name |

## The registry set is closed: VIES + GLEIF

Decided 2026-08-12. **No OpenCorporates and no KBO/CBE.** Neither is coming, so
do not reopen either as a backlog item.

- **OpenCorporates** — the free tier is by application for non-commercial use,
  and shipping inside a customer product needs a commercial licence. Not worth
  the procurement for what it adds over GLEIF.
- **KBO/CBE**, and the other country bulk sources (FR SIRENE, UK Companies
  House, NO Brønnøysund, DK, PL, the Baltics) — a per-country ingestion pipeline
  each, and there is no equivalent for DE, ES, IT or NL anyway. The coverage
  would be lopsided and the maintenance would be permanent.

What this costs, stated plainly so nobody is surprised later: GLEIF's coverage
skews to larger and financial-market entities, so an SME with no LEI enriches to
nothing from a name alone. VIES then only helps once someone has typed a VAT
number. That is the accepted ceiling on enrichment recall.
