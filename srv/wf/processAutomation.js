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

// The trigger a running mDM_LIGHT_APPROVAL_WF instance waits on once a human
// has decided in our own approve view. `executionId` is the processId the
// workflow instance was started with (same value as ChangeRequests.processInstanceId,
// and the same value embedded in the bpurl sent to startWorkflow) - it tells
// BPA which paused instance to resume, not which API call this is.
const APPROVAL_DECISION_TRIGGER_ID = "eu10.alluvion-dev-cf.mdmlightapproval.zApproved_wf";

async function triggerApprovalDecision(executionId, result) {
    const sbpa = await cds.connect.to("SBPA_DESTINATION");

    const accessToken = await getAccessToken();
    const { apiKey } = getServiceCredentials("mdmlight-bpa-uaa");

    const payload = {
        executionId,
        inputs: { result }
    };

    console.log("Sending approval decision to BPA");
    console.log(payload);

    const response = await sbpa.send({
        method: "POST",
        path: `/unified/v1/triggers/api/${APPROVAL_DECISION_TRIGGER_ID}?environmentId=bpapprovalpoc`,
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "irpa-api-key": apiKey,
            "Content-Type": "application/json"
        },
        data: payload
    });

    console.log("Approval decision sent:");
    console.log(response);

    return response;
}

module.exports = {
    startWorkflow,
    triggerApprovalDecision
};
