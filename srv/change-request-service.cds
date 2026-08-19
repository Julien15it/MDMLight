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

  /** Current findings only: a resubmit supersedes the previous set rather than deleting it, so
   *  without this one duplicate pair reads as several. `is null` covers rows predating the column. */
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
    Status        : String(20);
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
    Status            : String(20);
    ProcessInstanceId : String(60);
    /** True when the check found something and the submit is waiting for a
     *  confirming second press. */
    NeedsConfirmation : Boolean;
    /** False when a validation blocked. The request stays a draft, no workflow
     *  starts, and ValidationsJson says why. Derivations deliberately do NOT
     *  run here - see checkRequest. */
    Valid             : Boolean;
    ValidationsJson   : LargeString;
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
    Status          : String(20);
    BusinessPartner : String(10);
    Reason          : String(250);
    /** Why the approver sent it back, so the rework screen can lead with it. */
    RejectionComment : String(250);
    SubmittedBy     : String(120);
    SubmittedAt     : Timestamp;
    DataJson        : LargeString;
  };

  /**
   * The Check button: validate, derive, propose reformatting. Stages nothing.
   * Everything comes back as a *proposal* - the requester applies it, not this.
   * Duplicates are deliberately absent; see duplicateCheckRequest.
   */
  action checkRequest(
    ChangeRequest   : UUID,
    BusinessPartner : String(10),
    DataJson        : LargeString not null,
    /** False skips the AI Core normalisation call. Field triggers that only want the
     *  register (a tax number was entered) pass false; the Check button omits it. */
    Propose         : Boolean,
    /** Narrows the normalisation to one target - 'root' or a section name such as
     *  'addresses' - so a section trigger does not re-ask about the whole record. */
    Scope           : String(40)
  ) returns {
    /** False when a validation blocked; nothing after validation ran. */
    Valid             : Boolean;
    ValidationsJson   : LargeString;
    /** Values the derivations would fill into empty fields. Proposals only. */
    DerivationsJson   : LargeString;
    /** AI-proposed reformatting of fields that already have a value. Proposals
     *  only - nothing is applied until the requester accepts it. */
    NormalisationsJson : LargeString;
  };

  /**
   * The Duplicate Check button: validate -> derive -> match, order fixed in
   * srv/checks/pipeline.js. Derives in memory only and returns none of it.
   * `RanDuplicateCheck` false means an empty `DuplicatesJson` proves nothing.
   */
  action duplicateCheckRequest(
    ChangeRequest   : UUID,
    BusinessPartner : String(10),
    DataJson        : LargeString not null
  ) returns {
    /** False when a validation blocked; nothing after validation ran. */
    Valid             : Boolean;
    RanDuplicateCheck : Boolean;
    ValidationsJson   : LargeString;
    DuplicatesJson    : LargeString;
  };

  /**
   * The SPA decision callback. Records the outcome only - it never writes to
   * S/4, however many approvers the process routed the request through.
   * `approve` moves the request to `approved`, meaning every approval SPA
   * required is in and the request is waiting to be posted.
   *
   * `reject` is **no longer terminal** (2026-08-19): it moves the request to
   * `reworkRequired` and hands it back to the requester, who resubmits or
   * withdraws it. The process instance stays parked, because `resubmitRequest`
   * hands the request back to that same instance rather than starting a new one.
   * The comment goes to `rejectionComment`, never over the requester's `reason`.
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
    Status          : String(20);
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
    Status          : String(20);
    BusinessPartner : String(10);
  };

  /**
   * Rework, 2026-08-19. A rejection sends the request back to the requester
   * rather than ending it, so these two are the requester's way out of
   * `reworkRequired` — one back into approval, one out of existence.
   *
   * Both are the requester's actions, not SPA's. SPA only ever sends the
   * request back; what happens next is a human decision on the rework screen.
   */

  /**
   * Saves the reworked payload and hands it back to the **existing** SPA process
   * instance, which is still parked waiting for the requester. Runs exactly the
   * gates a first submit runs — the validations and the duplicate check, with the
   * same `Confirm` second press — because a reworked request is a request nobody
   * has judged yet.
   *
   * Returns the submit shape so the maintenance screen can reuse one code path
   * for submit and resubmit.
   */
  action resubmitRequest(
    ChangeRequest : UUID not null,
    RequestType   : String(10) not null,
    BusinessPartner : String(10),
    Reason        : String(250),
    DataJson      : LargeString not null,
    Confirm       : Boolean
  ) returns {
    ChangeRequest     : UUID;
    Status            : String(20);
    ProcessInstanceId : String(60);
    NeedsConfirmation : Boolean;
    Valid             : Boolean;
    ValidationsJson   : LargeString;
    MessagesJson      : LargeString;
  };

  /**
   * Cancels the request and **deletes it**, staging rows and all — the
   * compositions cascade. Only from `reworkRequired` or `draft`: anything that
   * has posted carries the `postedBP` idempotency guard, and destroying that
   * would let an SPA retry create a second business partner.
   */
  action withdrawRequest(
    ChangeRequest : UUID not null
  ) returns {
    ChangeRequest : UUID;
    Deleted       : Boolean;
  };
}
