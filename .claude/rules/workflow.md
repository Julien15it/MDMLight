# Workflow rules and SBPA integration

<!-- paths: srv/wf/**, db/workflow-rules.cds, srv/request-processors.js -->

The UI5 task form and the SBPA wire contract are in `task-app.md`.

## Workflow Agent Determination (`db/workflow-rules.cds`)

Produces the `approvers` list in the workflow context; SBPA routes on it.

- **The table decides WHO, never how many approvals or in what order.** CAP does not check that a role
  exists — roles live in SBPA and a copy here would go stale.
- **An entry carrying an `@` is a user, anything else a role.** `resolveApprovers` returns
  `{ step, kind, value }`. The two halves are entered differently on purpose: an address is free text, a
  role has to be spelled as SBPA knows it, so the cell takes typing *and* offers a value help. The
  condition cells deliberately do not get it.
- **Rows are additive** — every matching row contributes, nothing needs ranking, no order column.
  **Several approvers means several rows**; `resolveApprovers` de-duplicates on step + value.
- **All four CR types plus `*` ("Any").** Unlike the field property profiles' closed list this table
  offers `block`/`delete`, because saying who approves one early is harmless. `*` is an explicit value a
  steward picks, and a `*` rule and a specific-type rule both contribute.
- **`step` carries only `Approve`** — a column rather than an assumption.
- **Empty is a legitimate answer** — no rule matched, empty table, or unreadable: all `[]`.
- **Resolved in `workflowContext()`**, after the validations and the duplicate gate, and rebuilt after a
  rework so a resubmit routes on the payload the requester fixed.

## The approver picker (`srv/wf/btp-agents.js`)

The subaccount's own **role collections** and **users**, read live from the BTP Authorization Management
API — not this app's `ROLES` list, which is a different question.

- Role collections are filtered to those whose **Description** starts with `MDMLIGHT` — **Description,
  never Name**: the prefix is a convention applied to text an admin writes. Users are named by e-mail.
- **A second, separate XSUAA instance**: `mdm-businesspartner-authmgmt` (plan `apiaccess`), because the
  app's own `mdm-businesspartner-auth` (plan `application`) has no access to that API. Its key carries
  `clientid`/`clientsecret`/`url` plus **`apiurl`** — a fixed region-wide address, not this tenant's
  login URL; `btp-agents.js` refuses to guess one when it is missing. Being a **managed** service its
  credentials land under VCAP's `xsuaa` group, not `user-provided`.
- A broad, subaccount-wide read credential; `btp-agents.js` is the only module that ever sees it.
- Best-effort, cached 5 minutes. The two lookups fail independently.
- **The F4 dialog is a real two-column table**, not `sap.m.SelectDialog` — that control wraps a plain
  `sap.m.List` with no column headers, and *Type* vs *Name / E-mail* is exactly the distinction a
  combined picker must make visible.

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

- `ChangeRequests` carries `requiredApprovals`/`approvalsReceived`. Set together, always to
  (`context.approvers.length`, `0`), at the three places a request enters `inApproval`: `submitRequest`,
  `resubmitRequest`, and `decideDataStewardReview`'s `complete` branch — a fresh cycle always gets a
  freshly counted total, because a reworked payload can change WHO matches a rule. Null on an older
  request reads as 1.
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
- **`app/bptask` stays at 1.5.0 through this**, deliberately: removing inputs the form no longer reads
  is backwards-compatible, and the version is an address the Lobby resolves — raising it strands the
  User Task until somebody re-points it by hand. 1.6.0 was raised and reverted the same day for that
  reason. The **deploy** is still what makes the fixed `Component.js` run. This is the one exception to
  the bump-on-every-deploy standing rule; `test/task-form.test.js` pins the number and says why.

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
  **`resubmitRequest`'s body**; `'reject'` is **`decideRequest`'s reject branch** — straight to
  `reworkRequired` with the steward's note, back to the requester, never to the approver.
- **Both handlers are placed after `withdrawRequest`**, not beside `claimRework`: several tests slice
  `serviceJs` from `resubmitRequest` to `withdrawRequest` expecting an exact shape.
- Two signals, `DataStewardComplete`/`DataStewardRejected`, are **unconfirmed placeholders**.
- The screen is the same shared screen in a fourth mode (`"datasteward"`). Editable like rework but with
  both save buttons false — only the two decision buttons. The field property profile is read under
  `DataSteward`.
- **Outcome ids are `"enrich"` and `"reject"`.** `sap.bpa.task.outcomes` is one flat array and an id
  only has to be unique **within** it: two branches both register `"reject"` with their own callbacks,
  safe because `_initTaskForm` picks exactly one branch per task.
- **Nothing on Arthur's side routes a task to a data steward yet.**

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

**`criticalfield`** (lowercase on the wire; the local variable stays `criticalField`) is a **scalar
`'X'`/`' '`**, never a list. `workflowContext` answers one question: does this request fill in **any**
entity a **Requester-scoped** profile marks critical? SBPA is told *that*, never *which* — the "⚠" is
where a human sees that.

**Still open:** wiring SBPA to actually consume `approvers` — Arthur's definition ignores the field, so
the table is inert until his process assigns its approver task from it.
