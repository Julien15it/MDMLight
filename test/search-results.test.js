'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  IN_PROGRESS_REQUEST_STATUSES,
  PARTNER_FIELDS,
  stagedFullName,
  pendingCreateEntry,
  partnerEntry,
  matchesWhere,
  matchesTerms,
  referencedFields,
  mergeLocalPage,
  pageSplit,
  byRequestedAtDesc,
  remoteOrderBy,
  statusOf,
  ACTIVE_STATUS,
  CRITICALITY
} = require('../srv/search-results');

const SEARCHABLE_FIELDS = [
  'BusinessPartner', 'BusinessPartnerFullName', 'BusinessPartnerName',
  'SearchTerm1', 'SearchTerm2', 'FirstName', 'LastName', 'OrganizationBPName1'
];

const contains = (field, value) => ({ func: 'contains', args: [{ ref: [field] }, { val: value }] });

test('in progress is narrower than the lock: approved and failed belong to the post', () => {
  assert.deepEqual(
    [...IN_PROGRESS_REQUEST_STATUSES], ['draft', 'inApproval', 'reworkRequired', 'checkAndEnrich']
  );
  assert.equal(IN_PROGRESS_REQUEST_STATUSES.includes('approved'), false);
  assert.equal(IN_PROGRESS_REQUEST_STATUSES.includes('posted'), false);
});

test('a staged create is named the way S/4 would name it', () => {
  assert.equal(stagedFullName({ OrganizationBPName1: 'Alluvion', OrganizationBPName2: 'NV' }), 'Alluvion NV');
  assert.equal(stagedFullName({ FirstName: 'Maarten', LastName: 'Eylenbosch' }), 'Maarten Eylenbosch');
  assert.equal(stagedFullName({ GroupBusinessPartnerName1: 'Alluvion Group' }), 'Alluvion Group');
  // Nothing but a search term is still better than an unnamed row.
  assert.equal(stagedFullName({ SearchTerm1: 'ALLUVION' }), 'ALLUVION');
  assert.equal(stagedFullName({}), '');
});

test('a pending create is a row of its own, with no partner number', () => {
  const { row } = pendingCreateEntry({
    request: {
      ID: 'abc', requestType: 'create', status: 'inApproval',
      submittedBy: 'maarten', submittedAt: '2026-08-24T09:00:00Z'
    },
    general: { OrganizationBPName1: 'Alluvion NV', BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'BP01' }
  });

  assert.equal(row.ResultKey, 'CR:abc');
  assert.equal(row.BusinessPartner, '');
  assert.equal(row.BusinessPartnerFullName, 'Alluvion NV');
  assert.equal(row.IsChangeRequest, true);
  assert.equal(row.ChangeRequest, 'abc');
  assert.equal(row.RecordStatus, 'Create in approval');
  assert.equal(row.RecordStatusCriticality, CRITICALITY.inFlight);
  assert.equal(row.RequestedBy, 'maarten');
});

test('a pending create matches on the staged fields, not only on the name shown', () => {
  const { searchable } = pendingCreateEntry({
    request: { ID: 'abc', requestType: 'create', status: 'draft' },
    general: { FirstName: 'Maarten', LastName: 'Eylenbosch' }
  });

  assert.equal(matchesTerms(searchable, ['eylenbosch'], SEARCHABLE_FIELDS), true);
  assert.equal(searchable.BusinessPartnerFullName, 'Maarten Eylenbosch');
});

test('a partner with no request in flight is plain and neutral', () => {
  const { row } = partnerEntry({ BusinessPartner: '4711', BusinessPartnerFullName: 'Alluvion NV' });

  assert.equal(row.ResultKey, 'BP:4711');
  assert.equal(row.RecordStatus, ACTIVE_STATUS);
  assert.equal(row.RecordStatusCriticality, CRITICALITY.neutral);
  assert.equal(row.IsChangeRequest, false);
  assert.equal(row.ChangeRequest, null);
  for (const field of PARTNER_FIELDS) assert.ok(field in row);
});

