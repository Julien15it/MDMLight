# CLAUDE.md

Backbone for Claude Code. Detail lives in `.claude/rules/` — **read the rule file for the area you are
touching before you change anything in it.** The code is in the repo and the history is in git; this
file and those carry only what neither of them says out loud.

## What this is

CAP (Node.js) + SAP Fiori Elements (OData V4) recreation of SAP's `mdm.md.businesspartner.manage`
(F3163). There is **no local business-partner database** — the CAP service is a facade that delegates
reads to an S/4HANA OData V2 `API_BUSINESS_PARTNER` service through the BTP destination
`VF_S4HANA_DEST`. BP deletion is disabled throughout.

Reads are pure facade; **creates are staged in PostgreSQL and posted only once approved.** Nothing
reaches S/4 until an approver says so, and **SBPA never writes to S/4**.

## Commands

```bash
npm ci                   # install
npm run watch            # cds watch, http://localhost:4004
npm test                 # node --test test/*.test.js
node --test --test-name-pattern="<pattern>" test/<file>.test.js
npm run local            # cds watch --profile hybrid (live BTP-bound services)
npm run build            # cds build --production
npm run generate:metadata # after any `excluding {}` change (build/build:cf chain it)
npm run import:bp        # re-import API_BUSINESS_PARTNER (Cloud Foundry only)
mbt build && cf deploy mta_archives/mdm-md-businesspartner-manage_<version>.mtar
```

Four npm projects under `app/`: `businesspartner` (Work Zone tile, Fiori Elements), `mdmrules` (MDM
Configuration Panel tile), `bptask` (My Inbox task UI, freestyle), `reuse` (the shared maintenance
screen, copied into the other two at build time). Each has `npm run build:cf`.

## Standing rules

These apply everywhere and the rule files assume them.

- **A check that could not run MUST NOT read as a check that passed.** No "no duplicates found" from a
  check that never ran, no empty findings panel where a lookup failed, no silently skipped validation.
  Report the failure instead.
- **Every remote/platform read that is not a verdict on the data is best-effort** — BTP APIs, BPA
  signals, workflow rule/profile tables, metadata drift, live re-reads for diffing. Never throw, never
  block a submit, log and degrade. The opposite applies to *validation* stores: an unreadable rule table
  reports itself, because a validation nobody ran must not pass silently. An unreadable *field property*
  table resolves to nothing, because hiding every field or blocking every submit over a control is worse.
- **`cds-deploy` can ADD an element and can neither DROP nor RETYPE one.** Any removal fails
  `deploy_to_postgresql` at compile time, identically on every retry. So abandoned columns stay in the
  model as documented dead weight, and a reworked mechanism gets a NEW name rather than reusing a
  deployed one. Currently dead and read by nothing: `DerivationRules.createsRow`, the four `cond*`
  columns on `DuplicateRules`, `FieldPropertyProfiles.sequence`, and on `WorkflowRules` the
  `conditions : LargeString` column plus the whole `conditionRows`/`WorkflowRuleConditions` composition.
  **Never delete these; never "revive" them either.**
- **Half a mechanism nobody calls is what the next person mistakes for a working one.** Withdrawn
  client-side code is deleted, not left dormant. A *read* path is kept where stored data may still be in
  the old shape (e.g. `srv/checks/value-lists.js` still parses `BE|NL` delimited lists).
