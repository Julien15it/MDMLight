'use strict';

/**
 * The business partner lock: while a change request over a partner is in flight, nobody else may
 * raise a second one over the same partner, and nothing may write to it directly.
 *
 * Before this existed the only guard was `openEditPage` in CustomActions.js - client side, on the
 * list report alone, and reading the NARROWER in-flight marker. The display screen's own Edit button
 * went straight past it, so two people could have a change request over BP 20 in approval at once
 * and the second approval would post over the first one's staged values.
 *
 * One definition, three enforcement points: `persist` (change-request-service.js) refuses a second
 * request, `updateBusinessPartner` (business-partner-service.js) refuses Mark for Deletion, and
 * `businessPartnerLock` renders the refusal before a requester fills in a form for nothing.
 */

const cds = require('@sap/cds');
const { REQUEST_TYPE_LABELS, STATUS_LABELS } = require('./search-results');

const HEADER = 'mdmlight.staging.ChangeRequests';

/**
 * A partner is locked while a request over it is in any of these. `approved` counts because the post
 * is not atomic and may have left it half-written; `failed` for the same reason. `reworkRequired` and
 * `checkAndEnrich` count because a human is mid-edit, and unlocking the partner under them is exactly
 * what this prevents. `draft` counts too (decided 2026-09-15): a request nobody has submitted yet is
 * still somebody's work on that partner.
 *
 * **Accepted consequence of including `draft`:** a forgotten draft holds the partner, and the change
 * request list is steward-gated, so only a data steward can reach it to withdraw it. That is the
 * strict reading, chosen deliberately - see the lock section in `.claude/rules/staging.md`.
 *
 * This is `ACTIVE_REQUEST_STATUSES`, which business-partner-service.js re-exports from here so there
 * is exactly one list. Deliberately WIDER than `IN_PROGRESS_REQUEST_STATUSES` in search-results.js,
 * which answers a different question (is a human still holding this) for the merged list's marker.
 * **Do not collapse them.**
 */
const LOCKING_STATUSES = Object.freeze([
  'draft', 'inApproval', 'approved', 'reworkRequired', 'checkAndEnrich', 'failed'
]);

/** The columns a refusal message and the screen's strip are built from. */
const HOLDER_COLUMNS = Object.freeze([
  'ID', 'requestType', 'status', 'businessPartner',
  'createdBy', 'createdAt', 'submittedBy', 'submittedAt'
]);

/** Whoever actually has it: the submitter once submitted, the author while it is still a draft. */
function holderUser(holder) {
  return holder?.submittedBy || holder?.createdBy || '';
}

/**
 * One sentence naming the request in the way, for a 409 and for the screen. Deliberately names the
 * holder: "somebody else has it" that will not say who is a refusal nobody can act on.
 */
function lockMessage(holder, businessPartner) {
  const partner = businessPartner || holder?.businessPartner || '';
  const type = REQUEST_TYPE_LABELS[holder?.requestType] || holder?.requestType || 'change';
  const status = STATUS_LABELS[holder?.status] || holder?.status || '';
  const user = holderUser(holder);
  const by = user ? ` by ${user}` : '';
  return `Business Partner ${partner} is locked: a ${type} request${by} is ${status}. `
    + 'It has to be completed or withdrawn before another request can be raised.';
}

/**
 * The request holding `businessPartner`, or null when nothing does.
 *
 * **NOT best-effort, unlike every other staging read on these paths.** A lock that could not be read
 * must not read as "unlocked" - the standing rule about a check that could not run. Callers that
 * GATE a write let this throw and refuse the write; the one caller that only RENDERS
 * (`businessPartnerLock`) catches it and says the lock could not be read, because the server guard
 * is still behind it.
 *
 * `excludeRequest` is the request asking - a request never locks itself out of its own resubmit.
 */
async function lockHolder(businessPartner, { excludeRequest = null } = {}) {
  if (!businessPartner) return null;
  const db = await cds.connect.to('db');
  const rows = await db.run(
    cds.ql.SELECT.from(HEADER)
      .columns(...HOLDER_COLUMNS)
      .where({ businessPartner: String(businessPartner), status: { in: [...LOCKING_STATUSES] } })
  );
  // Filtered here rather than in the WHERE: a null `excludeRequest` has no clean CQN spelling, and a
  // partner never has more than a handful of requests over its whole history.
  return rows.find((row) => row.ID !== excludeRequest) || null;
}

/**
 * Refuses `req` with a 409 when the partner is held by someone else's request. Returns true when it
 * refused, so a caller can `if (await rejectWhenLocked(...)) return;` - `req.reject` throws in some
 * CAP paths and merely records in others, and the guards must not carry on either way.
 */
async function rejectWhenLocked(req, businessPartner, { excludeRequest = null } = {}) {
  const holder = await lockHolder(businessPartner, { excludeRequest });
  if (!holder) return false;
  req.reject(409, lockMessage(holder, businessPartner));
  return true;
}

module.exports = {
  LOCKING_STATUSES,
  HOLDER_COLUMNS,
  holderUser,
  lockHolder,
  lockMessage,
  rejectWhenLocked
};
