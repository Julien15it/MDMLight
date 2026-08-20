using { mdmlight.staging as staging } from '../db/staging';

/**
 * Change request lifecycle: stage a request, hand it to SPA, serve it back to the approve view, post
 * it once approved. It never talks to S/4 directly - posting is delegated to BusinessPartnerService,
 * which owns the connection, the payload sanitizing and the maintenance config.
 */
service ChangeRequestService @(path: '/service/changerequest') {

  /** Read-only. Writes go through the actions so status can never be forged. */
  @readonly entity ChangeRequests as projection on staging.ChangeRequests;

  /** Current findings only: a resubmit supersedes the previous set rather than deleting it, so
   *  without this one duplicate pair reads as several. `is null` covers rows predating the column. */
  @readonly entity CheckFindings  as
    select from staging.CheckFindings
    where isStale is null or isStale = false;

  /** Creates or updates a request and its staged nodes from the screen's own `{ root, sections }`
   *  shape, and leaves it in `draft` - no workflow starts. */
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

  /** Saves, then moves to `inApproval` and starts the SPA workflow. A failed start stays `draft`:
   *  `inApproval` with no process behind it would be invisible to everyone. */
  action submitRequest(
    ChangeRequest : UUID,
    RequestType   : String(10) not null,
    BusinessPartner : String(10),
    Reason        : String(250),
    DataJson      : LargeString not null,
    /** The confirming second press. Without it a request that matched stays a draft and reports it. */
    Confirm       : Boolean
  ) returns {
    ChangeRequest     : UUID;
    Status            : String(20);
    ProcessInstanceId : String(60);
    /** True when the check found something and the submit is waiting for a
     *  confirming second press. */
    NeedsConfirmation : Boolean;
    /** False when a validation blocked: stays a draft and ValidationsJson says why. Derivations
     *  deliberately do NOT run here - see checkRequest. */
    Valid             : Boolean;
    ValidationsJson   : LargeString;
    /** Findings for the message area, newest check only. */
    MessagesJson      : LargeString;
  };

  /** Serves a request back in the shape the screen sends, so the approve view reuses one code path. */
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

  /** The Check button: validate, derive, propose reformatting, stage nothing. Everything comes back
   *  as a proposal for the requester to apply. Duplicates are deliberately absent. */
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

  /** The Duplicate Check button: validate -> derive -> match. Derives in memory only and returns
   *  none of it. `RanDuplicateCheck` false means an empty `DuplicatesJson` proves nothing. */
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
   * The SPA decision callback. Records the outcome only and never writes to S/4: `approve` means
   * every approval SPA wanted is in and the request waits to be posted. `reject` is NOT terminal -
   * it goes to `reworkRequired` and back to the requester, leaving the instance parked for
   * `resubmitRequest`, with the comment on `rejectionComment` rather than over `reason`.
   */
  action decideRequest(
    ChangeRequest : UUID not null,
    Decision      : String(10) not null,
    Comment       : String(250),
    /** Default true. The task form sets it false: completing the task already resumes the workflow,
     *  so signalling here too would deliver the same decision twice. */
    SignalWorkflow : Boolean
  ) returns {
    ChangeRequest   : UUID;
    Status          : String(20);
    BusinessPartner : String(10);
  };

  /**
   * The "all approvals collected" signal, and the only thing that writes to S/4 - so how many
   * approvers there were and what picked them stays entirely on SPA's side. Idempotent: a request
   * that already carries a number returns it unchanged, so a retried callback creates nothing.
   */
  action completeRequest(
    ChangeRequest : UUID not null
  ) returns {
    ChangeRequest   : UUID;
    Status          : String(20);
    BusinessPartner : String(10);
  };

  // The requester's two ways out of `reworkRequired` - one back into approval, one out of existence.
  // SPA only ever sends the request back; what happens next is a human decision on the rework screen.

  /**
   * Saves the reworked payload and hands it back to the EXISTING parked instance. Runs every gate a
   * first submit runs, `Confirm` included, because a reworked request is one nobody has judged.
   * Returns the submit shape, so the screen reuses one code path for both.
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
   * Takes a request the approver sent back out of `inApproval` and into `reworkRequired`, so the
   * rework screen can offer Resubmit/Withdraw. A stopgap for the missing SPA reject callback: the
   * `reworkurl` is only ever sent by the rejection branch, so arriving on that screen is the only
   * evidence CAP gets that the request came back. No-op on any other status, and the workflow is
   * deliberately NOT signalled - the process already took its rejection branch.
   */
  action claimRework(
    ChangeRequest : UUID not null
  ) returns {
    ChangeRequest : UUID;
    Status        : String(20);
    /** True only when this call moved the status. False means it was already there, or elsewhere. */
    Claimed       : Boolean;
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
