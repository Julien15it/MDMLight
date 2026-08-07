using { mdmlight.staging as staging } from '../db/staging';

/**
 * Change request lifecycle. Deliberately small: it stores a request in the
 * staging tables, hands it to SAP Build Process Automation, serves it back to
 * the approve view, and posts it to S/4 once approved.
 *
 * It never talks to S/4 directly - posting is delegated to
 * BusinessPartnerService, which already owns the API_BUSINESS_PARTNER
 * connection, payload sanitizing and the per-entity maintenance config.
 */
service ChangeRequestService @(path: '/service/changerequest') {

  /** Read-only. Writes go through the actions so status can never be forged. */
  @readonly entity ChangeRequests as projection on staging.ChangeRequests;
  @readonly entity CheckFindings  as projection on staging.CheckFindings;

  /**
   * Creates or updates a request and its staged nodes. `DataJson` is the
   * maintenance screen's own shape: { root: {...}, sections: { Addresses: [...] } }.
   * Leaves the request in `draft` - no workflow is started.
   */
  action saveRequest(
    ChangeRequest : UUID,
    RequestType   : String(10) not null,
    BusinessPartner : String(10),
    Reason        : String(250),
    DataJson      : LargeString not null
  ) returns {
    ChangeRequest : UUID;
    Status        : String(12);
  };

  /**
   * Saves as above, then moves the request to `inApproval` and starts the SPA
   * workflow. A workflow that fails to start leaves the request in `draft` so
   * it can be resubmitted - a request sitting in `inApproval` with no process
   * behind it would be invisible to everyone.
   */
  action submitRequest(
    ChangeRequest : UUID,
    RequestType   : String(10) not null,
    BusinessPartner : String(10),
    Reason        : String(250),
    DataJson      : LargeString not null
  ) returns {
    ChangeRequest     : UUID;
    Status            : String(12);
    ProcessInstanceId : String(60);
  };

  /**
   * Serves a staged request back in the same shape the maintenance screen
   * sends, so the approve view can render it with the existing code path.
   */
  function getRequestPayload(
    ChangeRequest : UUID not null
  ) returns {
    ChangeRequest   : UUID;
    RequestType     : String(10);
    Status          : String(12);
    BusinessPartner : String(10);
    Reason          : String(250);
    SubmittedBy     : String(120);
    SubmittedAt     : Timestamp;
    DataJson        : LargeString;
  };

  /**
   * The SPA callback. `approve` posts the staged data to S/4 and records the
   * resulting number; `reject` only sets the status. Staged rows are kept
   * either way - retention is an open decision.
   */
  action decideRequest(
    ChangeRequest : UUID not null,
    Decision      : String(10) not null,
    Comment       : String(250)
  ) returns {
    ChangeRequest   : UUID;
    Status          : String(12);
    BusinessPartner : String(10);
  };
}
