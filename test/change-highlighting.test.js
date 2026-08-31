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

/**
 * Pulls the (pure, self-contained - no `this`, no closure over other module state) matchSectionRows
 * function out of the controller's source and turns it into something callable, so its row-matching
 * logic can be exercised directly rather than only pinned as a regex against the text. Everything
 * else in this file stays source-string pinning, like the rest of this codebase's tests against a
 * sap.ui.define AMD module - this one function earns the extra ceremony because it is exactly what a
 * real, reported bug turned out to be wrong inside.
 */
function extractMatchSectionRows(source) {
  const start = source.indexOf('function matchSectionRows');
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const code = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + code + ')')();
}

/**
 * Same idea as extractMatchSectionRows, for an object-literal method (`name: function (...) {...}`)
 * rather than a standalone declaration - _recordProvenance/_provenanceFor reference no `this`, so
 * they are just as callable in isolation. `displayValue` is injected the same way the real controller
 * closure supplies it, rather than re-declared inside the extracted body.
 */
function extractMethod(source, name, ...freeVars) {
  const label = name + ': function';
  const labelAt = source.indexOf(label);
  const fnStart = labelAt + name.length + 2;
  const braceStart = source.indexOf('{', fnStart);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const code = source.slice(fnStart, end);
  // eslint-disable-next-line no-new-func
  return new Function(...freeVars.map((pair) => pair[0]), 'return (' + code + ')')(
    ...freeVars.map((pair) => pair[1])
  );
}

function realDisplayValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

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
 * NOT based on record.__state at all any more (reverted 2026-08-27, having shipped as a tiebreaker
 * the same day and been wrong): that flag survives every reload, staged straight off the DB `action`
 * column, so a row the ORIGINAL requester added still carries "new" on every later reload, through
 * every later edit. Treating "new" as "this is an addition" then misclassified every EDIT to an
 * original row as an addition too - reported the same day as "change one field, the whole row (and
 * the whole summary line) lights up". Two passes instead: exact matches are consumed first: whatever
 * is left is an edit of a still-unconsumed baseline row for as long as any remain, and only becomes
 * an addition once they run out - i.e. only when the section actually ends up with more rows than
 * the baseline had.
 */
