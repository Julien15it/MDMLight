'use strict';

/**
 * SAP's own standard and SPRO checks, run over a staged request before it is created.
 *
 * What this answers: **would S/4 accept this partner?** `API_BUSINESS_PARTNER` runs its checks
 * only at activation and has no validate-only mode -- the service has exactly one function
 * import, `DuplicateCheck` -- so a request could pass every approval and then bounce on
 * customizing nobody in the app can see. `ZMDML_BPCHECK` wraps `CL_MD_BP_MAINTAIN`, whose
 * `MAINTAIN( i_test_run = 'X' )` walks the real activation path and issues no COMMIT.
 *
 * Measured against client 100 on 2026-08-26, the messages this brings back include: correspondence
 * language is person-only on an organisation (`R11/336`), an EU vendor needs a VAT registration
 * number (`VMD_API/043`), STCEG plausibility (`CVI_API/007`), and a grouping with external number
 * assignment (`R1/091`). None of those are derivable from this app's own tables.
 *
 * Two things this deliberately does NOT do:
 *
 * - **Field properties.** This app owns them; they live in its own configuration tables and are
 *   not mirrored from SPRO, because keeping a two-way binding in step is more machinery than the
 *   app wants. The service separates SAP's field-status verdicts into `SuppressedJson`, which this
 *   module never surfaces. Measured empty in practice -- a test run does not reach that layer at
 *   all -- so this is a safety net rather than a filter that does daily work.
 * - **Roles, by default.** See `INCLUDE_ROLES` below. This is about number ranges, not coverage.
 */

const cds = require('@sap/cds');

const SERVICE = 'ZMDML_BPCHECK';

// Read from the live $metadata on 2026-08-26, not guessed. `srvd_a2x` (not `srvd`) is the Web API
// binding flavour, and `check` is collection-bound -- `_it` is a Collection -- so it hangs off the
// entity set rather than a keyed instance.
const ACTION = 'BPChecks/com.sap.gateway.srvd_a2x.zmdml_bpcheck.v0001.check';

/**
 * **The tier switch, and it is about number ranges.**
 *
 * CVI syncs a vendor because the BP carries a vendor role, and that one sync both produces the
 * vendor-level checks and draws a vendor number. The two are inseparable -- measured: dropping the
 * supplier node changed neither the messages nor the draw, and `ROLLBACK WORK` does not return the
 * number because number assignment commits outside the calling LUW.
 *
 * With roles: `VMD_API/043` and `CVI_API/007` arrive, and `NRIV KREDITOR/02` advances by a buffer
 * block every run that reaches `MAINTAIN`. Without: no number is drawn from any range, and the BP
 * central-data checks still come through.
 *
 * `false` here because the Check button is pressed repeatedly while a form is being filled in, and
 * spending a vendor number per press is not defensible. The consequence is stated in `coverage`
 * rather than hidden: role validity is NOT checked, because the roles are not sent.
 *
 * Pending a product decision on number-range gaps. The full tier belongs at submit, or better at
 * the enricher step, where it runs once per request.
 */
const INCLUDE_ROLES = false;

// Relations are irrelevant to the draw -- that comes from the role -- so this only matters for a
// genuinely BP-only request. Off with roles off, since a relation node without its role is noise.
const INCLUDE_RELATIONS = false;

/**
 * Warning, not error, and this is the knob -- same reasoning as `ROLE_CATEGORY_SEVERITY` in
 * cvi-checks.js. The costs are not symmetric: a warning on something S/4 would have accepted is
 * noise, while blocking a legitimate request leaves a requester unable to submit and with nothing
 * to argue against.
 *
 * The argument for raising it is `R1/091` -- a grouping with external number assignment genuinely
 * cannot be created, so warning about it lets a doomed request through approval, which is the very
 * thing this feature exists to prevent. Raise to 'error' once these messages have been seen to be
 * right on real data at a real customer.
 */
const MAX_SEVERITY = 'warning';

const RANK = { info: 0, warning: 1, error: 2 };

// SAP message type -> pipeline severity. A and X are aborts, which are errors here.
const SEVERITY = { A: 'error', X: 'error', E: 'error', W: 'warning', I: 'info', S: 'info' };

const CHECK_NAME = 'sap_standard_checks';

function cap(severity) {
  const wanted = SEVERITY[String(severity || '').toUpperCase()] || 'info';
  return RANK[wanted] > RANK[MAX_SEVERITY] ? MAX_SEVERITY : wanted;
}

function parse(json, label) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (error) {
    console.warn(`[bp-check] ${label} was not readable JSON:`, error.message);
    return null;
  }
}

/**
 * `R11/336` came back twice for every payload carrying a role and once without one, so the
 * duplicate is the BP path and the CVI path each firing the same validation. That is real
 * information, so the count is kept rather than collapsed silently.
 */