test('a partner under a change request carries the request, and is not itself one', () => {
  const { row } = partnerEntry(
    { BusinessPartner: '4711', BusinessPartnerFullName: 'Alluvion NV' },
    { ID: 'req-1', requestType: 'change', status: 'reworkRequired', createdBy: 'julien' }
  );

  assert.equal(row.RecordStatus, 'Change rework required');
  assert.equal(row.RecordStatusCriticality, CRITICALITY.inFlight);
  // False, or the row would open as a request instead of as the partner it is.
  assert.equal(row.IsChangeRequest, false);
  assert.equal(row.ChangeRequest, 'req-1');
  assert.equal(row.RequestedBy, 'julien');
});

test('statusOf spells out every request type it can be handed', () => {
  assert.equal(statusOf({ requestType: 'block', status: 'draft' }).RecordStatus, 'Block draft');
  assert.equal(statusOf({ requestType: 'delete', status: 'failed' }).RecordStatus, 'Delete post failed');
  // An unknown type is shown as it is rather than swallowed.
  assert.equal(statusOf({ requestType: 'merge', status: 'draft' }).RecordStatus, 'merge draft');
});

test('the filter bar is applied to the staged rows too', () => {
  const row = { BusinessPartner: '', BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'BP01' };

  assert.equal(matchesWhere(row, [{ ref: ['BusinessPartnerCategory'] }, '=', { val: '2' }]), true);
  assert.equal(matchesWhere(row, [{ ref: ['BusinessPartnerCategory'] }, '=', { val: '1' }]), false);
  assert.equal(matchesWhere(row, [{ ref: ['BusinessPartnerGrouping'] }, '!=', { val: 'BP01' }]), false);
});

test('a filter on the partner number excludes a create, which has no number yet', () => {
  const row = { BusinessPartner: '' };
  assert.equal(matchesWhere(row, [{ ref: ['BusinessPartner'] }, '=', { val: '4711' }]), false);
});

test('and, or and negation combine the way the filter bar builds them', () => {
  const row = { BusinessPartnerCategory: '2', OrganizationBPName1: 'Alluvion NV' };

  assert.equal(matchesWhere(row, [
    { ref: ['BusinessPartnerCategory'] }, '=', { val: '2' },
    'and', { xpr: [contains('OrganizationBPName1', 'alluvion')] }
  ]), true);

  assert.equal(matchesWhere(row, [
    { xpr: [{ ref: ['BusinessPartnerCategory'] }, '=', { val: '1' }] },
    'or',
    { xpr: [{ ref: ['BusinessPartnerCategory'] }, '=', { val: '2' }] }
  ]), true);

  assert.equal(matchesWhere(row, ['not', { xpr: [contains('OrganizationBPName1', 'alluvion')] }]), false);
});

test('contains is case insensitive and undoes the quote the remote serializer doubled', () => {
  const row = { LastName: "O'Hara" };
  assert.equal(matchesWhere(row, [contains('LastName', "o''hara")]), true);
  assert.equal(matchesWhere(row, [contains('LastName', 'HARA')]), true);
  assert.equal(matchesWhere(row, [contains('LastName', 'Harra')]), false);
});

/**
 * Used to tell a filter S/4 understands from one naming a change-request field it never heard of -
 * see the READ handler's local-filtering branch. Has to walk the same shapes `valueOf` reads.
 */
test('referencedFields walks ref, xpr, list and func the way valueOf does', () => {
  assert.deepEqual(
    [...referencedFields([{ ref: ['BusinessPartnerCategory'] }, '=', { val: '2' }])],
    ['BusinessPartnerCategory']
  );
  assert.deepEqual(
    [...referencedFields([
      { xpr: [{ ref: ['RecordStatus'] }, '=', { val: 'Active' }] },
      'and',
      contains('SearchTerm1', 'x')
    ])].sort(),
    ['RecordStatus', 'SearchTerm1']
  );
  assert.deepEqual(
    [...referencedFields([{ ref: ['ChangeRequestStatus'] }, 'in', { list: [{ val: 'draft' }] }])],
    ['ChangeRequestStatus']
  );
  assert.deepEqual([...referencedFields(undefined)], []);
  assert.deepEqual([...referencedFields([])], []);
});

