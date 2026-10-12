# Workflow rules and SBPA integration

<!-- paths: srv/wf/**, db/workflow-rules.cds, srv/request-processors.js -->

The UI5 task form and the SBPA wire contract are in `task-app.md`.

## Workflow Agent Determination (`db/workflow-rules.cds`)

Produces the ordered **`steps`** plan in the workflow context (2026-10-01); SBPA's step loop walks it.

- **The table decides who, how many steps, their order and their type.** `resolveSteps` returns
  `[{ no, type, step, recipients }]`: `sequence` orders (lowest first), `step` is the type (`Approve` →
  `approve`, `Enrich` → `enrich`, a data steward task), and rows sharing a sequence **and** step merge
  into one task whose `recipients` is a comma list of roles — any of them may take it. A row with no
  sequence keeps one task per role, after the numbered steps, in table order. CAP does not check that a
  role exists — roles live in SBPA and a copy here would go stale.
- **No matching rule falls back per CR type** — `WorkflowFallbacks`, one row per type (no `*`), shown
  under the rules on the same page. A role there becomes one approval step; **an empty role means no
  approval at all**: `submitRequest` starts no workflow and posts straight away (`activateWithoutApproval`,
  `requiredApprovals: 0`). A type with no row routes to `MDM_Light_Admin` (`DEFAULT_FALLBACK_ROLE`), and
  the page's list read seeds the four rows with it — not a CSV, which `cds-deploy` would UPSERT over the
  stewards' edits on every deploy.
- **An unreadable rules or fallback table never reads as "nobody approves".** `routingFor` fails safe to
  `MDM_Light_Admin`; an empty plan only ever comes from a fallback a steward emptied.
- **Seed in the request's own transaction.** A second root transaction (`cds.tx`) deadlocked on the
  re-read that follows every PATCH.
- **Resubmit after rework:** a parked instance walks the plan it was started with, so an empty plan keeps
  the stored one. A request activated without approval has no instance; its resubmit posts again when the
  plan is still empty, and is refused (withdraw and re-raise) when it now needs approval.
- **An entry is a role, never an e-mail address (withdrawn 2026-09-07).** Typing a user's address into
  the cell used to be accepted too — SBPA resolves both, and CAP deliberately did not check that either
  existed — but the working process only routes on roles now, so `validateWorkflowRule` refuses any
  entry containing `@` outright rather than passing it on. `resolveApprovers` returns `{ step, value }`;
  the cell still takes typing *and* offers a value help, because a role has to be spelled exactly as
  SBPA knows it. The condition cells deliberately do not get it.
- **Rows are additive** — every matching row contributes. **Several roles means several rows**;
  `resolveApprovers` (the legacy flat `approvers` key, Approve rows only) de-duplicates on step + value.
- **All four CR types plus `*` ("Any").** Unlike the field property profiles' closed list this table
  offers `block`/`delete`, because saying who approves one early is harmless. `*` is an explicit value a
  steward picks, and a `*` rule and a specific-type rule both contribute.
- **Without an `Enrich` row there is no steward step.** Before the plan, every request went past every
  DataSteward role collection (`datastewards`); now only the table puts a steward in the chain.
- **The resolvers' empty answer is legitimate** — no rule matched, empty table, or unreadable: all `[]`.
  `routingFor`, which routing reads, is the exception: it never answers `[]` for an unreadable table.
- **Resolved in `workflowContext()`**, after the validations and the duplicate gate, and rebuilt after a
  rework so a resubmit routes on the payload the requester fixed.

## The approver picker (`srv/wf/btp-agents.js`)

The subaccount's own **role collections**, read live from the BTP Authorization Management API — not
this app's `ROLES` list, which is a different question. `workflowAgents()` itself still reads **users**
too and returns both (`{ type: 'Role'|'User', value }[]`) — it is shared infrastructure, also behind the
`RequestedByUsers` value help and `specificRoleFor`'s role disambiguation (`field-properties.md`) — but
`duplicate-config-service.js`'s `workflowRuleOptions` filters the result to `type === 'Role'` before
serving it to the Workflow Agent Determination picker, which is where users stopped being offered.

- Role collections are filtered to those whose **Description** starts with `MDMLIGHT` — **Description,
  never Name**: the prefix is a convention applied to text an admin writes. Users are named by e-mail.
- **A second, separate XSUAA instance**: `mdm-businesspartner-authmgmt` (plan `apiaccess`), because the
  app's own `mdm-businesspartner-auth` (plan `application`) has no access to that API. Its key carries
  `clientid`/`clientsecret`/`url` plus **`apiurl`** — a fixed region-wide address, not this tenant's
  login URL; `btp-agents.js` refuses to guess one when it is missing. Being a **managed** service its
  credentials land under VCAP's `xsuaa` group, not `user-provided`.
- A broad, subaccount-wide read credential; `btp-agents.js` is the only module that ever sees it.
- Best-effort, cached 5 minutes. The two lookups fail independently.
- **One cached `/Users` read serves all three readers** (`allUsers`, same TTL, in-flight de-duplicated).
  `specificRoleFor` runs on every render and every Check press through `resolveEffectiveRole` — and
  twice per open on the data steward screen, which checks itself on load — and used to fetch the whole
  subaccount each time. A failed read is not cached; `force` threads down so a forced refresh is not
  served the cache it asked to bypass.
- **The F4 dialog is a real table**, not `sap.m.SelectDialog` — that control wraps a plain `sap.m.List`
  with no column headers. It was a two-column *Type* vs *Name / E-mail* table until 2026-09-07, when it
  still had to make that distinction visible for a combined role-and-user picker; now that the picker is
  role-only it is a single `Role` column.

**Two BTP API facts, live-tested rather than assumed:**
`GET /sap/rest/authorization/v2/rolecollections` already returns each collection's roles inline as
**`roleReferences`** — there is no detail call, and `detail.roles` does not exist. And
`GET .../users/{name}/rolecollections` answers empty for a user confirmed to be in two collections;
`GET /Users` returns membership inline as **`groups`**. `test/data-stewards.test.js` pins both shapes.

## SBPA connection

`srv/wf/processAutomation.js` talks to SAP Build Process Automation through the `SBPA_DESTINATION` CDS
requires entry. It gets an OAuth2 client-credentials token from the `mdmlight-bpa-uaa` user-provided
service (cached until near expiry) and an API key, then POSTs a workflow-instance start.

**Known bug, not fixed:** it reads `apiKey` from `mdmlight-bpa-uaa`, which holds
`clientid`/`clientsecret`/`url`. `mdmlight-bpa-key` is bound and never read, so `irpa-api-key` goes out
`undefined` and the workflow start fails. Because `submitRequest` deliberately leaves a request in
`draft` when the workflow will not start, the symptom is staging rows at `draft` with no approver task —
that is the guard working. **Confirm with Arthur which service holds the key.**

## Decide and post

- **`decideRequest` records an outcome and, on approve, creates the business partner.** It writes
  `approved` first, then posts: success → `posted` with the number; failure → `reworkRequired` with the
  reason in `postError` and in `ErrorMessage`. `reject` → `reworkRequired`. It is not terminal.
- **`completeRequest` is the same step for SBPA's callback**, made a no-op by its `postedBP` guard once
  approve has run. **Both entry points call one `postAndRecord`.**
- Individual approvals are not stored anywhere in CAP, by decision.

Three traps found wiring this, all still load-bearing:

- **A status write immediately before `req.reject` never persists** — `req.reject` throws and CAP rolls
  the transaction back. That is why a failed post is **returned** as `ErrorMessage` with
  `Status: reworkRequired` rather than rejecting the action.
- **A partial post must not create a second partner.** `postToS4` persists the number the moment S/4
  hands it over — before the child nodes, which can still throw.
- **…nor re-create a child node S/4 already has.** `postToS4` flips a created row's own `action` to
  `'U'` right after the save, and removes a deleted row from staging entirely.
- `completeRequest` once threw a ReferenceError on every completion by calling `notifyWorkflow`, a
  `const` declared inside the `decideRequest` handler. `test/approve-posts.test.js` pins the scope.

**Signalling the outcome.** The parked instance is told the result through its own trigger,
`waitForResult`, whose inputs are exactly `businesspartnerid`, `businesspartnerfullname`, `status` and
`errormessage`. It has no `result` key, so it cannot go through `sendTrigger` — `triggerPostResult`
posts it through the same destination. `SignalWorkflow: false` deliberately does **not** silence this:
the decision and the result are different waits. Best-effort.

## Several approvers, sequentially — CAP counts, not the client

BPA routes through multiple approver tasks in order; CAP's job ends at sending the ordered `approvers`
array once at submit. **What decides whether an approve actually posts to S/4 lives entirely in CAP.**

- `ChangeRequests` carries `requiredApprovals`/`approvalsReceived`, which since 2026-10-01 count
  **steps of every type**, not approvals. Set to (`context.steps.length`, `0`) by `submitRequest` and
  `resubmitRequest`. Null on an older request reads as 1.
- **`approverSequenceJson` stores the `steps` plan itself** (an array of objects). `currentStepAssignee`
  returns the current entry's `recipients`, and `resolveEffectiveRole` checks each of its comma-separated
  roles. An array of plain strings is a request from before the plan — `stepPlanOf` answers null for it.
- **A planned steward step advances the plan.** `decideDataStewardReview`'s `complete` increments
  `approvalsReceived` and, when that reaches `requiredApprovals`, posts through `postAndRecord` exactly as
  the last approve does — **the last step activates, whatever its type**. A legacy request
  (`stepPlanOf` null) keeps the old fresh-cycle reset, so an instance still on the old process definition
  is not posted early on cut-over day.
- **`decideRequest`'s approve branch increments and persists `approvalsReceived` on every single call**,
  before anything else — `appendComment` runs for every approval, so the thread shows who decided at each
  step. Only once `approvalsReceived >= requiredApprovals` does the post path run. Every earlier
  approval returns `Status: 'inApproval'`, `BusinessPartner: null`, and the two counts.
- **This replaced a client-side design that broke silently.** `_isFinalApprover` read two optional task
  inputs (`currentapprover`/`totalapprovers`) off the BPA task context and skipped `_decideOnServer`
  unless final. Those inputs depended on the Lobby being re-pointed at a task-form version declaring
  them; the version was raised then reverted the same day, so they never arrived, every approver read as
  the only one, and the **first** approval of every chain posted the partner. **Both are now gone** —
  not left dormant.
- **Reject is never gated** — a chain of approvals is not a chain of independent decisions.
  `decideRequest`'s reject branch runs first, before any counting.
- **Accepted, not solved:** two decisions for the same approver arriving concurrently could double-count
  `approvalsReceived`, because nothing here identifies WHO is deciding. No worse than the trust
  `postedBP`'s idempotency guard already extends to the final step.
- **`app/bptask`'s version is NOT bumped on a deploy** — the one exception to the bump-on-every-deploy
  standing rule. It is an address the Lobby resolves, so raising it strands the User Task until
  somebody re-points it by hand; 1.6.0 was raised and reverted the same day for exactly that. It was
  held at 1.5.0 through the 2026-09-02 multiple-approver fix (removing inputs the form no longer reads
  is backwards-compatible) and **raised to 1.8.0 on 2026-09-04, agreed with Arthur first**. The
  **deploy** is what makes fixed `Component.js` or `app/reuse` code run, not the number.
  `test/task-form.test.js` pins the current value and records why each move happened — read it there
  rather than trusting a number quoted here.

## Rework — the requester's screen

A rejection is a **loop, not an end**. `ChangeRequests/{id}/rework` renders the same maintenance screen
in mode `rework` — the draft view with **Resubmit** as the primary action and Withdraw beside it.
`state.mode` is what `onSave` routes on.

- **Two entry points**: the `reworkurl` deep link and a My Inbox task whose input carries
  `tasktype: "rework"`. A task with no `tasktype` opens the approver's screen. The screen must cope with
  a link opened twice.
- **My Inbox does not render an embedded app's `sap.m.Page` footer at all.** Anything pressable on a task
  goes in the header actions or through `inboxAPI.addAction`.
  - **Check/Duplicate Check live in the object page header actions regardless of `env>/embedded`** — on
    a long create form the footer is a scroll away from the fields being filled in.
  - **Resubmit/Withdraw go through `inboxAPI.addAction`**, the same native bar as Approve/Reject.
    Pressing one publishes on the `"taskform"` event-bus channel; the shared controller runs the real
    `onSave`/`onWithdraw` flow, and the task completes only after that succeeds.
- **Resubmit resumes, it does not restart.** The instance stays parked and `resubmitRequest` signals it
  with `RESUBMITTED_SIGNAL`. A request with no `processInstanceId` is refused rather than given a fresh
  workflow, which would hand it two audit threads. **A failed signal no longer blocks the resubmit** —
  it fails even for valid reworks because the parked instance is not waiting on `requesterCallBack`,
  which is a BPA-side gap. What resumes the process is the rework **task completing**.
- **Resubmit runs every gate a first submit runs.** Derivations still do not run on a submit path.
- **The approver's comment goes to `rejectionComment`, never over `reason`** — the requester would
  otherwise find their own justification replaced by the verdict on it. The strip **points at the
  conversation panel** rather than repeating the text.
- **Comment boxes**: `approverCommentBox` is embedded-only; `reworkCommentBox` and
  `dataStewardCommentBox` bind to `maintenance>/…` and work standalone. All three sit **right after the
  conversation panel** — at the bottom of the content they were cut off.
- **The full conversation, not just the latest word.** `ChangeRequestComments` is append-only, returned
  as `CommentsJson`, rendered oldest first on every mode with a thread, and it is the **last** panel
  above the form.
- **`claimRework` is a stopgap for the missing reject callback.** SBPA notifies the requester and never
  calls `decideRequest`, so the request is still `inApproval` when the rework screen opens. It moves
  `inApproval` → `reworkRequired` **on the rework route only**, treating arrival as the evidence. No-op
  on any other status, refuses a request carrying `postedBP`, sends **no** workflow signal. **Accepted
  cost:** clicking the mailbox link again after a resubmit pulls a live approval back into rework.
  **Delete the handler, the controller call and their tests once Arthur's rejection branch calls
  `decideRequest`.**
- **No Save Request in rework**: it drops the screen out of editing and offers Edit, which re-enters
  `edit` mode, and `onSave` would then route to `submitRequest`, starting a second workflow.

**Withdraw deletes.** `withdrawRequest` removes the staged children explicitly then the header, rather
than trusting the compositions' cascade through the hand-written `ON` backlinks. Two load-bearing
guards: a request carrying `postedBP` can never be withdrawn, and only `draft`/`reworkRequired` are
withdrawable. **Idempotent** — a missing request returns `Deleted: false`, not a 404.

## Data steward enrichment

A third loop, parallel to rework: a steward is handed a request mid-approval to add or correct data,
then sends it back — to the approver if they made it work, to the requester if not.

- **`claimDataStewardReview` is `claimRework`'s pattern**: arrival moves `inApproval` → `checkAndEnrich`,
  no signal sent.
- **`decideDataStewardReview` is two existing shapes under one action.** `'complete'` is
  **`resubmitRequest`'s gates**, then the step counting above; `'reject'` is **`decideRequest`'s reject
  branch** — straight to `reworkRequired` with the steward's note, back to the requester.
- **Both handlers are placed after `withdrawRequest`**, not beside `claimRework`: several tests slice
  `serviceJs` from `resubmitRequest` to `withdrawRequest` expecting an exact shape.
- Two signals, `DataStewardComplete`/`DataStewardRejected`, are **unconfirmed placeholders**.
- The screen is the same shared screen in a fourth mode (`"datasteward"`). Editable like rework but with
  both save buttons false — only the two decision buttons. The field property profile is read under
  `DataSteward`.
- **Outcome ids are `"enrich"` and `"reject"`.** `sap.bpa.task.outcomes` is one flat array and an id
  only has to be unique **within** it: two branches both register `"reject"` with their own callbacks,
  safe because `_initTaskForm` picks exactly one branch per task.
- **The step loop routes steward tasks from the plan** (`enrich` steps). `claimDataStewardReview` still
  moves the status on arrival; the loop sends nothing CAP waits on.

## `datastewards` and `approvers` on the wire

`workflowContext` sends **`approvers` as a flat array of strings**, not the structured list
`resolveApprovers` returns — the deployed process declares an array of strings and the runtime
validates, so sending objects failed **every submit**. The `.map` sits in `workflowContext` and nowhere
else. What is genuinely lost is `step`; restoring it is a process-side schema change, **not** a
one-sided fix here.

**Role names are sent unresolved**, and so are `datastewards`. This is true only because **Arthur's
process resolves BTP role collection membership itself.** Do not read it as a general rule: if a process
that does not is swapped in, this reverts to expanding them via `emailsForRoleCollections`. The tell is
a task landing with an approver list of one unresolvable string. `srv/wf/data-stewards.js` genuinely
needs both shapes, permanently: `dataStewardEmails` for the human-readable strip, `dataStewardRoles` for
the wire — separate cached functions, not one with a flag.

**Still open:** wiring SBPA to actually consume `approvers` — Arthur's definition ignores the field, so
the table is inert until his process assigns its approver task from it.
