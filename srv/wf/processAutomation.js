const cds = require("@sap/cds");
const axios = require("axios");

let cachedToken = null;
let tokenExpiresAt = 0;

function getServiceCredentials(serviceName) {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const service = (vcap["user-provided"] || []).find(
        instance => instance.name === serviceName
    );

    if (!service) {
        throw new Error(`Service '${serviceName}' niet gevonden in VCAP_SERVICES`);
    }

    return service.credentials;
}

async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }

    const { clientid, clientsecret, url } = getServiceCredentials("mdmlight-bpa-uaa");

    const tokenResponse = await axios.post(
        `${url}/oauth/token`,
        new URLSearchParams({ grant_type: "client_credentials" }),
        {
            auth: { username: clientid, password: clientsecret },
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        }
    );

    cachedToken = tokenResponse.data.access_token;
    tokenExpiresAt = Date.now() + (tokenResponse.data.expires_in - 60) * 1000;

    return cachedToken;
}

async function startWorkflow(definitionId, context) {
    const sbpa = await cds.connect.to("SBPA_DESTINATION");

    const accessToken = await getAccessToken();
    const { apiKey } = getServiceCredentials("mdmlight-bpa-uaa");

    const payload = { definitionId, context };

    console.log("Starting BPA workflow");
    console.log(payload);

    const result = await sbpa.send({
        method: "POST",
        path: `/workflow/rest/v1/workflow-instances?environmentId=bpapprovalpoc`,
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "irpa-api-key": apiKey,
            "Content-Type": "application/json"
        },
        data: payload
    });

    console.log("Workflow started:");
    console.log(result);

    return result;
}

// What a parked mDM_LIGHT_APPROVAL_WF instance waits on once a human has decided in our approve
// view. `executionId` is `ChangeRequests.processInstanceId` - which instance to resume, not a call id.
const APPROVAL_DECISION_TRIGGER_ID = "eu10.alluvion-dev-cf.mdmlightapproval.zApproved_wf";

// The requester's trigger, used by resubmit and withdraw; approve and reject keep the approver's.
// Only the id differs, so the host stays with `sbpa-destination` - hardcoding the gateway would
// bypass the destination, and with it the proxy and the token.
const REQUESTER_CALLBACK_TRIGGER_ID = "eu10.alluvion-dev-cf.mdmlightapproval.requesterCallBack";

// What the instance parked after the approval waits on: the outcome of the S/4 post, not the human
// decision. Its inputs are the four fields below and there is deliberately no `result` key, so it
// cannot go through sendTrigger.
const POST_RESULT_TRIGGER_ID = "eu10.alluvion-dev-cf.mdmlightapproval.waitForResult";

// The one place a trigger is actually posted. The host stays with `sbpa-destination` for all of
// them - hardcoding the gateway URL would bypass the destination, and with it the proxy and the
// token.
async function postTrigger(triggerId, label, payload) {
    const sbpa = await cds.connect.to("SBPA_DESTINATION");

    const accessToken = await getAccessToken();
    const { apiKey } = getServiceCredentials("mdmlight-bpa-uaa");

    console.log(`Sending ${label} to BPA`);
    console.log(payload);

    const response = await sbpa.send({
        method: "POST",
        path: `/unified/v1/triggers/api/${triggerId}?environmentId=bpapprovalpoc`,
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "irpa-api-key": apiKey,
            "Content-Type": "application/json"
        },
        data: payload
    });

    console.log(`${label} sent:`);
    console.log(response);

    return response;
}

// `extraInputs` lands flat inside `inputs` next to `result` - Arthur's shape, hence a spread rather
// than a nested key. `executionId` is the process instance, NOT the change request UUID.
async function sendTrigger(triggerId, label, executionId, result, extraInputs = {}) {
    return postTrigger(triggerId, label, { executionId, inputs: { result, ...extraInputs } });
}

/**
 * The result of creating the business partner in S/4, for the instance waiting on it.
 *
 * `inputs` is passed through as given rather than spread over a `result`: this trigger's contract is
 * exactly businesspartnerid / businesspartnerfullname / status / errormessage, and an extra key
 * would be an input the process definition does not declare.
 */
async function triggerPostResult(executionId, inputs) {
    return postTrigger(POST_RESULT_TRIGGER_ID, "post result", { executionId, inputs });
}

/** Approve and reject, from the approve view or the task form. Payload unchanged. */
async function triggerApprovalDecision(executionId, result, extraInputs = {}) {
    return sendTrigger(APPROVAL_DECISION_TRIGGER_ID, "approval decision", executionId, result, extraInputs);
}

// The requester's two ways out of `reworkRequired`. Withdraw calls it so SPA stops the workflow:
// CAP deletes the request, and the instance would otherwise wait on one that no longer exists.
async function triggerRequesterCallback(executionId, result, extraInputs = {}) {
    return sendTrigger(REQUESTER_CALLBACK_TRIGGER_ID, "requester callback", executionId, result, extraInputs);
}

module.exports = {
    startWorkflow,
    triggerApprovalDecision,
    triggerRequesterCallback,
    triggerPostResult,
    APPROVAL_DECISION_TRIGGER_ID,
    REQUESTER_CALLBACK_TRIGGER_ID,
    POST_RESULT_TRIGGER_ID
};