test('a boolean filter reads the staged value rather than its string', () => {
  assert.equal(matchesWhere({ BusinessPartnerIsBlocked: false }, [
    { ref: ['BusinessPartnerIsBlocked'] }, '=', { val: false }
  ]), true);
  assert.equal(matchesWhere({ BusinessPartnerIsBlocked: false }, [
    { ref: ['BusinessPartnerIsBlocked'] }, '=', { val: true }
  ]), false);
});

// A staged column nobody set is null, and "not blocked" is the filter people actually use.
test('a filter for unblocked partners finds the create that nobody blocked', () => {
  const { searchable, row } = pendingCreateEntry({
    request: { ID: 'abc', requestType: 'create', status: 'draft' },
    general: { OrganizationBPName1: 'Alluvion NV' }
  });

  assert.equal(row.BusinessPartnerIsBlocked, false);
  assert.equal(matchesWhere(searchable, [
    { ref: ['BusinessPartnerIsBlocked'] }, '=', { val: false }
  ]), true);
  assert.equal(matchesWhere(searchable, [
    { ref: ['BusinessPartnerIsBlocked'] }, '=', { val: true }
  ]), false);
});

test('an expression the staged rows cannot evaluate keeps the row and reports itself', () => {
  const reported = [];
  const row = { BusinessPartnerFullName: 'Alluvion NV' };
  const exotic = [{ func: 'substringof', args: [{ val: 'x' }, { ref: ['BusinessPartnerFullName'] }] }];

  // Kept: a request wrongly shown is a nuisance, one wrongly hidden is the failure this prevents.
  assert.equal(matchesWhere(row, exotic, (expression) => reported.push(expression)), true);
  assert.equal(reported.length, 1);
});

test('no filter matches everything', () => {
  assert.equal(matchesWhere({}, undefined), true);
  assert.equal(matchesWhere({}, []), true);
});

test('every search term must hit a field, as the remote read requires', () => {
  const row = { BusinessPartnerFullName: 'Alluvion NV', SearchTerm1: 'ALLUVION' };
  assert.equal(matchesTerms(row, ['alluvion'], SEARCHABLE_FIELDS), true);
  assert.equal(matchesTerms(row, ['alluvion', 'nv'], SEARCHABLE_FIELDS), true);
  assert.equal(matchesTerms(row, ['alluvion', 'gmbh'], SEARCHABLE_FIELDS), false);
  assert.equal(matchesTerms(row, [], SEARCHABLE_FIELDS), true);
});

test('staged rows take the top of the first page and the remote read is asked for the rest', () => {
  const split = pageSplit({ pendingCount: 2, skip: 0, top: 30 });
  assert.deepEqual(split, { pendingSkip: 0, pendingTaken: 2, partnerSkip: 0, partnerTop: 28 });
});

test('the second page skips the staged rows it already showed', () => {
  const split = pageSplit({ pendingCount: 2, skip: 30, top: 30 });
  // 30 rows shown so far were 2 staged and 28 remote, so the remote read resumes at 28.
  assert.deepEqual(split, { pendingSkip: 2, pendingTaken: 0, partnerSkip: 28, partnerTop: 30 });
});

test('a page filled entirely by staged rows asks the remote read for nothing', () => {
  const split = pageSplit({ pendingCount: 5, skip: 0, top: 3 });
  assert.deepEqual(split, { pendingSkip: 0, pendingTaken: 3, partnerSkip: 0, partnerTop: 0 });
});

test('a page landing inside the staged rows takes the remainder from the remote read', () => {
  const split = pageSplit({ pendingCount: 5, skip: 3, top: 10 });
  assert.deepEqual(split, { pendingSkip: 3, pendingTaken: 2, partnerSkip: 0, partnerTop: 8 });
});

test('an unpaged read takes every staged row and leaves the remote read unpaged', () => {
  const split = pageSplit({ pendingCount: 4, skip: 0, top: undefined });
  assert.deepEqual(split, { pendingSkip: 0, pendingTaken: 4, partnerSkip: 0, partnerTop: undefined });
});

