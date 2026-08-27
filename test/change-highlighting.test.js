'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const controller = read(
  ROOT, 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'controller',
  'BusinessPartnerMaintenance.controller.js'
);
const view = read(
  ROOT, 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'view',
  'BusinessPartnerMaintenance.view.xml'
);
const css = read(
  ROOT, 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'css', 'maintenance.css'
);
const stagingCds = read(ROOT, 'db', 'staging.cds');
const serviceCds = read(ROOT, 'srv', 'change-request-service.cds');
const serviceJs = read(ROOT, 'srv', 'change-request-service.js');

// --- The colour rules themselves -----------------------------------------------------------

/**
 * Pinned as literal source rather than executed: this file is a sap.ui.define AMD module built
 * around SAPUI5 controls, so - like every other test against it in this codebase (see
 * field-property-apply.test.js) - the contract is read off the text.
 */
test('fieldChangeKind: added only when the baseline was empty, changed otherwise, nothing when they agree', () => {
  const fn = controller.slice(controller.indexOf('function fieldChangeKind'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.match(body, /if \(was && is\) return "";/u);
  assert.match(body, /if \(was && !is\) return "added";/u);
  assert.match(body, /return "changed";/u);
});

/**
 * NOT based on record.__state as the primary signal (2026-08-27 revision): that flag survives every
 * reload, staged straight off the DB `action` column, so a row the ORIGINAL requester added still
 * carries "new" when a data steward opens the very same request later. Matching by content against
 * the baseline is what tells "untouched this round" apart from "this round's own edit" - __state is
 * only the tiebreaker for genuine ambiguity.
 */
test('matchSectionRows matches by content first, and only falls back to __state', () => {
  const fn = controller.slice(controller.indexOf('function matchSectionRows'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.match(body, /var matchIndex = remaining\.findIndex/u);
  assert.match(body, /remaining\.splice\(matchIndex, 1\);/u);
  assert.match(body, /return \{ kind: "", baseline: null \};/u);
  assert.match(body, /record\.__state === "new" \|\| !remaining\.length/u);
  assert.match(body, /return \{ kind: "added", baseline: \{\} \};/u);
  assert.match(body, /return \{ kind: "changed", baseline: remaining\.shift\(\) \};/u);
});

// --- Scoped to where a baseline is meaningful ----------------------------------------------

/**
 * A plain new create has nothing to compare against - state.trackChanges must stay false there, or
 * every field typed on a brand new partner would show as an "addition", which is true of nothing a
 * requester needs telling.
 */
test('trackChanges defaults to false, and a plain create route never sets it', () => {
  assert.match(controller, /trackChanges: false,/u);
  const createRoute = controller.slice(controller.indexOf('_onCreateRoute: async function'));
  const body = createRoute.slice(0, createRoute.indexOf('\n      _onEditRoute'));
  assert.equal(/trackChanges/u.test(body), false);
});

test('editing an existing partner turns tracking on, editing is what decides it', () => {
  const loadBp = controller.slice(controller.indexOf('_loadBusinessPartner: async function'));
  const body = loadBp.slice(0, loadBp.indexOf('_loadSection: async function'));
  assert.match(body, /state\.originalSections = clone\(state\.sections\);/u);
  assert.match(body, /state\.trackChanges = editing;/u);
});

/**
 * Every mode _loadStagedRequest serves (rework, data steward review, approve, view) tracks changes;
 * only the requester's own not-yet-submitted create draft ("edit" mode, request type "create") does
 * not - there is no prior round to compare it against yet.
 */
test('a staged request tracks changes everywhere except a create draft with no prior round', () => {
  assert.match(
    controller,
    /state\.trackChanges = state\.requestType === "change" \|\| mode !== "edit";/u
  );
  assert.match(
    controller,
    /if \(state\.trackChanges\) await this\._loadChangeBaseline\(state, payload && payload\.BaselineDataJson\);/u
  );
});

// --- The baseline itself --------------------------------------------------------------------

/**
 * A change request is judged against S/4's OWN current values, re-read live - staging only ever
 * holds the merged result (original fields and this round's edits together), never a copy of what
 * was true before anyone touched it.
 */
test('a change request baseline is re-read live from S/4', () => {
  const fn = controller.slice(controller.indexOf('_loadChangeBaseline: async function'));
  const body = fn.slice(0, fn.indexOf('_fetchLiveSnapshotForDiff: async function'));
  assert.match(body, /state\.originalRoot = clone\(state\.root\);/u);
  assert.match(body, /state\.originalSections = clone\(state\.sections\);/u);
  assert.match(body, /if \(state\.requestType === "change"\) \{/u);
  assert.match(body, /if \(!state\.businessPartner\) return;/u);
  assert.match(body, /this\._fetchLiveSnapshotForDiff\(state\.businessPartner\)/u);
  // Best-effort: a failed live re-read keeps the as-loaded snapshot already assigned above rather
  // than leaving the screen without any baseline at all.
  assert.match(body, /console\.warn/u);
});

/**
 * A create request's baseline is server-persisted, NOT merely "as this screen loaded it" (revised
 * 2026-08-27) - that made the highlighting disappear the moment a different actor (a data steward,
 * then an approver) reopened the request, since each load re-snapshotted against itself. See
 * ChangeRequests.baselineDataJson in db/staging.cds.
 */
test('a create request baseline comes from the server, and survives a missing/unparsable one', () => {
  const fn = controller.slice(controller.indexOf('_loadChangeBaseline: async function'));
  const body = fn.slice(0, fn.indexOf('\n      },'));
  assert.match(body, /if \(!baselineDataJson\) return;/u);
  assert.match(body, /JSON\.parse\(baselineDataJson\)/u);
  assert.match(body, /state\.originalRoot = baseline\.root \|\| \{\};/u);
  // A parse failure must not throw the whole load - it leaves the as-loaded fallback already set.
  const parseAttempt = body.slice(body.indexOf('try {', body.indexOf('!baselineDataJson')));
  assert.match(parseAttempt, /catch \(error\) \{/u);
  assert.match(parseAttempt, /console\.warn/u);
});

test('the live snapshot reuses _loadSection, the same reader _loadBusinessPartner uses', () => {
  const fn = controller.slice(controller.indexOf('_fetchLiveSnapshotForDiff: async function'));
  const body = fn.slice(0, fn.indexOf('\n      },'));
  assert.match(body, /this\._loadSection\(relationValue, section\)/u);
  assert.match(body, /BusinessPartners\('" \+ escapeODataKey\(businessPartner\)/u);
});

// --- The server side: where the baseline is written and read --------------------------------

/**
 * Only a FRESH round resets the baseline - a first submit (trivially its own data, so nothing is
 * highlighted yet) and a resubmit (a fresh round after a rejection). A data steward's own completed
 * review deliberately does NOT reset it, so the approver receiving it next still sees what the
 * steward changed - see CLAUDE.md "Highlighting what changed".
 */
test('submitRequest and resubmitRequest write a fresh baseline; the data steward completion does not', () => {
  assert.match(stagingCds, /baselineDataJson\s*:\s*LargeString;/u);
  assert.match(serviceCds, /BaselineDataJson\s*:\s*LargeString;/u);
  assert.match(serviceJs, /BaselineDataJson: header\.baselineDataJson \|\| null/u);

  const submit = serviceJs.slice(serviceJs.indexOf("this.on('submitRequest'"));
  const submitBody = submit.slice(0, submit.indexOf("this.on('resubmitRequest'"));
  assert.match(submitBody, /baselineDataJson: req\.data\.DataJson/u);

  const resubmit = serviceJs.slice(serviceJs.indexOf("this.on('resubmitRequest'"));
  const resubmitBody = resubmit.slice(0, resubmit.indexOf('claimRework'));
  assert.match(resubmitBody, /baselineDataJson: req\.data\.DataJson/u);

  const stewardComplete = serviceJs.slice(serviceJs.indexOf("decision === 'complete', resubmitRequest"));
  const stewardBody = stewardComplete.slice(0, stewardComplete.indexOf('getRequestPayload'));
  assert.equal(/baselineDataJson: req\.data\.DataJson/u.test(stewardBody), false);
});

// --- The summary panel ------------------------------------------------------------------------

test('_refreshChangeSummary is a no-op when nothing is being tracked, and matches rows consistently', () => {
  const fn = controller.slice(controller.indexOf('_refreshChangeSummary: function'));
  const body = fn.slice(0, fn.indexOf('_rootFieldLabel: function'));
  assert.match(body, /if \(!state\.trackChanges\) \{/u);
  assert.match(body, /state\.changeSummary = \[\];/u);
  // The composed full name is never something anyone typed, so it must not appear as a "change".
  assert.match(body, /BusinessPartnerFullName/u);
  // The same matching function _renderSection colours the row on.
  assert.match(body, /matchSectionRows\(records, baselineRecords, fieldNames\)/u);
});

test('the panel is a plain three-column table, coloured on the New Value cell, not the row', () => {
  const panel = view.slice(view.indexOf('id="changeSummaryPanel"'));
  const body = panel.slice(0, panel.indexOf('</Panel>'));
  const columns = [...body.matchAll(/<Column>\s*<Text text="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(columns, ['Field', 'Previous Value', 'New Value']);
  assert.match(body, /items="\{ path: 'maintenance>\/changeSummary'/u);
  assert.match(body, /state="\{= \$\{maintenance>kind\} === 'added' \? 'Warning' : 'Error' \}"/u);
});

// --- Panel ordering: the conversation is the last thing above the form ------------------------

/**
 * Asked for explicitly (2026-08-27): the comment thread must be the LAST panel above the actual
 * form, right above the Business Partner's own name - so the duplicate findings and the new change
 * summary both come before it now, not after.
 */
test('the comments panel is the last panel before the object page, not the first', () => {
  const commentsAt = view.indexOf('id="commentsPanel"');
  const duplicatesAt = view.indexOf('id="duplicateFindings"');
  const summaryAt = view.indexOf('id="changeSummaryPanel"');
  const objectPageAt = view.indexOf('<uxap:ObjectPageLayout');
  assert.ok(duplicatesAt < commentsAt, 'duplicates panel comes before comments');
  assert.ok(summaryAt < commentsAt, 'change summary panel comes before comments');
  assert.ok(commentsAt < objectPageAt, 'comments panel comes before the object page');
  // Nothing else sits between the comments panel and the actual Business Partner data.
  const between = view.slice(view.indexOf('</Panel>', commentsAt), objectPageAt);
  assert.equal(/<Panel/u.test(between), false, 'no other panel sits between comments and the form');
});

// --- Field/row highlighting is threaded, and kept out of record dialogs -----------------------

/**
 * A baseline is only ever passed by the root form's own renderers. A section's Add/Edit dialog gets
 * none - the row itself is coloured in the outer table instead (see _renderSection), so a dialog
 * never has to resolve which of its own fields to tint.
 */
test('only the root form renderers pass a baseline into _createForm', () => {
  const rootSection = controller.slice(controller.indexOf('_renderRootSection: function'));
  const rootBody = rootSection.slice(0, rootSection.indexOf('_createForm: function'));
  assert.match(rootBody, /state\.trackChanges \? state\.originalRoot : null/u);

  const additionalFields = controller.slice(controller.indexOf('_openAdditionalFields: function'));
  const additionalBody = additionalFields.slice(0, additionalFields.indexOf('_updatePreview: function'));
  assert.match(additionalBody, /state\.trackChanges \? state\.originalRoot : null/u);

  const recordDialog = controller.slice(controller.indexOf('_openRecordDialog: function'));
  const formCall = recordDialog.slice(0, recordDialog.indexOf('var items = [form];'));
  assert.match(formCall, /this\._createForm\(section, record, isCreate, editing, grouped\);/u);
});

test('a section row is coloured off the baseline match, gated on trackChanges', () => {
  const renderSection = controller.slice(controller.indexOf('_renderSection: function'));
  const body = renderSection.slice(0, renderSection.indexOf('_openNewRecord: function'));
  assert.match(body, /var rowMatches = state\.trackChanges/u);
  assert.match(body, /matchSectionRows\(\s*records,/u);
  assert.match(body, /var rowKind = rowMatches\[index\] && rowMatches\[index\]\.kind;/u);
  assert.match(body, /item\.addStyleClass\(rowKind === "added" \? "mdmAddedRow" : "mdmChangedRow"\)/u);
});

test('every place a record changes refreshes the summary afterwards', () => {
  // The record dialog's own Apply handler.
  const recordDialog = controller.slice(controller.indexOf('_openRecordDialog: function'));
  const applyHandler = recordDialog.slice(0, recordDialog.indexOf('endButton: new Button'));
  assert.match(applyHandler, /this\._refreshChangeSummary\(\);/u);

  // Applying Check/Duplicate Check proposals.
  const applyProposals = controller.slice(controller.indexOf('_applyProposals: function'));
  const proposalsBody = applyProposals.slice(0, applyProposals.indexOf('MessageToast.show(applied'));
  assert.match(proposalsBody, /this\._refreshChangeSummary\(\);/u);

  // A root field's own commit.
  const onCommitted = controller.slice(controller.indexOf('_onFieldCommitted: function'));
  const committedBody = onCommitted.slice(0, onCommitted.indexOf('_refreshFullName: function'));
  assert.match(committedBody, /this\._renderRootForm\(\);/u);
  assert.match(committedBody, /this\._refreshChangeSummary\(\);/u);
});

// --- CSS --------------------------------------------------------------------------------------

test('the four highlight classes exist, on semantic theme tokens', () => {
  for (const cls of ['mdmChangedField', 'mdmAddedField', 'mdmChangedRow', 'mdmAddedRow']) {
    assert.match(css, new RegExp('\\.' + cls + '\\b'), cls + ' is styled');
  }
  assert.match(css, /--sapErrorBackground/u);
  assert.match(css, /--sapWarningBackground/u);
});
