# Field property profiles

<!-- paths: db/field-properties.cds, srv/checks/field-properties.js, srv/checks/field-property-store.js, app/mdmrules/webapp/ext/controller/FieldPropertyProfileList.controller.js -->

A profile says what a request may, must and must not show: **mandatory, read-only, hidden or optional**,
per entity and per field. Conditions are two dropdowns on the profile row — **CR type** and **role**,
both taking `*`. Content lives behind **Modify**: a dialog listing every entity, expandable to its
fields, four checkboxes on both levels.

- **One state per target, not four flags.** The boxes behave as a radio group; the stored row carries a
  single `property`, so nothing downstream resolves a contradiction that should never have been
  storable (`hidden`+`mandatory` is unsubmittable, `readOnly`+`mandatory` only a derivation could
  satisfy).
- **Absent is not `optional`.** A field with no row is not mentioned; `optional` is an explicit
  override, which is what lets a narrow profile hand a field back after a broader one made it mandatory.
- **The dialog replaces the whole profile** (`saveFieldProperties` deletes and rewrites). An unknown
  entity, field or property is **refused**, not filtered.
- **The entity/field tree is generated** from `payloadFields()`. The condition lists are closed and
  served from the same module.
- **Modify saves the profile first** — settings hang off a saved profile.

## Applying them

**Where two profiles match, the broadest result wins** — a **join over three axes** (visible / editable
/ required), not a ranking, because `mandatory` and `readOnly` are not comparable. Visible or editable
if **any** matching profile allows it; required only if **every** profile that speaks demands it.

| Profile 1 | Profile 2 | Result |
| --- | --- | --- |
| hidden | readOnly | readOnly |
| mandatory | readOnly | **optional** |
| mandatory | optional | optional |
| hidden | mandatory | optional |

`PROPERTY_STATE` is the whole rule and the join is closed over the four names
(`test/field-property-apply.test.js` proves it exhaustively). **Nothing reads a precedence** — no Order
cell, and the resolver never sorts. **Silence is not `optional`**: a profile saying nothing about a
target is left out of the join entirely.

**Only `hidden` and `readOnly` cascade from an entity to its fields** — they describe the container. An
entity's `mandatory` is about whether it needs a **row** at all.

Two halves, deliberately not one code path:

- **Rendering** — `effectiveFieldProperties(RequestType, Role)`, loaded by the maintenance controller
  **before the first render** (rendering is synchronous; a field painted and then taken away is worse
  than one never drawn). `hidden` drops the field from both layouts and a hidden entity hides its whole
  `ObjectPageSection`. `readOnly` takes editability away and can never grant it. `hidden` is
  deliberately honoured on the approve view — once approvals are split by function, a sales approver has
  no business reading bank details.
- **Enforcement** — `createFieldPropertyStages` adds a `field_properties` validation to Check, Duplicate
  Check, submit and resubmit, reading the cascade back first. Without it a profile is a star on a label
  a direct service call walks past. It runs on `requesterContext(req)`, always `Requester`, and is the
  security-relevant half.

**"Both layouts" includes the section's own summary table**, not just the record dialogs: `_renderSection`
filters `_summaryFields` through `_isHiddenField` the same way the grid and table builders do, so a
hidden field is gone from the column list, the cells and the search.

## Roles are BTP role collections, by naming convention

A profile's role is one of `*`, `Requester` (the only two non-role-collection concepts left in
`ROLES`/`ROLE_TEXT`), or a BTP role collection name.

- The picker sources from `workflowAgents()` filtered to `type === 'Role'` — a profile's role condition
  is about an actor kind, so users stay out of this picker. **The bare `MDMLIGHT` collection is excluded
  here only** (it is the catalog-level role for the whole app; offering it would scope a profile to
  "everyone with any access" while looking like a narrow choice).
- **A role matches the screen's category case-insensitively, by `includes`, checked BIDIRECTIONALLY**
  (`profileMatches`). `ApproverSales` counts as an Approver-category profile, and once the screen
  resolves a *specific* role the bare category must still match it, while two different specific roles
  stay apart. `LEGACY_ROLES` (`['Approver', 'DataSteward']`) keeps the write guard accepting values
  stored before this; an exact match is checked before the substring test. **`includes`, not
  `startsWith` (fixed 2026-09-04, same bug and same fix as `specificRoleFor` below): this app's own
  role collections put the function BEFORE the category (`MDMLIGHT_Sales_Approver`), so the category
  is a SUFFIX, not a prefix, and a bare `Approver`-scoped profile has no `startsWith` relationship to
  it at all.** Went unnoticed for as long as `resolveEffectiveRole` itself so often fell back to the
  bare category that the exact-match branch quietly covered for it — the `specificrole` task input
  (`task-app.md`) closed that resolution gap and is what exposed this one: profiles stopped applying
  to any approver the moment the resolved role reliably became the real collection name.
