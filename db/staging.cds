namespace mdmlight.staging;

using { cuid, managed } from '@sap/cds/common';

/**
 * Staging for MDMLight change requests. Nothing here is master data - it holds
 * a request until every approval is in, at which point the payload is written
 * to S/4 through API_BUSINESS_PARTNER and the request is closed.
 */

type ChangeRequestType   : String(10) enum { create; change; block; delete };
type ChangeRequestStatus : String(12) enum {
  draft; inApproval; approved; rejected; posted; failed
};

/** One change request. BusinessPartner is null until a create is posted. */
entity ChangeRequests : cuid, managed {
  requestType     : ChangeRequestType   not null;
  status          : ChangeRequestStatus not null default 'draft';
  businessPartner : String(10);
  reason          : String(250);

  // ETag of the BP as read at request creation. Compared again before posting
  // so a concurrent S/4 change is detected instead of silently overwritten.
  sourceETag      : String(60);

  // Set once the post succeeds. Also the idempotency guard: a request that
  // already carries a number must never post again.
  postedBP        : String(10);
  postedAt        : Timestamp;

  payload         : Composition of one  ChangeRequestPayloads;
  beforeImage     : Composition of one  ChangeRequestBeforeImages;
  approvals       : Composition of many Approvals       on approvals.request = $self;
  findings        : Composition of many CheckFindings   on findings.request  = $self;
}

/** Requested state, as the JSON the S/4 write is assembled from. */
entity ChangeRequestPayloads : cuid {
  request  : Association to ChangeRequests;
  dataJson : LargeString not null;
}

/** BP state at request creation, for change/block/delete. Null for create. */
entity ChangeRequestBeforeImages : cuid {
  request  : Association to ChangeRequests;
  dataJson : LargeString not null;
  readAt   : Timestamp   not null;
}

entity Approvals : cuid, managed {
  request  : Association to ChangeRequests;
  step     : Integer      not null;
  approver : String(120);
  decision : String(10) enum { pending; approved; rejected } default 'pending';
  comment  : String(250);
  decidedAt: Timestamp;
}

/** Output of the duplicate and data quality checks. */
entity CheckFindings : cuid, managed {
  request     : Association to ChangeRequests;
  checkName   : String(60) not null;
  severity    : String(10) enum { info; warning; error } not null;
  message     : String(500);
  fieldName   : String(60);
  // For duplicate findings: the active BP matched, and how strongly.
  candidateBP : String(10);
  score       : Decimal(5, 4);
  isStale     : Boolean default false;
}
