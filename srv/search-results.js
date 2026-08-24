/**
 * The merged search list: live S/4 partners and the change requests still in flight, in one result
 * set. Pure functions only - the READ handler in business-partner-service.js owns the two reads and
 * calls in here to filter, shape and page what came back.
 *
 * A pending create has no partner number yet, so it can only appear as its own row. A change, block
 * or delete request over an existing partner is that partner's row, marked: staging holds a second
 * copy of the same company, and listing both would report one company twice.
 */

/**
 * In progress for this list: a request a human still owns. `approved` (waiting to post) and
 * `failed` are out - those belong to the post, not to somebody deciding whether to raise a request.
 * Narrower than ACTIVE_REQUEST_STATUSES, which is a lock and must stay wider than this on purpose.
 */
const IN_PROGRESS_REQUEST_STATUSES = Object.freeze(['draft', 'inApproval', 'reworkRequired']);

const REQUEST_TYPE_LABELS = Object.freeze({
  create: 'Create', change: 'Change', block: 'Block', delete: 'Delete'
});

const STATUS_LABELS = Object.freeze({
  draft: 'draft',
  inApproval: 'in approval',
  reworkRequired: 'rework required',
  approved: 'approved',
  failed: 'post failed'
});

/** UI.Criticality. Anything in flight is critical-warning; a plain partner is neutral, not positive:
 *  green on every row would leave nothing for the exception to stand out against. */
const CRITICALITY = Object.freeze({ neutral: 0, inFlight: 2 });

const ACTIVE_STATUS = 'Active';

/** The columns read from S/4 for this list. Fixed rather than taken from the request: the client
 *  asks for computed columns that exist here and nowhere in S/4, and a projection that leaks one of
 *  those fails the whole remote read. */
const PARTNER_FIELDS = Object.freeze([
  'BusinessPartner',
  'BusinessPartnerFullName',
  'BusinessPartnerCategory',
  'BusinessPartnerGrouping',
  'SearchTerm1',
  'BusinessPartnerIsBlocked'
]);

/** Only these can be sorted remotely; the key is this list's own and S/4 has never heard of it. */
const SORTABLE_FIELDS = Object.freeze([...PARTNER_FIELDS, 'BusinessPartnerName', 'FirstName', 'LastName']);

function statusOf(request) {
  if (!request) return { RecordStatus: ACTIVE_STATUS, RecordStatusCriticality: CRITICALITY.neutral };
  const type = REQUEST_TYPE_LABELS[request.requestType] || request.requestType || 'Request';
  const status = STATUS_LABELS[request.status] || request.status || '';
  return {
    RecordStatus: `${type} ${status}`.trim(),
    RecordStatusCriticality: CRITICALITY.inFlight
  };
}

function requestFields(request) {
  return {
    ChangeRequest: request ? request.ID : null,
    ChangeRequestType: request ? request.requestType : null,
    ChangeRequestStatus: request ? request.status : null,
    RequestedBy: request ? (request.submittedBy || request.createdBy || null) : null,
    RequestedAt: request ? (request.submittedAt || request.createdAt || null) : null
  };
}

/**
 * The name a staged create should be listed under. S/4 derives BusinessPartnerFullName; staging has
 * only the fields it was typed into, so the same order of preference is applied here by hand.
 */
function stagedFullName(general = {}) {
  const organisation = [general.OrganizationBPName1, general.OrganizationBPName2]
    .filter(Boolean).join(' ').trim();
  const person = [general.FirstName, general.MiddleName, general.LastName]
    .filter(Boolean).join(' ').trim();
  const group = [general.GroupBusinessPartnerName1, general.GroupBusinessPartnerName2]
    .filter(Boolean).join(' ').trim();
  return organisation || person || group || String(general.SearchTerm1 || '').trim();
}

