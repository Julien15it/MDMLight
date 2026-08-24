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
  assert.deepEqual([...IN_PROGRESS_REQUEST_STATUSES], ['draft', 'inApproval', 'reworkRequired']);
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

// Sorting or filtering on a computed column would silently apply to one half of the list only.
test('the computed columns are neither filterable nor sortable', () => {
  const service = root('srv', 'business-partner-service.cds');
  const restrictions = service.slice(service.indexOf('entity BusinessPartnerSearchResults') - 2000);
  for (const capability of ['NonFilterableProperties', 'NonSortableProperties']) {
    assert.ok(restrictions.includes(capability), `${capability} is missing`);
  }
  for (const field of ['RecordStatus', 'IsChangeRequest', 'ChangeRequestStatus']) {
    assert.ok(
      restrictions.split('NonFilterableProperties')[1].includes(field),
      `${field} is still filterable`
    );
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

// The one read that skips the partner page still has to count it, and asking for a single row
// answered 32324 where every real page read of the same query answered 323.
test('a count-only remote read borrows the client page size rather than asking for one row', () => {
  const service = root('srv', 'business-partner-service.js');
  assert.match(service, /const rows = top === 0 \? Math\.max\(pageSize \|\| 1, 1\) : top;/u);
  // Threaded from the client's own $top, not invented.
  assert.match(service, /pageSize: top,/u);
  assert.equal(/const rows = top === 0 \? 1 : top;/u.test(service), false);
});
