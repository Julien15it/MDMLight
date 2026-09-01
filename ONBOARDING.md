# MDM Light — Business Partner Manage

## What this is

A CAP (Node.js) + SAP Fiori Elements (OData V4) recreation of the standard SAP app
`mdm.md.businesspartner.manage` (F3163). It is **not** a local business-partner database — the CAP
service is a live facade in front of an S/4HANA system's OData V2 `API_BUSINESS_PARTNER` service.
Deletion of Business Partners is deliberately disabled throughout.

Reads are pure facade (live pass-through to S/4). **Creates and changes are not** — they are staged
in PostgreSQL and only posted to S/4 once an approver accepts them. That approve-then-create
workflow, backed by SAP Build Process Automation (SBPA), is the load-bearing design of this whole
project; almost every non-trivial decision in the codebase traces back to it.

## Who is who

- **Julien Compernolle** (julien.compernolle@alluvion.eu) — drives most of the day-to-day
  requests and fixes in this repo.
- **Maarten** — the other main stakeholder who asks for and reviews features (referenced
  throughout the codebase's own commentary).
- **Arthur** — owns the SBPA/BPA workflow process definition on the other side of the integration.
  A number of features in CAP are "built and waiting" for a corresponding change on his side.
- Several developers push to `main` in the same CF space, so deploy failures are often someone
  else's build in flight, not a bug — see "Working alongside the other developers" in `CLAUDE.md`.

## The three apps, one backend

- **`app/businesspartner`** — the main Fiori Elements List Report / Object Page (Work Zone tile).
  Create, edit, change requests.
- **`app/mdmrules`** — the "MDM Configuration Panel" tile: five rule tables a data steward
  configures (Duplicate Check, Validation, Field Properties, Derivation, Workflow Agent
  Determination).
- **`app/bptask`** — the My Inbox task UI (approve / rework / data-steward-review), a freestyle
  UI5 app because Fiori Elements is not a supported My Inbox task-form host.

All three share one CAP service (`srv/`) and one PostgreSQL staging schema, and two of them
(`businesspartner`, `bptask`) share the actual maintenance *screen* itself — it lives in
`app/reuse` and is copied into both consumers at build time, not deployed as a library.

## The approval flow, in one paragraph

A requester fills in the maintenance screen and presses **Submit Request** (or **Save Request** for
a draft). That stages the data and starts an SBPA workflow instance. An approver gets a task in My
Inbox, opens the *same* screen read-only, and Approves or Rejects. Approve creates the Business
Partner in S/4 for real; reject sends it back to the requester as **Rework**, looping until it is
resubmitted or withdrawn. A **data steward** can also be pulled in mid-flight to fix data the
requester couldn't. Every step re-runs validations (and, on Submit/Resubmit, the same
derivation/proposal check the Check button runs) so nothing reaches an approver — or S/4 — that
would immediately fail.

## Where the real depth lives

**`CLAUDE.md`** (checked into the repo root) is the living, detailed engineering log for this
project — every non-obvious architectural decision, every bug that was found and fixed, every
"we tried X, it broke, here's why, here's what we did instead." It is long (~4,000 lines) by
design: it is written *for* whichever engineer or Claude instance opens this repo next, so they
don't have to rediscover a trap someone already fell into. Any Claude Code session opened in this
repository reads it automatically as part of its own context — that is the actual mechanism for
"another Claude knowing what this one knows," more reliable than any chat-transcript export could
be, because it is versioned, reviewed, and kept current by every session that touches the code.

Skim `CLAUDE.md`'s section headers for an index of everything that has been built; read a specific
section in full before touching the area it covers.

## Recently active areas (as of 2026-08-31)

- **Automatic re-check on Submit/Resubmit/Approve**, including S/4 standard-check findings now
  genuinely blocking those actions (not just displaying a strip) — see "Gating derivations by
  role/field property, and re-validating at every gate" and its follow-up sections in `CLAUDE.md`.
- **A partial-post retry bug**: an approve that half-succeeded (some child records created, one
  failed) used to replay a duplicate CREATE on retry for every node that had already gone through.
  Fixed by marking a successfully-created row's own `action` column immediately.
- **The "Changed Fields" summary panel's row-matching** — was pairing rows by array order in a
  fallback path, which could misattribute a change to the wrong row. Now uses best-match pairing.
- **A save race on the MDM Configuration Panel's rule pages** — `submitBatch()` could resolve
  before a freshly created row had actually finished being created, making the first Save after
  Add Rule falsely report failure.

## Commands

See `CLAUDE.md`'s own "Commands" section for the full, current list (root CAP service, each of the
three UI apps, and deployment). The short version: `npm test` runs the whole test suite (1,100+
tests, all source-pinned or logic-level — no live S/4/BTP connection needed to run them), `npm run
build` compiles the CAP model, and `mbt build` / `cf deploy` build and ship the full multi-target
application.