function dedupe(messages) {
  const byKey = new Map();
  for (const message of messages) {
    const key = `${message.id}|${message.number}|${message.text}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.occurrences += 1;
      continue;
    }
    byKey.set(key, { ...message, occurrences: 1 });
  }
  return [...byKey.values()];
}

/**
 * The two stages anchor differently, and that is in the ABAP types rather than a choice.
 * `VALIDATE_SINGLE` returns `MDG_BS_BP_MSGMAP_T`, which carries some context; `MAINTAIN` returns
 * `BAPIRETM -> BAPIRETI -> BAPIRETC`, and `BAPIRETC` has no `FIELD` and no `ROW` at all. So a
 * TESTRUN message can only attach to the request as a whole, which is why the stage is named in
 * the text and no message is anchored to an input.
 *
 * S/4's `field` is deliberately NOT mapped onto the pipeline's `field`. The one value ever observed
 * was `0002` -- a grouping *value*, not a field name -- so handing it to the UI would highlight the
 * wrong input. The message class and number go in the text instead, which is where they are useful
 * to a human reading the list and to anyone diagnosing it later.
 */
function describe(message) {
  const where = message.stage === 'VALIDATE' ? 'validation' : 'activation';
  const code = message.id && message.number ? ` [${message.id}/${message.number}]` : '';
  const repeat = message.occurrences > 1 ? ` (reported ${message.occurrences} times)` : '';
  return `S/4 ${where}${code}: ${message.text}${repeat}`;
}

// `{ check, severity, message }` and nothing else -- the shape every other stage returns. The
// class, number, stage and repeat count all live in the text rather than as extra keys.
function toFindings(messages) {
  return dedupe(messages).map((message) => ({
    severity: cap(message.severity),
    message: describe(message)
  }));
}

/**
 * What was not looked at, said out loud. A clean message list means "nothing SAP checked
 * objected", not "the request is good": field properties are excluded by design, roles are not
 * sent under the cheap tier, and six staged nodes have no CVI counterpart at all
 * (`CustomerTaxGrouping`, the address-info nodes, `SupplierDunning`). Silence must not read as
 * approval.
 */
function coverageNotes(coverage) {
  if (!coverage) return [];
  const notes = [];
  if (coverage.rolesIncluded === false) {
    // Deliberately does not promise that submit checks them -- submit does not run this yet, and
    // saying so would be an overclaim a requester would rely on.
    notes.push('Business partner roles were left out of this check, so anything specific to the '
      + 'customer or supplier side has not been checked against S/4.');
  }
  if (coverage.fieldPropertiesExcluded) {
    notes.push('Field requirements come from this app\'s own configuration, not from S/4, so S/4 '
      + 'was not asked about them.');
  }
  return notes.map((message) => ({ severity: 'info', message }));
}

async function callCheck({ payload, requestId, send }) {
  const service = send ? { send } : await cds.connect.to(SERVICE);
  return service.send({
    method: 'POST',
    path: ACTION,
    data: {
      // The action declares every parameter Nullable="false", so all five go on the wire even
      // where a default would do.
      RequestId: String(requestId || 'check').slice(0, 36),
      PayloadJson: JSON.stringify(payload || {}),
      IncludeRoles: INCLUDE_ROLES,
      IncludeRelations: INCLUDE_RELATIONS,
      RunTestRun: true
    }
  });
}

/**
 * Runs after the derivations, on the derived payload, because the derivations fill fields these
 * checks depend on -- the customer/supplier account group derived from the grouping being the clear
 * case. Sending the typed payload would produce errors the app was about to fix itself.
 *
 * Never throws. An unreachable S/4 reports itself as an info line and the request proceeds: this is
 * a gate on data quality, not on connectivity, and "no problems found" produced by a check that
 * never ran is the one answer it must not give.
 */
function createBpCheckStage({ requestId = null, send = null } = {}) {
  return async function runStandardChecks(payload) {
    let answer;
    try {
      answer = await callCheck({ payload, requestId, send });
    } catch (error) {
      return [{
        check: CHECK_NAME,
        severity: 'info',
        message: `The SAP standard checks could not run (${error.message}), so this request has `
          + 'not been checked against S/4 customizing.'
      }];
    }

    // A bound action's result may arrive bare or wrapped in `value`, depending on the client.
    const result = answer && answer.value !== undefined && answer.MessagesJson === undefined
      ? answer.value
      : answer;

    if (!result) {
      return [{
        check: CHECK_NAME,
        severity: 'info',
        message: 'The SAP standard checks returned no result, so this request has not been '
          + 'checked against S/4 customizing.'
      }];
    }

    const messages = parse(result.MessagesJson, 'MessagesJson') || [];
    const coverage = parse(result.CoverageJson, 'CoverageJson');

    // SuppressedJson is deliberately not read here. It exists so a failed post is diagnosable,
    // not so a requester can be shown SAP's opinion on fields this app governs.

    return [...toFindings(messages), ...coverageNotes(coverage)]
      .map((finding) => ({ check: CHECK_NAME, ...finding }));
  };
}

module.exports = {
  createBpCheckStage,
  CHECK_NAME,
  INCLUDE_ROLES,
  MAX_SEVERITY,
  // exported for the tests, which pin the shaping rather than the transport
  dedupe,
  toFindings,
  coverageNotes,
  cap
};