- **Rendering is narrowed to the caller's own specific role.** `resolveEffectiveRole` resolves
  `Approver`/`DataSteward` to the caller's own collection via `specificRoleFor(email, category)` before
  `effectiveFieldProperties` runs — without this, `Approver Customer` (hides Suppliers) and `Approver
  Vendor` (hides Customers) both matched every approve screen and the join landed on "visible for both,
  for everyone". **Ambiguous resolves to null, not a guess**, falling back to the bare category.
  Best-effort. **Only the rendering path** — enforcement still runs on `requesterContext(req)`.
- **`specificRoleFor` matches the category `includes`, not `startsWith` (fixed 2026-09-02, reported
  live: field property profiles never applied to ANY approver).** This app's own role collections put
  the function BEFORE the category (`MDMLIGHT_Sales_Approver` — see the `workflowAgents` test fixture),
  so a prefix check never matched a real one: every user resolved to null, every render fell back to
  the bare `Approver` category, and a profile scoped to that same collection's own name could never
  match it back either. `includes` is a strict superset of the old behaviour.
- **Disambiguating a user with SEVERAL approver-shaped roles (2026-09-02, asked for): "is it this
  request's turn for this user", not "which of their roles looks closest".** `specificRoleFor` returns
  null on purpose when a user holds more than one role matching the category — it cannot guess between
  "Approver Sales" and "Approver Finance". `resolveEffectiveRole(req, role, header)` now tries
  `currentStepAssignee(header)` FIRST: `ChangeRequests.approverSequenceJson` (the same ordered
  `approvers` array BPA got at submit — see "Several approvers, sequentially" in `workflow.md`) indexed
  by `approvalsReceived`, the same index BPA's own routing script advances. If that entry names THIS
  user (an exact email match, or `isMemberOfRole` for a role entry — a plain yes/no BTP membership
  check, unlike `specificRoleFor`'s "find the one" search), it wins outright; otherwise this falls
  through to the role-only resolution above, unchanged. `effectiveFieldProperties` and
  `runRequestChecks` both now read the header first (`ChangeRequest` was added as a parameter to the
  former for this) and pass it through. No header (a create draft) or no stored sequence (a request
  predating the column) skips straight to the old resolution.

## Critical entities

- **Critical is entity-level only.** `validateSetting` refuses a row carrying both `element` and
  `critical: true`; the dialog greys the box on a field row and `onCriticalSelect` guards it again.
  `resolveProfiles` still *reads* an older field-level row rather than dropping it, and `_buildTree`
  never carries one back, so such a profile self-migrates on the next Apply.
- **Critical is a marker, not a gate.** `createFieldPropertyStages` enforces `mandatory` only; a first
  version that blocked an empty critical entity was rejected.
- **Drawn on the screen, not written as a message** — `_isCriticalEntity` reads `criticalEntities` off
  the already-loaded properties and `_markSectionCritical` appends "⚠" to the section title. Applied in
  `_renderSection` for the nine node sections and in `_renderRootForm`/`_renderRootSection` for the two
  cards the root splits into.
- **Critical is Requester-scoped and reflected read-only everywhere else.** A request carries one set of
  critical entities for its lifetime, decided by whoever files it. `resolveProfiles` computes it from a
  **separate** matching set, re-running `profileMatches` against `role: 'Requester'`, independent of the
  caller's own role. The Modify dialog computes `canEditCritical = !role || role === "*" || role ===
  "Requester"`, guards both the checkbox binding and `onCriticalSelect` with it, and `_settingsFromTree`
  multiplies every `critical` it sends by that flag — **Apply on an Approver profile must not copy the
  Requester profile's flag into it.** Other roles' dialogs still SHOW the box, disabled.
- `field-property-store.js` caches profiles for 60s, dropped on any write.
- **Watch the read column lists.** The Critical checkbox silently stopped saving because
  `fieldPropertiesOf`'s SELECT omitted `critical` — the save side had always been correct.