test('matchSectionRows: exact matches first, then pair off by count - never by __state', () => {
  const fn = controller.slice(controller.indexOf('function matchSectionRows'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.equal(/__state/u.test(body), false, 'the second pass reads nothing off __state any more');
  assert.match(body, /var matchIndex = remaining\.findIndex/u);
  assert.match(body, /remaining\.splice\(matchIndex, 1\);/u);
  assert.match(body, /kind: "", baseline: null/u);
  assert.match(body, /kind: "changed", baseline: remaining\.shift\(\)/u);
  assert.match(body, /kind: "added", baseline: \{\}/u);
  // Two passes: nothing in the second reruns exact matching, it only consumes what pass one left.
  assert.match(body, /records \|\| \[\]\)\.forEach/gu);
});

/**
 * The bug this was all rewritten for: editing ONE field of a row that already existed (added in an
 * earlier round, so its __state is "new" and always will be) must classify as "changed" against its
 * own baseline row - not "added" against an empty one, which is what made every other, untouched
 * field look changed too.
 */
test('editing one field of a row __state still calls "new" is a change, not an addition', () => {
  const matchSectionRows = extractMatchSectionRows(controller);
  const baseline = [{ __state: 'new', StreetName: 'Main St', CityName: 'Ghent', Country: 'BE' }];
  const current = [{ __state: 'new', StreetName: 'Main St', CityName: 'Antwerp', Country: 'BE' }];
  const [match] = matchSectionRows(current, baseline, ['StreetName', 'CityName', 'Country']);
  assert.equal(match.kind, 'changed');
  assert.deepEqual(match.baseline, baseline[0]);
});

test('a row with no baseline counterpart at all is an addition', () => {
  const matchSectionRows = extractMatchSectionRows(controller);
  const current = [{ __state: 'new', StreetName: 'New St', CityName: 'Bruges', Country: 'BE' }];
  const [match] = matchSectionRows(current, [], ['StreetName', 'CityName', 'Country']);
  assert.equal(match.kind, 'added');
});

test('an untouched row exactly matching its baseline is not coloured at all', () => {
  const matchSectionRows = extractMatchSectionRows(controller);
  const row = { __state: 'new', StreetName: 'Main St', CityName: 'Ghent', Country: 'BE' };
  const [match] = matchSectionRows([row], [{ ...row }], ['StreetName', 'CityName', 'Country']);
  assert.equal(match.kind, '');
});

/**
 * A baseline row nothing current corresponds to any more is a DELETED row - there is no colour to
 * give a row that is not there (see "a line that was deleted" in CLAUDE.md), so it rides along on
 * the returned array as `.deleted` instead of being silently dropped, for _refreshChangeSummary to
 * report. Attached as a property, not a second return value, so every existing caller that reads
 * this as a plain per-record array is untouched.
 */
test('matchSectionRows carries an unconsumed baseline row as .deleted, not silently', () => {
  const matchSectionRows = extractMatchSectionRows(controller);
  const kept = { StreetName: 'Main St', CityName: 'Ghent', Country: 'BE' };
  const removed = { StreetName: 'Other St', CityName: 'Bruges', Country: 'BE' };
  const matches = matchSectionRows([kept], [kept, removed], ['StreetName', 'CityName', 'Country']);
  assert.equal(matches.length, 1, 'the deleted row is not a fourth entry paired against nothing');
  assert.equal(matches[0].kind, '', 'the row that is still there is untouched');
  assert.deepEqual(matches.deleted, [removed]);
});

test('nothing deleted leaves .deleted empty, never undefined', () => {
  const matchSectionRows = extractMatchSectionRows(controller);
  const matches = matchSectionRows([], [], []);
  assert.deepEqual(matches.deleted, []);
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
 * Only the very FIRST successful submitRequest ever writes the baseline (reversed 2026-08-27, having
 * shipped a reset-on-resubmit the same day): a first submit's baseline is trivially its own data, so
 * nothing is highlighted yet, and every later write to this request - a data steward's own completed
 * review, or a resubmit after a rejection - deliberately leaves it alone. That is what lets a create
 * request's baseline stay "the original submission" for its entire lifetime, however many rework
 * rounds it takes, so the requester's OWN rework edits stay visible to whoever reviews it next -
 * exactly the same way a data steward's edits already stayed visible through to the approver. See
 * CLAUDE.md "Highlighting what changed".
 */
test('only the first submitRequest ever writes the baseline - resubmit and steward completion both leave it', () => {
  assert.match(stagingCds, /baselineDataJson\s*:\s*LargeString;/u);
  assert.match(serviceCds, /BaselineDataJson\s*:\s*LargeString;/u);
  assert.match(serviceJs, /BaselineDataJson: header\.baselineDataJson \|\| null/u);

  const submit = serviceJs.slice(serviceJs.indexOf("this.on('submitRequest'"));
  const submitBody = submit.slice(0, submit.indexOf("this.on('resubmitRequest'"));
  assert.match(submitBody, /baselineDataJson: req\.data\.DataJson/u);

  const resubmit = serviceJs.slice(serviceJs.indexOf("this.on('resubmitRequest'"));
  const resubmitBody = resubmit.slice(0, resubmit.indexOf('claimRework'));
  assert.equal(
    /baselineDataJson: req\.data\.DataJson/u.test(resubmitBody), false,
    'a resubmit must not reset the baseline any more - the requester\'s rework edits should stay visible'
  );

  const stewardComplete = serviceJs.slice(serviceJs.indexOf("decision === 'complete', resubmitRequest"));
  const stewardBody = stewardComplete.slice(0, stewardComplete.indexOf('getRequestPayload'));
  assert.equal(/baselineDataJson: req\.data\.DataJson/u.test(stewardBody), false);
});

/**
 * Asked for explicitly (2026-08-27): when a data steward's edit gets the request rejected and it
 * comes back to the REQUESTER, the rework screen must show what changed too - the same highlighting
 * the steward saw, now for the person picking the request back up. Nothing extra was needed to make
 * this true: neither decideRequest's reject branch nor claimRework (the stopgap for the missing
 * reject callback) ever touch baselineDataJson, so it still holds whatever submitRequest/
 * resubmitRequest last wrote - the ORIGINAL, pre-steward data - by the time the rework screen loads
 * it. This test exists so that guarantee cannot regress silently.
 */
test('a rejection never resets the baseline, so the reworking requester sees what the steward changed', () => {
  // Anchored on decideRequest itself first - decideDataStewardReview has its own, differently-shaped
  // "if (decision === 'reject')" branch earlier in the file, and slicing from that string alone would
  // run all the way into decideRequest's, picking up resubmitRequest's baselineDataJson write in
  // between and reporting a false positive.
  const decideRequest = serviceJs.slice(serviceJs.indexOf("this.on('decideRequest'"));
  const reject = decideRequest.slice(decideRequest.indexOf("if (decision === 'reject') {"));
  const rejectBody = reject.slice(0, reject.indexOf("await notifyWorkflow('rejected');") + 40);
  assert.equal(/baselineDataJson/u.test(rejectBody), false, "decideRequest's reject branch leaves it alone");

  const claimRework = serviceJs.slice(serviceJs.indexOf("this.on('claimRework'"));
  const claimBody = claimRework.slice(0, claimRework.indexOf("this.on('withdrawRequest'"));
  assert.equal(/baselineDataJson/u.test(claimBody), false, 'claimRework leaves it alone too');

  // Rework is one of the modes _loadStagedRequest tracks changes in, and a create request's baseline
  // comes from the server either way - both already pinned above, restated here as the guarantee
  // this specific scenario depends on.
  assert.match(
    controller,
    /state\.trackChanges = state\.requestType === "change" \|\| mode !== "edit";/u
  );
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

/**
 * A deleted row has no cell left to colour in the table, so this panel is the only place left that
 * can still say a row disappeared (asked for 2026-08-28: "als er een lijn verwijderd is kan je dit
 * niet meer zien met kleurencode, maar moet dit bovenaan wel vermeld worden"). One summary line per
 * POPULATED field of the deleted row, mirroring how an added row lists every field it populated -
 * just with the value sides read the other way round.
 */
test('_refreshChangeSummary reports a deleted row per populated field, and counts it separately', () => {
  const fn = controller.slice(controller.indexOf('_refreshChangeSummary: function'));
  const body = fn.slice(0, fn.indexOf('_rootFieldLabel: function'));
  assert.match(body, /\(matches\.deleted \|\| \[\]\)\.forEach/u);
  assert.match(body, /newValue: "\(removed\)"/u);
  assert.match(body, /kind: "removed"/u);
  // A row that was added and then removed again without ever being filled in still counts, even
  // though it has no field of its own worth a line.
  assert.match(body, /field: section\.title \+ " – Row removed"/u);
  // Two separate counts in the header, not one combined total - folding a removed row's several
  // fields into "N fields changed" would overstate how many edits actually happened.
  assert.match(body, /rows\.filter\(function \(row\) \{ return row\.kind === "removed"; \}\)/u);
  assert.match(body, /" row removed" : " rows removed"/u);
});

test('the panel table is coloured on the New Value cell, not the row, and names Why last', () => {
  const panel = view.slice(view.indexOf('id="changeSummaryPanel"'));
  const body = panel.slice(0, panel.indexOf('</Panel>'));
  const columns = [...body.matchAll(/<Column>\s*<Text text="([^"]+)"/gu)].map((match) => match[1]);
  // Why (2026-08-31) carries an accepted proposal's own reason, or "User change/input" for a plain
  // edit - see _provenanceFor/_recordProvenance in the controller.
  assert.deepEqual(columns, ['Field', 'Previous Value', 'New Value', 'Why']);
  assert.match(body, /items="\{ path: 'maintenance>\/changeSummary'/u);
  assert.match(body, /state="\{= \$\{maintenance>kind\} === 'added' \? 'Warning' : 'Error' \}"/u);
  // Three words shown, the full sentence on hover - the same convention the proposal dialog itself
  // uses for its own Why column.
  assert.match(body, /text="\{maintenance>why\}" wrapping="false" tooltip="\{maintenance>whyDetail\}"/u);
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
  // No other PANEL sits between the comments panel and the actual Business Partner data - the three
  // comment INPUT boxes do (moved there 2026-08-27, see the next test), but none of them is a Panel.
  const between = view.slice(view.indexOf('</Panel>', commentsAt), objectPageAt);
  assert.equal(/<Panel/u.test(between), false, 'no other panel sits between comments and the form');
});

/**
 * Asked for the same day: the box where the CURRENT actor types their OWN note should sit right
 * after the conversation it replies to, not disconnected near the top of the screen - so reading
 * top to bottom now goes "what was said" then "say something back" then the form itself.
 */
test('the comment input boxes sit right after the conversation, still before the form', () => {
  const commentsAt = view.indexOf('id="commentsPanel"');
  const objectPageAt = view.indexOf('<uxap:ObjectPageLayout');
  for (const id of ['approverCommentBox', 'reworkCommentBox', 'dataStewardCommentBox']) {
    const at = view.indexOf('id="' + id + '"');
    assert.ok(at > commentsAt, id + ' comes after the conversation panel');
    assert.ok(at < objectPageAt, id + ' still comes before the object page');
  }
});

// --- Field/row highlighting is threaded into record dialogs too (2026-08-27) -------------------

/**
 * A section's Add/Edit dialog now gets a baseline too - reversed the same day it was decided the
 * other way: colouring only the outer row left a data steward with no way to see WHICH field inside
 * the dialog they were actually changing, and the row itself over-reported (see matchSectionRows).
 * `_openExistingRecord` resolves the matching baseline row through `_rowBaseline` - the exact same
 * matchSectionRows call `_renderSection`'s own row colour comes from, so a dialog never disagrees
 * with the row it was opened from. `_openNewRecord` passes `{}`: every field typed into a brand new
 * row is an addition, the same as the row itself once it lands in the table.
 */
test('a record dialog is coloured against the same baseline row the table itself uses', () => {
  const rootSection = controller.slice(controller.indexOf('_renderRootSection: function'));
  const rootBody = rootSection.slice(0, rootSection.indexOf('_createForm: function'));
  assert.match(rootBody, /state\.trackChanges \? state\.originalRoot : null/u);

  const additionalFields = controller.slice(controller.indexOf('_openAdditionalFields: function'));
  const additionalBody = additionalFields.slice(0, additionalFields.indexOf('_updatePreview: function'));
  assert.match(additionalBody, /state\.trackChanges \? state\.originalRoot : null/u);

  const newRecord = controller.slice(controller.indexOf('_openNewRecord: function'));
  const newRecordBody = newRecord.slice(0, newRecord.indexOf('_openExistingRecord: function'));
  assert.match(newRecordBody, /this\._openRecordDialog\(section, record, true, -1, state\.trackChanges \? \{\} : null\)/u);

  const existingRecord = controller.slice(controller.indexOf('_openExistingRecord: function'));
  const existingBody = existingRecord.slice(0, existingRecord.indexOf('_rowBaseline: function'));
  assert.match(existingBody, /this\._rowBaseline\(section, index\)/u);

  const rowBaseline = controller.slice(controller.indexOf('_rowBaseline: function'));
  const rowBaselineBody = rowBaseline.slice(0, rowBaseline.indexOf('\n      },'));
  assert.match(rowBaselineBody, /if \(!state\.trackChanges\) return null;/u);
  assert.match(rowBaselineBody, /matchSectionRows\(records, baselineRecords, fieldNames\)/u);

  const recordDialog = controller.slice(controller.indexOf('_openRecordDialog: function'));
  const formCall = recordDialog.slice(0, recordDialog.indexOf('var items = [form];'));
  assert.match(formCall, /this\._createForm\(section, record, isCreate, editing, grouped, baseline\);/u);
});

/**
 * A CHANGED row colours only the cell(s) that actually differ - the bug reported the same day was
 * exactly the opposite: editing one field (City) painted the whole row, and the summary panel listed
 * every field of that row as changed. An ADDED row is still tinted whole, because every one of its
 * fields really is new.
 */
test('a changed row colours only the cells that differ; an added row is tinted whole', () => {
  const renderSection = controller.slice(controller.indexOf('_renderSection: function'));
  const body = renderSection.slice(0, renderSection.indexOf('_openNewRecord: function'));
  assert.match(body, /var rowMatches = state\.trackChanges/u);
  assert.match(body, /matchSectionRows\(\s*records,/u);
  assert.match(body, /if \(rowKind === "changed"\) \{/u);
  assert.match(body, /fieldChangeKind\(match\.baseline\[field\.name\], record\[field\.name\]\)/u);
  assert.match(body, /cell\.addStyleClass\(fieldKind === "added" \? "mdmAddedField" : "mdmChangedField"\)/u);
  assert.match(body, /if \(rowKind === "added"\) item\.addStyleClass\("mdmAddedRow"\);/u);
  // No whole-row treatment for "changed" any more.
  assert.equal(/"mdmChangedRow"/u.test(body), false);
});

test('_createFieldTable also colours a cell against its baseline, the same as the grid', () => {
  const fn = controller.slice(controller.indexOf('_createFieldTable: function'));
  const body = fn.slice(0, fn.indexOf('\n      },'));
  assert.match(body, /if \(baseline\) \{/u);
  assert.match(body, /fieldChangeKind\(baseline\[field\.name\], record\[field\.name\]\)/u);
  assert.match(body, /control\.addStyleClass\(kind === "added" \? "mdmAddedField" : "mdmChangedField"\)/u);
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

/**
 * Reported 2026-08-27: a field picked from the F4 value help dialog never coloured, even though a
 * typed value in the same field did. Root cause: sap.m.SelectDialog's own "confirm" event is not the
 * target Input's "change" event, so _attachCommitTrigger's handler - the one thing that runs
 * _onFieldCommitted - never fired for it. Fixed by having the value help's own confirm call
 * _onFieldCommitted directly, so a value chosen from a dialog gets exactly the same treatment as one
 * typed: the root form's recolouring and summary refresh, a tax number's registry trigger, the
 * debounced auto-check - not a partial copy of any of it.
 */
test('choosing a value from the F4 help gets the same commit treatment as typing one', () => {
  const openValueHelp = controller.slice(controller.indexOf('_openValueHelp: function'));
  const confirmHandler = openValueHelp.slice(
    openValueHelp.indexOf('confirm: function'),
    openValueHelp.indexOf('search: function')
  );
  assert.match(confirmHandler, /this\._valueHelpTarget\.record\[this\._valueHelpTarget\.field\.name\] = value;/u);
  assert.match(
    confirmHandler,
    /this\._onFieldCommitted\(this\._valueHelpTarget\.section, this\._valueHelpTarget\.field\);/u
  );
});

// --- CSS --------------------------------------------------------------------------------------

// No mdmChangedRow: colouring a whole row for one changed field was the bug reported 2026-08-27.
test('the three highlight classes exist, on semantic theme tokens - no whole-row "changed" class', () => {
  for (const cls of ['mdmChangedField', 'mdmAddedField', 'mdmAddedRow']) {
    assert.match(css, new RegExp('\\.' + cls + '\\b'), cls + ' is styled');
  }
  assert.equal(/\.mdmChangedRow\b/u.test(css), false);
  assert.match(css, /--sapErrorBackground/u);
  assert.match(css, /--sapWarningBackground/u);
});

// --- Provenance: an accepted proposal's Why survives into the change summary (2026-08-31) --------

/**
 * Content-matched, like matchSectionRows' own row matching: a stored entry only counts while the
 * field still carries EXACTLY the value the proposal wrote. This is what makes a further manual edit
 * correct itself back to "User change/input" without any edit path having to remember to clear
 * anything - the same design choice CLAUDE.md documents for row matching itself.
 */
test('_provenanceFor: the proposal\'s reason only while the value still matches what it wrote', () => {
  const provenanceFor = extractMethod(
    controller, '_provenanceFor', ['displayValue', realDisplayValue]
  );
  const state = {
    proposalProvenance: {
      root: { Country: { value: 'BE', reason: 'VIES check', detail: 'VIES confirmed the address.' } },
      sections: {
        Addresses: [{ StreetName: { value: 'Kerkstraat', reason: 'GLEIF check', detail: 'From GLEIF.' } }]
      }
    }
  };

  const matched = provenanceFor(state, 'root', 0, 'Country', 'BE');
  assert.deepEqual(matched, { why: 'VIES check', whyDetail: 'VIES confirmed the address.' });

  const edited = provenanceFor(state, 'root', 0, 'Country', 'NL');
  assert.deepEqual(edited, { why: 'User change/input', whyDetail: '' });

  const untouched = provenanceFor(state, 'root', 0, 'Language', 'NL');
  assert.deepEqual(untouched, { why: 'User change/input', whyDetail: '' });

  const sectionMatched = provenanceFor(state, 'Addresses', 0, 'StreetName', 'Kerkstraat');
  assert.deepEqual(sectionMatched, { why: 'GLEIF check', whyDetail: 'From GLEIF.' });

  const sectionEdited = provenanceFor(state, 'Addresses', 0, 'StreetName', 'Kerkweg');
  assert.deepEqual(sectionEdited, { why: 'User change/input', whyDetail: '' });
});

test('_provenanceFor: no provenance store at all is the same as never having proposed anything', () => {
  const provenanceFor = extractMethod(
    controller, '_provenanceFor', ['displayValue', realDisplayValue]
  );
  assert.deepEqual(
    provenanceFor({}, 'root', 0, 'Country', 'BE'),
    { why: 'User change/input', whyDetail: '' }
  );
});

/**
 * _recordProvenance is what _applyProposals calls at each of its three write points (a plain field,
 * a row-creating lead field, and that row's own key "extras"). Falls back to the proposal's message
 * when there is no `detail` - an empty tooltip reads as a broken one, the same rule the proposal
 * dialog's own Why column follows for a normalisation with no `detail`.
 */
test('_recordProvenance: root by field name, a section by [index][field], with sensible fallbacks', () => {
  const recordProvenance = extractMethod(
    controller, '_recordProvenance', ['displayValue', realDisplayValue]
  );
  const state = { proposalProvenance: { root: {}, sections: {} } };

  recordProvenance(state, 'root', 0, 'Country', 'BE', { reason: 'VIES check', detail: 'Confirmed.' });
  assert.deepEqual(state.proposalProvenance.root.Country, {
    value: 'BE', reason: 'VIES check', detail: 'Confirmed.'
  });

  recordProvenance(state, 'Addresses', 2, 'StreetName', 'Kerkstraat', { message: 'From GLEIF.' });
  assert.deepEqual(state.proposalProvenance.sections.Addresses[2].StreetName, {
    value: 'Kerkstraat', reason: 'Derived', detail: 'From GLEIF.'
  });
});

test('_applyProposals records provenance for a plain field, and for a created row plus its extras', () => {
  const fn = controller.slice(controller.indexOf('_applyProposals: function'));
  const body = fn.slice(0, fn.indexOf('\n      _resolveStandardChecks'));
  // The plain-field write.
  assert.match(
    body,
    /record\[proposal\.field\] = value;\s*self\._recordProvenance\(state, proposal\.target, proposal\.index \|\| 0, proposal\.field, value, proposal\);/u
  );
  // The row-creation write: the lead field, then every extra that actually landed.
  assert.match(
    body,
    /self\._recordProvenance\(state, proposal\.target, newIndex, proposal\.field, value, proposal\);/u
  );
  assert.match(
    body,
    /self\._recordProvenance\(state, proposal\.target, newIndex, extra\.field, added\[extra\.field\], proposal\);/u
  );
});

test('_refreshChangeSummary attaches why/whyDetail from _provenanceFor, for root and section rows', () => {
  const fn = controller.slice(controller.indexOf('_refreshChangeSummary: function'));
  const body = fn.slice(0, fn.indexOf('_rootFieldLabel: function'));
  assert.match(
    body,
    /var provenance = this\._provenanceFor\(state, "root", 0, fieldName, root\[fieldName\]\);/u
  );
  assert.match(
    body,
    /var provenance = self\._provenanceFor\(state, section\.id, index, field\.name, record\[field\.name\]\);/u
  );
  assert.match(body, /why: provenance\.why,\s*whyDetail: provenance\.whyDetail/u);
  // A removed row has no current value left to attribute anything to - both removed-row branches
  // (a field that had a value, and a row removed before it ever got one) say so explicitly.
  assert.equal((body.match(/why: "",\s*whyDetail: ""/gu) || []).length, 2);
});
