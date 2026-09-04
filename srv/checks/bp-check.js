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
 * **Roles and relations are both sent**, so the customer/supplier checks arrive as well. That costs
 * a vendor number per run, accepted as product behaviour on 2026-08-26 -- see `INCLUDE_ROLES`.
 *
 * The one thing this deliberately does NOT do is **field properties**. This app owns them; they
 * live in its own configuration tables and are not mirrored from SPRO, because keeping a two-way
 * binding in step is more machinery than the app wants. The service separates SAP's field-status
 * verdicts into `SuppressedJson`, which this module never surfaces. Measured empty in practice -- a
 * test run does not reach that layer at all -- so it is a safety net rather than a filter that does
 * daily work.
 */

const cds = require('@sap/cds');

/**
 * Declared in package.json against **`VF_S4HANA_V4_DEST`**, not `VF_S4HANA_DEST`, and that is not
 * tidiness -- it is required.
 *
 * `VF_S4HANA_DEST` ends in `/sap/opu/odata/sap`, the OData **V2** namespace. `/sap/opu/odata4` is a
 * SIBLING of it, not a child, so a V4 service cannot be reached through it: CAP appends the path
 * and the result is `/sap/opu/odata/sap/sap/opu/odata4/...`, which the gateway answers 403 to with
 * `x-csrf-token: Required` -- a misleading symptom that cost an afternoon on 2026-08-26 and sent
 * the diagnosis to SU53 and to CSRF, neither of which was the problem.
 *
 * A `..` traversal in the path is NOT the fix: axios concatenates baseURL and path rather than
 * resolving them, so the literal `..` reaches the ICM.
 *
 * The new destination is rooted at `/sap/opu/odata4/sap`, mirroring how `VF_S4HANA_DEST` is rooted
 * at the V2 namespace -- so a second V4 service later costs a path, not another destination.
 */
const SERVICE = 'ZMDML_BPCHECK';

// Read from the live $metadata on 2026-08-26, not guessed. `srvd_a2x` (not `srvd`) is the Web API
// binding flavour, and `check` is collection-bound -- `_it` is a Collection -- so it hangs off the
// entity set rather than a keyed instance.
const ACTION = 'BPChecks/com.sap.gateway.srvd_a2x.zmdml_bpcheck.v0001.check';

/**
 * **The tier switch. `true` since 2026-08-26, and the cost is number-range gaps.**
 *
 * CVI syncs a vendor because the BP carries a vendor role, and that one sync both produces the
 * vendor-level checks (`VMD_API/043` EU VAT, `CVI_API/007` STCEG plausibility) and draws a vendor
 * number. The two are inseparable, measured three ways: dropping the supplier node changed neither
 * the messages nor the draw; sending the node *without* the role produced only
 * `CVI_EI/039 Partner does not have a vendor role` and checked nothing; and `ROLLBACK WORK` does
 * not return the number, because number assignment commits outside the calling LUW.
 *
 * So there is no configuration that gets the checks for free. `NRIV KREDITOR/02` advances by a
 * buffer block on every run that reaches `MAINTAIN` -- measured at 5 per block, `BU_PARTNER` not
 * drawn at all.
 *
 * **Decided at the product meeting on 2026-08-26: gaps are acceptable.** MDG and SAP standard
 * behave the same way -- a few numbers jump whenever checks fire -- so this is normal for the
 * product rather than a defect it introduces. The vendor range is 100000-199999 and was at ~100144
 * on that date.
 *
 * Worth revisiting only if a customer's auditors object to vendor numbering gaps, or if the range
 * starts running short. The cheaper shape then is not to weaken the check but to move it: once per
 * submit, or at the enricher step, rather than once per button press.
 */
const INCLUDE_ROLES = true;

/**
 * Moves with `INCLUDE_ROLES` and only with it -- the trade is binary. Sending the customer/supplier
 * node WITHOUT its role was measured and buys nothing: CVI gates on the role before it looks at the
 * data, answers `CVI_EI/039 Partner does not have a vendor role, you cannot create a vendor`, and
 * examines neither the account group nor the company code nor the withholding tax.
 *
 * **Two things in ZCL_MDML_BPCHECK are marked UNCONFIRMED and are first exercised by this being
 * true**, so a failure here is more likely than anywhere else in the module:
 *
 * 1. `Customers`/`Suppliers` are `many: false` in `PAYLOAD_NODES`, so a real request may send them
 *    as objects while the ABAP types them as tables. (The parse runs regardless of these flags, so
 *    this one was never actually gated by them.)
 * 2. The `VMDS_EI_EXTERN` paths (`vendor-header-object_instance-lifnr`,
 *    `vendor-central_data-central-data-ktokk`) were mirrored from `CMDS_EI_EXTERN` by symmetry,
 *    not read from the system.
 *
 * See `mdmlbpcheck/README.md`.
 */
const INCLUDE_RELATIONS = true;