- **A requester never reads "you could have X if you filled in Y."** A derivation that cannot fire for
  want of an input says nothing. Two exceptions that do speak: a result that is only partial ("this
  country has 5 tax categories, one row is proposed"), and settings that could not be read.
- **The client MUST NOT name the role a write is judged under.** `requesterContext(req)` hardcodes
  `Requester` on every write path. The *screen's* own role is trusted only for rendering decisions and
  for what a proposal may offer.
- **Bump versions on every deploy** — `version` in `mta.yaml` and `sap.app.applicationVersion.version`
  in each UI app's manifest. Several artifacts have shipped under one number, which makes deploy logs
  and `cf html5-list` useless.
- **Never commit S/4 or BPA credentials** into `mta.yaml`, `.cdsrc-private.json`, or source.

## Where things are

| Path | What |
| --- | --- |
| `srv/business-partner-service.*` | The S/4 facade, maintenance config, search, assistant. One file by design. |
| `srv/change-request-service.*` | Staging: submit, resubmit, decide, rework, data steward. Never talks to S/4 itself. |
| `srv/checks/` | The validate → derive → duplicate pipeline and every stage in it. |
| `srv/ai/` | AI Core orchestration, registry (VIES/GLEIF), duplicate engine. |
| `srv/wf/` | SBPA connection, approver resolution, BTP Authorization Management reads. |
| `db/staging.cds` | `ChangeRequests` + one `Staged*` node per section, findings, comments. |
| `db/{quality,duplicate,workflow}-rules.cds`, `db/field-properties.cds` | The steward-configured tables. |
| `app/reuse/` | The shared maintenance screen. Copied into the two consumers at build time. |
| `app/mdmrules/` | The MDM Configuration Panel tile (five rule pages). |
| `app/bptask/` | The My Inbox task UI. |
| `abap/`, `mdmlbpcheck/`, `odatacr/` | S/4-side services and their READMEs. |

## Rule files

| Read this | Before touching |
| --- | --- |
| `.claude/rules/architecture.md` | `srv/**`, `srv/external/**`, `abap/**`, `app/businesspartner/**` |
| `.claude/rules/staging.md` | `db/staging.cds`, `srv/change-request-service.*`, `srv/search-results.js` |
| `.claude/rules/checks.md` | `srv/checks/**`, `srv/ai/registry.js` |
| `.claude/rules/rule-tiles.md` | `app/mdmrules/**`, `srv/duplicate-config-service.*`, `srv/checks/rule-engine.js` |
| `.claude/rules/field-properties.md` | `db/field-properties.cds`, `srv/checks/field-propert*` |
| `.claude/rules/workflow.md` | `srv/wf/**`, `db/workflow-rules.cds` |
| `.claude/rules/task-app.md` | `app/bptask/**`, and the SBPA wire contract |
| `.claude/rules/maintenance-screen.md` | `app/reuse/**` |
| `.claude/rules/ai.md` | `srv/ai/**` |
| `.claude/rules/deployment.md` | `mta.yaml`, `tools/**`, any `xs-app.json` |

## Ask before doing

Decisions that are open, or that cost more than they look. Do not settle one by writing code.

- **Staging retention after posting** — deleting the header would destroy the `postedBP` idempotency
  guard against SBPA retries.
- **Routing edit/change requests through staging** — only create is redirected today.
- **`sourceETag` is never set**, so a request approved days later overwrites concurrent S/4 changes.
- **`completeRequest` has no scope restriction** and writes to S/4 — restrict it to the SBPA technical
  user before this goes anywhere real. Same class: nothing authorises `getRequestPayload`.
- **Human-readable CR numbers** (asked, not built) — **do not change the key**; the UUID is in the SBPA
  contract and `cds-deploy` refuses to change a key. Build it additively as a display-only
  `changeRequestNumber`. Where the number comes from is undecided.
- **The SBPA contract** in `.claude/rules/task-app.md` — changing any of it breaks Arthur's process
  definition. Agree the change first.
- **Object types beyond the BP** — when MM arrives, **copy** the rule tables rather than adding an
  object-type column.

## Keeping this current

L5 means the map is maintained, not just written.

- A rule file is the place for *why it is this way* and *what breaks if you change it*. Narrative of what
  was tried belongs in git, except where it is a "do not try this again" warning — keep those to a line.
- When a mechanism is reworked, **edit the rule file in the same commit**. A stale rule is worse than a
  missing one because it is trusted.
- **This file stays under 200 lines.** A rule file that grows much past 250 is usually two topics —
  split it and add a router row. The router table is the only thing that has to stay complete.
- Re-read the touched rule file against the code when its area next surprises you; that is the staleness
  check, and it is cheaper than a scheduled review nobody runs.
