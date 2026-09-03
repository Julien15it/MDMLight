# The task app (`app/bptask`) and the SBPA contract

<!-- paths: app/bptask/** -->

The CAP side of the workflow is in `workflow.md`.

Freestyle UI5, `sap.app.id` `mdm.md.businesspartner.task`, shared `sap.cloud.service`, its own
`xs-app.json`. It used to be the Fiori Elements app with `sap.bpa.task` in its manifest; SAP documents
UI5 task UIs for **freestyle** apps only. It declares **no `crossNavigation` inbound**, deliberately —
My Inbox resolves a task UI by `sap.cloud.service` + `sap.app.id`, so the one-inbound-per-app limit never
applies and it needs no tile, catalog or role.

- **Outcome labels are literal text, not `{{…}}` keys** — `{{Approve}}` resolves out of the app's own
  i18n bundle, which is not where the Lobby looks. `inputs`/`outputs` declare the task context for the
  Lobby; the runtime reads none of it.
- **Re-pointing the user task in the Lobby is a manual step** whenever the app id changes.
- **Never put a comment key in `app/businesspartner/xs-app.json`** — it is schema-validated in the HTML5
  repository, and an unknown property makes the whole app version unservable: every resource returns
  **500** and the app fails with `adding element with duplicate id '<app id>-content'`.
- **`app/businesspartner/xs-app.json` needs `^/api/(.*)$` as its FIRST route**, to
  `com.sap.spa.processautomation` / endpoint `api`. Without it the form loads and every workflow call
  404s.
- **Verifying `manifest.json` over HTTP proves nothing about what is running.** `build:cf` uses
  `ui5 build preload` and `Component-preload.js` **embeds the manifest**. To test a change, disable the
  browser cache or move the app version.
- **The OData `dataSources` need the DESTINATION SERVICE INSTANCE GUID as a path prefix.** Without the
  leading UUID the approuter cannot tell which destination service instance to resolve
  `mdm-businesspartner-srv-api` from, and `/service/*` answers 500. It is the instance GUID of
  `mdm-businesspartner-destination-service` — **not** a Work Zone content provider id and not the
  app-host GUID. `/api/` never needed it because it resolves a **service**, not a **destination**.
- **The prefix is carried in the TASK CONTEXT, because nothing else can carry it.** `workflowContext()`
  sends `prefix` from `srv/ui-prefix.js`; `_appPath()` composes
  `/{prefix}.{sap.cloud.service}.{sap.app.id}/` in front of the still-relative `dataSources` uri.
  **`manifest.json` declares no OData model.** **Ordering is the design**: `_loadPermissions` and
  `getRouter().initialize()` live in `_begin()`, which runs only once the prefix is known. **A task with
  no `prefix` is reported, never guessed.** Two routes ruled out, recorded so nobody re-runs them:
  deriving it from the component's own load URL (the resource root is versioned and **unprefixed**), and
  routing `/service/*` as a business service (needs a broker `onBind` hook a plain CF app behind a
  destination does not have). Build-time substitution is impossible in one pass: the destination service
  instance is a resource of this same MTA.
- **`app/bptask`'s `dataSources` are ABSOLUTE on that derived path; `app/businesspartner` keeps relative
  uris.** Embedded in My Inbox the app is served from the HTML5 repository at its **version-stamped**
  path where `/service/*` is not proxied, so a relative uri answered 500 without ever reaching CAP. **Do
  not "make them consistent".**
- Completion is `PATCH task-instances/{id}` with `status: COMPLETED`, after fetching an `X-CSRF-Token`.
  **Order matters**: `decideRequest` runs *before* the PATCH, because completing the task resumes the
  workflow. `decideRequest` is passed `SignalWorkflow: false`.
- Embedded, `window.location` is the **host's** — the change request id comes from the task **context**,
  never the hash.
- **A service model is read through `_serviceModel()`, never straight off the view.** The handover calls
  `_loadStagedRequest` from `onInit`, and a view has not inherited its component's models at that point.

Still open, Julien's call: a failed post from My Inbox completes the task anyway.

## Contract the SBPA side depends on

**Changing any of these breaks Arthur's process definition — agree the change first.**

- Approver task URL: `<app-url>#/ChangeRequests/{changeRequestId}/approve`
- Requester rework URL: `<site-url>#BusinessPartner-manage&/ChangeRequests/{id}/rework`
- Data steward review URL: `<site-url>#BusinessPartner-manage&/ChangeRequests/{id}/datasteward`
- **Both deep links are Work Zone intents, not approuter paths.** The base comes from **`WORKZONE_URL`**
  (a literal in `mta.yaml`); `APPROUTER_URL` is deliberately no longer read — it stayed set and kept
  producing the dead standalone host, so unset now yields `''` and a missing link is diagnosable where a
  404 is not. The intent must match the `BusinessPartner-manage` inbound.
- Workflow context at submit: `{ changerequestid, requesttype, businesspartner, emailadressinitiator,
  bpurl, reworkurl, datastewardurl, prefix, businesspartnerinput, bpduplicates, approvers, criticalfield,
  datastewards }`
- **`prefix` must be mapped onto the approval AND rework task inputs.** **An undeclared key never becomes
  task context**, so sending it is not enough — the process definition has to declare and map it.
- Decision callback: `POST /service/changerequest/decideRequest` with
  `{ ChangeRequest, Decision: 'approve'|'reject', Comment }`
- Post trigger: `POST /service/changerequest/completeRequest` with `{ ChangeRequest }`
- Workflow definition ID: `eu10.alluvion-dev-cf.mdmlightapproval.mDM_LIGHT_APPROVAL_WF`
- `businesspartnerinput` is **gone** from the create path — the approve view reads staging.

**Not built on Arthur's side — rework needs three things and the loop does not close without them:**

1. On reject: call `decideRequest` with `Decision: 'reject'` and the comment, notify the requester with
   `reworkurl`, and **do not complete the instance** — park it.
2. Handle the approval-decision trigger input `result: 'Resubmitted'` — **capitalised**, unlike
   `approved`/`rejected` — by routing the request back to the approver. The BP context sits **flat inside
   `inputs`, next to `result`**. `executionId` is the BPA process instance, **not** the change request
   UUID.
3. Handle `result: 'withdrawn'` by terminating the instance and clearing any open approver task.

SBPA calls `decideRequest` on the CAP app directly, not through the approuter. The browser does go
through it, so **any new CAP service path also needs a route in `app/businesspartner/xs-app.json`** —
the catch-all sends anything unmatched to the HTML5 repo, where it 404s instead of erroring usefully.