/** A pending create as a row, plus the staged record it is matched against. */
function pendingCreateEntry(entry = {}) {
  const request = entry.request || {};
  const general = entry.general || {};
  const fullName = stagedFullName(general);
  return {
    row: {
      ResultKey: `CR:${request.ID}`,
      // A create has no number until it posts. Empty, never a placeholder that could be searched for.
      BusinessPartner: '',
      BusinessPartnerFullName: fullName,
      BusinessPartnerCategory: general.BusinessPartnerCategory || null,
      BusinessPartnerGrouping: general.BusinessPartnerGrouping || null,
      SearchTerm1: general.SearchTerm1 || null,
      BusinessPartnerIsBlocked: Boolean(general.BusinessPartnerIsBlocked),
      ...statusOf(request),
      IsChangeRequest: true,
      ...requestFields(request)
    },
    // Matched against the staged fields rather than the row: a search for a last name must find a
    // pending person even though the list only shows the composed full name.
    searchable: {
      ...general,
      BusinessPartner: '',
      BusinessPartnerFullName: fullName,
      BusinessPartnerIsBlocked: Boolean(general.BusinessPartnerIsBlocked)
    }
  };
}

/** A live partner as a row, marked when a request over it is in flight. */
function partnerEntry(partner = {}, request = null) {
  const row = { ResultKey: `BP:${partner.BusinessPartner}`, IsChangeRequest: false };
  for (const field of PARTNER_FIELDS) row[field] = partner[field] ?? null;
  return { row: { ...row, ...statusOf(request), ...requestFields(request) }, searchable: partner };
}

// --- CQN filtering of the staged half -------------------------------------------------------

const COMPARATORS = Object.freeze({
  '=': (left, right) => compare(left, right) === 0,
  '==': (left, right) => compare(left, right) === 0,
  '!=': (left, right) => compare(left, right) !== 0,
  '<>': (left, right) => compare(left, right) !== 0,
  '<': (left, right) => lessThan(left, right),
  '>': (left, right) => lessThan(right, left),
  '<=': (left, right) => !lessThan(right, left),
  '>=': (left, right) => !lessThan(left, right)
});

function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

function compare(left, right) {
  // A boolean comparison coerces both sides before the emptiness test: a staged column nobody set
  // is null, and `Blocked = false` has to find the pending create that nobody blocked.
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return Boolean(left) === Boolean(right) ? 0 : NaN;
  }
  if (isEmpty(left) && isEmpty(right)) return 0;
  if (isEmpty(left) || isEmpty(right)) return NaN;
  return String(left).toLowerCase() === String(right).toLowerCase() ? 0 : NaN;
}

function lessThan(left, right) {
  if (isEmpty(left) || isEmpty(right)) return false;
  if (typeof left === 'number' || typeof right === 'number') return Number(left) < Number(right);
  return String(left).toLowerCase() < String(right).toLowerCase();
}

// The remote serializer doubles embedded quotes on the way out; undo that before comparing in memory.
const literal = (value) => (typeof value === 'string' ? value.replaceAll("''", "'") : value);

const text = (value) => String(value ?? '').toLowerCase();

function callFunction(node, record) {
  const name = String(node.func || '').toLowerCase();
  const args = (node.args || []).map((argument) => valueOf(argument, record));
  switch (name) {
    case 'contains': return text(args[0]).includes(text(literal(args[1])));
    case 'startswith': return text(args[0]).startsWith(text(literal(args[1])));
    case 'endswith': return text(args[0]).endsWith(text(literal(args[1])));
    case 'tolower': return text(args[0]);
    case 'toupper': return String(args[0] ?? '').toUpperCase();
    default: return undefined;
  }
}

function valueOf(node, record) {
  if (node === null || node === undefined) return undefined;
  if (typeof node !== 'object') return node;
  if ('val' in node) return node.val;
  if (node.ref) return record[node.ref[node.ref.length - 1]];
  if (node.func) return callFunction(node, record);
  if (node.list) return node.list.map((item) => valueOf(item, record));
  return undefined;
}

function splitOn(tokens, operator) {
  const groups = [[]];
  for (const token of tokens) {
    if (typeof token === 'string' && token.toLowerCase() === operator) groups.push([]);
    else groups[groups.length - 1].push(token);
  }
  return groups;
}

/**
 * Enough of CQN to evaluate what the filter bar and the search rewrite produce. Anything else is
 * reported as unsupported and the row is **kept**: a staged request wrongly shown is a nuisance, one
 * wrongly hidden is the failure this whole list exists to prevent.
 */
