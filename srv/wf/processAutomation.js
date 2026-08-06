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

module.exports = {
    startWorkflow
};
