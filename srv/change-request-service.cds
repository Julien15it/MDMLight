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

  /**
   * Current findings only. A resubmit supersedes the previous set instead of deleting it, so
   * without this filter every attempt's findings are served at once and one duplicate pair reads
   * as several. The superseded rows stay in the table for audit, reachable only by SQL.
   * `is null` is required: rows written before the column existed carry no value.
   */
  @readonly entity CheckFindings  as
    select from staging.CheckFindings
    where isStale is null or isStale = false;

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
    DataJson      : LargeString not null,
    /** Set by the second press. Without it a request whose duplicate check
     *  found anything stays a draft and reports what it found, so nobody
     *  starts an approval for a partner that may already exist. */
    Confirm       : Boolean
  ) returns {
    ChangeRequest     : UUID;
    Status            : String(12);
    ProcessInstanceId : String(60);
    /** True when the check found something and the submit is waiting for a
     *  confirming second press. */
    NeedsConfirmation : Boolean;
    /** Findings for the message area, newest check only. */
    MessagesJson      : LargeString;
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
   * Runs the check pipeline over an unsaved payload and reports what it found.
   * **Stages nothing and starts nothing** - this is the Check button, not a
   * dry-run submit, so pressing it can never leave a row behind.
   *
   * Order is validate -> derive -> duplicate check, and it is fixed in
   * srv/checks/pipeline.js: invalid data cannot be a duplicate, and incomplete
   * data can be missing the fields a duplicate rule needs. A blocking
   * validation therefore stops the rest, and `RanDuplicateCheck` says whether
   * the duplicate check got as far as running - an empty `DuplicatesJson` on
   * its own does not mean "no duplicates".
   */
  action checkRequest(
    ChangeRequest   : UUID,
    BusinessPartner : String(10),
    DataJson        : LargeString not null
  ) returns {
    /** False when a validation blocked; nothing after validation ran. */
    Valid             : Boolean;
    RanDuplicateCheck : Boolean;
    ValidationsJson   : LargeString;
    /** Fields the derivations filled in, for the screen to apply and show. */
    DerivationsJson   : LargeString;
    DuplicatesJson    : LargeString;
  };

  /**
   * The SPA decision callback. Records the outcome only - it never writes to
   * S/4, however many approvers the process routed the request through.
   * `approve` moves the request to `approved`, meaning every approval SPA
   * required is in and the request is waiting to be posted. `reject` is
   * terminal. Staged rows are kept either way - retention is an open decision.
   */
  action decideRequest(
    ChangeRequest : UUID not null,
    Decision      : String(10) not null,
    Comment       : String(250),
    /** Default true. The UI5 task form sets it false: completing the task in
     *  My Inbox is itself what resumes the workflow, so firing our own BPA
     *  trigger as well would signal the same decision twice. */
    SignalWorkflow : Boolean
  ) returns {
    ChangeRequest   : UUID;
    Status          : String(12);
    BusinessPartner : String(10);
  };

  /**
   * The "all approvals collected" signal, and the only thing that writes to
   * S/4. SPA calls it once its approval chain finishes, so the number of
   * approvers and the criteria that picked them stay entirely on the SPA side.
   * Idempotent: a request that already carries a number returns it unchanged,
   * so a retried callback cannot create a second business partner.
   */
  action completeRequest(
    ChangeRequest : UUID not null
  ) returns {
    ChangeRequest   : UUID;
    Status          : String(12);
    BusinessPartner : String(10);
  };
}
