'use strict';

/**
 * Who is responsible for a change request *right now* - the answer the screen shows at the top of a
 * request. Pure: the caller reads the header and resolves the approvers, this turns that into a step
 * and a list of people.
 *
 * **What this is not.** For a request in approval it reports the approvers the `WorkflowRules` table
 * resolves for the current payload - which is what CAP *sent* SBPA, not who SBPA actually assigned
 * the task to. Today those cannot even agree: Arthur's process ignores `approvers` entirely (see
 * CLAUDE.md, "Workflow rules"), and the rules table may have been edited since the submit. It is
 * the real answer only once the process routes on the list, and it must never be presented to a
 * user as SBPA's assignment.
 *
 * That caveat belongs HERE and not in the strip. It was in the strip until 2026-08-24, as "as sent
 * to the workflow", where it told a requester nothing they could act on and read as a hedge next to
 * a list of names it had already given them.
 */

/** `step` is the request's own lifecycle step, not an SBPA task name - SBPA owns however many. */
const STEPS = Object.freeze({
  submit: 'Submit',
  approval: 'Approval',
  rework: 'Rework',
  review: 'Data Steward Review',
  post: 'Post',
  done: 'Done',
  failed: 'Post failed'
});

const REQUESTER = 'requester';
const APPROVER = 'approver';

/** An APPROVER carrying an `@` is a person; anything else is a role SBPA resolves. Same rule as the
 *  wire uses, and the reason `kind` survives being flattened to a bare list of strings. */
const kindOf = (value) => (String(value || '').includes('@') ? 'user' : 'role');

// A requester is always a person, whatever their user id happens to look like - only the approver
// half of the workflow rules table can name a role.
function processor(value, role) {
  return { value: String(value), kind: role === REQUESTER ? 'user' : kindOf(value), role };
}

/** Whoever raised it, by whichever name the header carries. */
function requester(header = {}) {
  const who = header.submittedBy || header.createdBy;
  return who ? [processor(who, REQUESTER)] : [];
}

/**
 * The step, the people, and a sentence for the screen. `approvers` is only read for `inApproval`,
 * `dataStewards` only for `checkAndEnrich` - resolving either for a status that is not theirs would
 * name people who are not responsible for anything yet.
 */
function currentProcessors(header = {}, approvers = [], dataStewards = []) {
  const status = header.status;

  if (status === 'draft') {
    return {
      step: STEPS.submit,
      processors: requester(header),
      note: 'Not submitted yet. It is still the requester\'s to finish.'
    };
  }

  if (status === 'inApproval') {
    const processors = approvers.map((approver) => processor(approver.value ?? approver, APPROVER));
    return {
      step: STEPS.approval,
      processors,
      // No note when they are named: the strip already lists them, and the caveat about where the
      // list comes from is for whoever maintains this - see the header - not for a requester
      // reading the screen. An empty list is the case that does need a sentence.
      note: processors.length
        ? ''
        : 'No workflow rule names an approver for this request, so the workflow routes it itself'
          + ' - who holds the task is only visible in the approver\'s inbox.'
    };
  }

  if (status === 'checkAndEnrich') {
    const processors = dataStewards.map((email) => processor(email, 'dataSteward'));
    return {
      step: STEPS.review,
      processors,
      note: processors.length
        ? ''
        : 'No data steward could be resolved for this request, so nobody is named here - see the'
          + ' DataSteward role in the BTP subaccount, or check with a subaccount administrator.'
    };
  }

  // `rejected` is never written any more but cannot be dropped from the enum, so it is read as the
  // rework it has become rather than falling through to "nobody".
  if (status === 'reworkRequired' || status === 'rejected') {
    return {
      step: STEPS.rework,
      processors: requester(header),
      note: 'Sent back to the requester, who resubmits it or withdraws it.'
    };
  }

  if (status === 'approved') {
    return {
      step: STEPS.post,
      processors: [],
      // Nobody is a person here, and saying so beats naming someone who cannot act.
      note: 'Approved and waiting to be posted to S/4. The workflow triggers the post, not a person.'
    };
  }

  if (status === 'posted') {
    return {
      step: STEPS.done,
      processors: [],
      note: 'Posted to S/4. Nothing is outstanding.'
    };
  }

  if (status === 'failed') {
    return {
      step: STEPS.failed,
      processors: [],
      note: 'The post to S/4 failed. A data steward has to pick this up - it will not retry itself.'
    };
  }

  return { step: status || '', processors: [], note: '' };
}

/** One line for the message strip: `Approval - with maarten@x.eu, Sales Approver`. */
function describeProcessors(current = {}) {
  const names = (current.processors || []).map((entry) => entry.value);
  const step = current.step ? `Current step: ${current.step}` : 'Current step unknown';
  return names.length ? `${step} - with ${names.join(', ')}` : step;
}

module.exports = {
  STEPS,
  kindOf,
  currentProcessors,
  describeProcessors
};