test('no staged rows leaves the paging exactly as the client sent it', () => {
  const split = pageSplit({ pendingCount: 0, skip: 60, top: 30 });
  assert.deepEqual(split, { pendingSkip: 0, pendingTaken: 0, partnerSkip: 60, partnerTop: 30 });
});

test('newest request first, and an undated draft sorts last', () => {
  const entries = [
    { row: { ResultKey: 'CR:old', RequestedAt: '2026-08-01T00:00:00Z' } },
    { row: { ResultKey: 'CR:none', RequestedAt: null } },
    { row: { ResultKey: 'CR:new', RequestedAt: '2026-08-24T00:00:00Z' } }
  ];
  assert.deepEqual(
    [...entries].sort(byRequestedAtDesc).map((entry) => entry.row.ResultKey),
    ['CR:new', 'CR:old', 'CR:none']
  );
});

test('only the fields S/4 can sort on are passed to it', () => {
  const ordering = remoteOrderBy([
    { ref: ['BusinessPartnerFullName'], sort: 'asc' },
    { ref: ['RecordStatus'], sort: 'desc' },
    { ref: ['ResultKey'], sort: 'asc' }
  ]);
  assert.deepEqual(ordering, [{ ref: ['BusinessPartnerFullName'], sort: 'asc' }]);
  assert.deepEqual(remoteOrderBy(), []);
});

/**
 * The path taken when a filter names a change-request field (see `referencedFields` above): the
 * whole merged list is filtered and paged in memory instead of leaving S/4 to page it, because
 * S/4 cannot filter on these fields at all.
 */
test('mergeLocalPage filters against entry.row, not entry.searchable', () => {
  const pending = [{
    row: { ResultKey: 'CR:1', RecordStatus: 'Create in approval', RequestedAt: '2026-08-27T00:00:00Z' },
    // Deliberately lacks RecordStatus - the point of the fix: matching runs against `row`.
    searchable: { BusinessPartnerFullName: 'Pending Co' }
  }];
  const partnerRows = [
    { row: { ResultKey: 'BP:1', RecordStatus: 'Active', RequestedAt: null }, searchable: {} },
    { row: { ResultKey: 'BP:2', RecordStatus: 'Change in approval', RequestedAt: '2026-08-20T00:00:00Z' }, searchable: {} }
  ];
  const where = [{ ref: ['RecordStatus'] }, '=', { val: 'Active' }];

  const active = mergeLocalPage({ pending, partnerRows, where });
  assert.deepEqual(active.rows.map((row) => row.ResultKey), ['BP:1']);
  assert.equal(active.count, 1);
});

test('mergeLocalPage sorts newest-requested first, across pending and marked partners alike', () => {
  const pending = [{ row: { ResultKey: 'CR:1', RequestedAt: '2026-08-01T00:00:00Z' } }];
  const partnerRows = [
    { row: { ResultKey: 'BP:1', RequestedAt: null } },
    { row: { ResultKey: 'BP:2', RequestedAt: '2026-08-24T00:00:00Z' } }
  ];
  const merged = mergeLocalPage({ pending, partnerRows, where: undefined });
  assert.deepEqual(merged.rows.map((row) => row.ResultKey), ['BP:2', 'CR:1', 'BP:1']);
});

test('mergeLocalPage pages the filtered result, and counts it exactly', () => {
  const partnerRows = [1, 2, 3, 4, 5].map((n) => ({ row: { ResultKey: `BP:${n}`, RequestedAt: null } }));
  const paged = mergeLocalPage({ partnerRows, where: undefined, skip: 2, top: 2 });
  assert.deepEqual(paged.rows.map((row) => row.ResultKey), ['BP:3', 'BP:4']);
  assert.equal(paged.count, 5);

  const unpaged = mergeLocalPage({ partnerRows, where: undefined });
  assert.equal(unpaged.rows.length, 5);
  assert.equal(unpaged.count, 5);
});