function evaluateTokens(tokens, record, report) {
  const parts = tokens.filter((token) => token !== undefined && token !== null);
  if (parts.length === 0) return true;

  const orGroups = splitOn(parts, 'or');
  if (orGroups.length > 1) {
    return orGroups.some((group) => evaluateTokens(group, record, report));
  }

  const andGroups = splitOn(parts, 'and');
  if (andGroups.length > 1) {
    return andGroups.every((group) => evaluateTokens(group, record, report));
  }

  if (typeof parts[0] === 'string' && parts[0].toLowerCase() === 'not') {
    return !evaluateTokens(parts.slice(1), record, report);
  }

  if (parts.length === 1) {
    const [only] = parts;
    if (only && only.xpr) return evaluateTokens(only.xpr, record, report);
    const value = valueOf(only, record);
    if (typeof value === 'boolean') return value;
    report(only);
    return true;
  }

  if (parts.length === 3 && typeof parts[1] === 'string') {
    const operator = parts[1].toLowerCase();
    const left = parts[0] && parts[0].xpr ? undefined : valueOf(parts[0], record);
    const right = parts[2] && parts[2].xpr ? undefined : valueOf(parts[2], record);

    if (COMPARATORS[operator]) return COMPARATORS[operator](left, right);
    if (operator === 'in') return (Array.isArray(right) ? right : []).some((item) => compare(left, item) === 0);
    if (operator === 'not in') return !(Array.isArray(right) ? right : []).some((item) => compare(left, item) === 0);
    if (operator === 'like') {
      // CAP turns `contains` into LIKE '%x%' against SQL; the remote path never does, but a client
      // filter can. Only the wildcards CAP itself emits are honoured.
      const pattern = String(literal(right) ?? '').replaceAll('%', '');
      return text(left).includes(text(pattern));
    }
    if (operator === 'is' || operator === 'is not') {
      const wanted = operator === 'is';
      return isEmpty(left) === wanted;
    }
  }

  report(parts);
  return true;
}

/** True when the staged record satisfies the client's filter. */
function matchesWhere(record, where, onUnsupported = () => {}) {
  if (!where || where.length === 0) return true;
  return evaluateTokens(where, record, onUnsupported);
}

/**
 * Every search term must hit at least one searchable field - the same rule the remote read applies,
 * so the two halves of the list agree on what a two-word search means.
 */
function matchesTerms(record, terms = [], fields = []) {
  if (terms.length === 0) return true;
  return terms.every((term) => fields.some((field) => text(record[field]).includes(text(term))));
}

// --- Paging ---------------------------------------------------------------------------------

/**
 * How much of the remote read is still needed once the staged rows have taken their place. They
 * always come first: a pending create has no partner number, so with the default sort it belongs at
 * the top, and putting it there is what makes the paging arithmetic exact rather than approximate.
 */
function pageSplit({ pendingCount = 0, skip = 0, top }) {
  const pendingSkip = Math.min(skip, pendingCount);
  const pendingTaken = top === undefined
    ? pendingCount - pendingSkip
    : Math.max(0, Math.min(pendingCount - pendingSkip, top));
  return {
    pendingSkip,
    pendingTaken,
    partnerSkip: Math.max(0, skip - pendingCount),
    partnerTop: top === undefined ? undefined : top - pendingTaken
  };
}

/** Newest request first, matching the change request list; an undated draft sorts last. */
function byRequestedAtDesc(left, right) {
  const leftAt = left.row.RequestedAt ? new Date(left.row.RequestedAt).getTime() : 0;
  const rightAt = right.row.RequestedAt ? new Date(right.row.RequestedAt).getTime() : 0;
  return rightAt - leftAt;
}

/** Which of the sort fields the client asked for the remote read can actually honour. */
function remoteOrderBy(orderBy = []) {
  return orderBy.filter((entry) => {
    const field = entry && entry.ref ? entry.ref[entry.ref.length - 1] : null;
    return field && SORTABLE_FIELDS.includes(field);
  });
}

module.exports = {
  IN_PROGRESS_REQUEST_STATUSES,
  PARTNER_FIELDS,
  SORTABLE_FIELDS,
  CRITICALITY,
  ACTIVE_STATUS,
  statusOf,
  stagedFullName,
  pendingCreateEntry,
  partnerEntry,
  matchesWhere,
  matchesTerms,
  pageSplit,
  byRequestedAtDesc,
  remoteOrderBy
};