/**
 * Warning, not error, and this is the knob -- same reasoning as `ROLE_CATEGORY_SEVERITY` in
 * cvi-checks.js. The costs are not symmetric: a warning on something S/4 would have accepted is
 * noise, while blocking a legitimate request leaves a requester unable to submit and with nothing
 * to argue against.
 *
 * **Raised to 'error' on 2026-09-03**, which is the condition this comment set: the messages have
 * now been seen to be right on real data. Two live requests were approved and then refused at the
 * post - `Partner role SP already exists` and a missing standard address - both of which S/4 had
 * reported as E beforehand and both of which arrived as warnings a data steward could walk past.
 * A doomed request reaching an approver is the very thing this stage exists to prevent.
 *
 * Nothing else changes shape: an S/4 `W` is still a warning and `I`/`S` still info, and the stage
 * still only runs on the data steward step. What an `error` now does is BLOCK that step's
 * completion - see the standard-check gate in `decideDataStewardReview`. Lower it back here if a
 * class of message turns out to be wrong; that is one line and no other code assumes the cap.
 */
const MAX_SEVERITY = 'error';

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
 * S/4 reports the same message more than once, and the count is kept rather than collapsed.
 *
 * Measured with `R11/336`: twice whenever the payload carries a role OR a customer/supplier node,
 * once when it carries neither. So the second occurrence is CVI running its own pass over the BP
 * central data -- which it does if there is anything relation-shaped to consider at all, not only
 * when a role is present. (An earlier version of this comment claimed the role was the trigger;
 * case 5 disproved it.)
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

/**
 * `{ check, severity, message }` and nothing else -- the shape every other stage returns. The
 * class, number, stage and repeat count all live in the text rather than as extra keys.
 *
 * **Info-level messages are dropped.** A requester needs either "nothing to fix" or something they
 * can act on; S/4's own `I`/`S` messages are neither, and a strip nobody can do anything about
 * teaches people to stop reading strips. Asked for 2026-08-26, and it is why the coverage
 * narration that used to live here is gone rather than downgraded.
 */
function toFindings(messages) {
  return dedupe(messages)
    .map((message) => ({ severity: cap(message.severity), message: describe(message) }))
    .filter((finding) => finding.severity !== 'info');
}

/**
 * What the remote actually said, for the log only.
 *
 * The shape varies with how far down the call failed -- the Cloud SDK, axios and CAP each wrap it
 * differently -- so every plausible place is tried rather than assuming one. The status and the
 * body are what matter: a gateway explains a 403 in the body ("CSRF token validation failed",
 * "no authorization"), and that sentence is the difference between a role change and a code change.
 *
 * Headers are deliberately NOT logged: they carry the bearer token and the CSRF token.
 */
function logRemoteFailure(error) {
  // `error.reason.response` FIRST, and that ordering is the fix: CAP wraps the remote failure and
  // reports its own 502 on the outer error while the real status and body sit on `reason`. The
  // first version read the outer one and printed "status 502: (no response body)" over a perfectly
  // good `500 RAISE_SHORTDUMP` -- a log line that hid the answer it existed to show.
  const response = error?.reason?.response
    || error?.response
    || error?.cause?.response
    || error?.rootCause?.response;

  const status = response?.status ?? error?.status ?? error?.statusCode;
  const body = response?.body ?? response?.data ?? error?.cause?.message;

  const detail = typeof body === 'string' ? body.slice(0, 2000)
    : body ? JSON.stringify(body).slice(0, 2000)
      : '(no response body)';

  console.warn(`[bp-check] ${SERVICE} refused the call`,
    status ? `with status ${status}:` : ':', detail);
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
      // `Request failed with status code 403` on its own sends you to SU53, which is empty when the
      // gateway rejected the call before any authorization check ran. The gateway says why in the
      // response body, so log it: the alternative is turning DEBUG=remote on in production to read
      // one sentence. Server-side only -- the requester gets the plain message below.
      logRemoteFailure(error);

      // The ONE message that survives the no-info-strips rule, and it is a warning rather than an
      // info for exactly that reason. A check that did not run must never read as a check that
      // passed -- that is the wrong answer this whole pipeline refuses to give. It does not block.
      return [{
        check: CHECK_NAME,
        severity: 'warning',
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
        severity: 'warning',
        message: 'The SAP standard checks returned no result, so this request has not been '
          + 'checked against S/4 customizing.'
      }];
    }

    const messages = parse(result.MessagesJson, 'MessagesJson') || [];

    // CoverageJson and SuppressedJson are deliberately not read. Coverage is a statement about
    // what the check looked at, which is a design note rather than something a requester can act
    // on; suppressed holds SAP's opinion on fields this app governs, and exists so a failed post
    // is diagnosable. Both are in the response either way, for whoever is debugging one.

    return toFindings(messages).map((finding) => ({ check: CHECK_NAME, ...finding }));
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
  cap
};