test('mergeLocalPage keeps a row an unsupported expression could not evaluate, and reports it', () => {
  const partnerRows = [{ row: { ResultKey: 'BP:1' } }];
  let reported = null;
  const weird = { func: 'unknownFunc', args: [] };
  const merged = mergeLocalPage({ partnerRows, where: [weird], onUnsupported: (expr) => { reported = expr; } });
  assert.deepEqual(merged.rows.map((row) => row.ResultKey), ['BP:1']);
  assert.equal(reported, weird);
});

// --- Wiring ---------------------------------------------------------------------------------

const root = (...segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');

test('the list report reads the merged entity, not the S/4 projection alone', () => {
  const manifest = JSON.parse(root('app', 'businesspartner', 'webapp', 'manifest.json'));
  const settings = manifest['sap.ui5'].routing.targets.BusinessPartnersList.options.settings;
  assert.equal(settings.contextPath, '/BusinessPartnerSearchResults');
  // The object page and the maintenance screens still read the partner itself.
  assert.equal(
    manifest['sap.ui5'].routing.targets.BusinessPartnersObjectPage.options.settings.contextPath,
    '/BusinessPartners'
  );
});

test('the status column is coloured by its criticality', () => {
  const annotations = root('srv', 'annotations.cds');
  assert.match(
    annotations,
    /\{ Value: RecordStatus, Label: 'Status', Criticality: RecordStatusCriticality \}/u
  );
});

/**
 * In OData V4 Fiori Elements the filter bar - and its "Adapt Filters" dialog - is built from
 * SelectionFields alone, unlike V2's "every property is a candidate" behaviour: a LineItem column
 * left out of SelectionFields is simply never offerable as a filter, however visible it already
 * is in the table (asked for 2026-08-27, widened to the change-request columns 2026-08-28). Every
 * column shown in the table's own Settings dialog must therefore also be a SelectionFields entry.
 */
test('every filterable table column is also offered by Adapt Filters', () => {
  const annotations = root('srv', 'annotations.cds');
  const start = annotations.indexOf('annotate service.BusinessPartnerSearchResults');
  const block = annotations.slice(start, annotations.indexOf(');', start) + 2);
  const selectionFields = block.slice(
    block.indexOf('UI.SelectionFields'), block.indexOf('UI.LineItem')
  );
  const lineItemFields = [...block.matchAll(/\{ Value: (\w+),/gu)].map((match) => match[1]);
  assert.ok(lineItemFields.length > 0, 'the LineItem columns could not be parsed');
  for (const field of lineItemFields) {
    assert.ok(selectionFields.includes(field), `${field} is a column but not offered as a filter`);
  }
});

/**
 * The change-request columns became filterable 2026-08-28 (asked for): a filter naming one is
 * evaluated locally against the full merged row rather than forwarded to S/4 - see
 * `referencedFields` and its use in the BusinessPartnerSearchResults READ handler. Only ResultKey
 * (a synthetic "BP:4711"/"CR:<uuid>" key) and RecordStatusCriticality (a bare colouring int) stay
 * non-filterable: neither means anything as a value to filter BY. Sorting stays disallowed for
 * every one of them - the staged half is sorted in memory, so sorting on any of these would
 * silently sort one half of the list only.
 */
test('the change-request columns are filterable but not sortable; two technical fields are neither', () => {
  const service = root('srv', 'business-partner-service.cds');
  const restrictions = service.slice(service.indexOf('entity BusinessPartnerSearchResults') - 2000);
  for (const capability of ['NonFilterableProperties', 'NonSortableProperties']) {
    assert.ok(restrictions.includes(capability), `${capability} is missing`);
  }
  const nonFilterable = restrictions.split('NonFilterableProperties')[1].split('NonSortableProperties')[0];
  // Bounded to the NonSortableProperties list itself, not "to end of file": unbounded would make
  // every positive assertion below trivially true against the entity's own field declarations.
  const nonSortable = restrictions.split('NonSortableProperties')[1].split('] }')[0];
  // Word-bounded: a plain `.includes('RecordStatus')` is also a hit inside
  // `RecordStatusCriticality`, the exact collision that made this assertion pass for the wrong
  // reason the first time it was written.
  const names = (text, field) => new RegExp(`\\b${field}\\b`, 'u').test(text);
  for (const field of ['RecordStatus', 'IsChangeRequest', 'ChangeRequestType', 'ChangeRequestStatus', 'RequestedBy', 'RequestedAt']) {
    assert.equal(names(nonFilterable, field), false, `${field} should be filterable now`);
    assert.ok(names(nonSortable, field), `${field} must stay non-sortable`);
  }
  for (const field of ['ResultKey', 'RecordStatusCriticality']) {
    assert.ok(names(nonFilterable, field), `${field} must stay non-filterable`);
    assert.ok(names(nonSortable, field), `${field} must stay non-sortable`);
  }
});

// A partner under a request is marked now. Hiding it also hid it from the display and edit screens.
test('a partner is no longer filtered out of the list by its change request', () => {
  const service = root('srv', 'business-partner-service.js');
  assert.equal(/applyChangeRequestExclusion/u.test(service), false);
  assert.equal(/MAX_EXCLUDED_PARTNERS/u.test(service), false);
});

// The lock and the list answer different questions; collapsing them would widen or narrow one.
test('the lock statuses stay wider than the in-progress statuses', () => {
  const { ACTIVE_REQUEST_STATUSES } = require('../srv/business-partner-service')._internals;
  for (const status of IN_PROGRESS_REQUEST_STATUSES) {
    assert.ok(ACTIVE_REQUEST_STATUSES.includes(status), `${status} is not a locking status`);
  }
  assert.ok(ACTIVE_REQUEST_STATUSES.length > IN_PROGRESS_REQUEST_STATUSES.length);
});

// The route exists so a request can be READ. Editing a draft stays on the steward-gated list.
test('a change request has a read-only route, and it is not the edit one', () => {
  const manifest = JSON.parse(root('app', 'businesspartner', 'webapp', 'manifest.json'));
  const routes = manifest['sap.ui5'].routing.routes;
  const display = routes.find((route) => route.name === 'ChangeRequestDisplay');
  assert.equal(display.pattern, 'ChangeRequests/{changeRequest}/display');
  assert.equal(display.target, 'BusinessPartnerMaintenance');
  assert.ok(routes.some((route) => route.name === 'ChangeRequestEdit'));
});

test('the view mode offers nothing to press', () => {
  const controller = root(
    'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
    'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  assert.match(controller, /\["ChangeRequestDisplay", this\._onRequestDisplayRoute\]/u);
  assert.match(controller, /_loadStagedRequest\([\s\S]{0,140}?"view"/u);
  assert.match(controller, /var viewing = mode === "view";/u);
  // A viewer is not an approver, and view mode must not re-run a check either.
  assert.match(controller, /state\.showCheckButton = !viewing;/u);
  assert.match(controller, /state\.showDecisionButtons = !editing && !viewing;/u);
  assert.match(
    controller,
    /state\.showDecisionButtons = !editing && !viewing && state\.requestStatus === "inApproval";/u
  );
});

// `$count` arrives as a STRING from the V2 remote, and the staged rows are added to it: `"323" + 57`
// is `"32358"`, which is what a 380-row list reported for a week. Both sides must be numbers.
test('the total is added to the remote count, never concatenated onto it', () => {
  const service = root('srv', 'business-partner-service.js');
  assert.match(service, /const remoteCount = Number\(page\.\$count \?\? page\.length\);/u);
  assert.match(service, /count: Number\.isFinite\(remoteCount\) \? remoteCount : page\.length/u);
  assert.match(service, /rows\.\$count = Number\(partners\.count\) \+ pending\.length;/u);
  // The bare `+` is what concatenated, so it must not come back.
  assert.equal(/\$count = partners\.count \+ pending\.length/u.test(service), false);
});

// Tried while the string count was being blamed on `$top=1`, and reverted once the arithmetic
// explained it: the remote counts the same whatever $top is, so one throwaway row is enough.
test('a count-only read asks for one row, not a page', () => {
  const service = root('srv', 'business-partner-service.js');
  assert.match(service, /const rows = top === 0 \? 1 : top;/u);
  assert.equal(/pageSize: top,/u.test(service), false);
});
