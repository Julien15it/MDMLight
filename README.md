# Manage Business Partner (F3163)

CAP Node.js and SAP Fiori elements application for live S/4HANA Business Partner
master data. The UI uses an OData V4 CAP facade; CAP delegates requests to the
S/4HANA OData V2 service `API_BUSINESS_PARTNER` through BTP destination
`VF_S4HANA_DEST`.

## Features

- Live list report and object page; no local business-partner database
- Server-side free-text search across IDs, names, and search terms
- Full-screen create and edit flow covering all fields of the Business Partner,
  address, role, tax, bank, identification, industry, customer, and supplier entities
- Live create preview and a complete read-only Business Partner view with an explicit Edit action
- Editable related sections for addresses, roles, tax numbers, bank details,
  identifications, industries, customer data, and supplier data
- Complete imported `API_BUSINESS_PARTNER` model with all 65 entity sets
- Conversational Business Partner Assistant powered by SAP AI Core orchestration,
  with a read-only S/4HANA search fallback when AI Core is unavailable
- Standalone application router, XSUAA, Destination service, Connectivity
  service, SAP AI Core, and HTML5 Application Repository deployment

Deletion is deliberately disabled in the CAP facade.

## BTP destination

The existing destination must be named `VF_S4HANA_DEST`. Its URL already ends
at `/sap/opu/odata/sap`, so CAP adds only `/API_BUSINESS_PARTNER`.

For an on-premise S/4HANA system, configure the destination with Cloud Connector
(`ProxyType=OnPremise`) and an authentication method that is allowed to read and
maintain business partners. Creation also requires CSRF token support, which is
enabled in `package.json`.

## SAP AI Core and AI Launchpad

SAP AI Launchpad manages prompts and deployments; the application runtime calls
the Generative AI Hub through an SAP AI Core `extended` service binding. The MTA
creates and binds `mdm-businesspartner-aicore` automatically. In AI Launchpad,
ensure that the `default` resource group has a running orchestration deployment
and access to `gpt-5-mini`.

The chatbot sends only a bounded set of Business Partner identifiers, names,
categories, groupings, search terms, block status, and explicitly requested
addresses. Bank and tax data are never included in an AI prompt. To use another
model or resource group, change `AICORE_MODEL` or `AICORE_RESOURCE_GROUP` on the
`mdm-businesspartner-srv` module in `mta.yaml`.

For local hybrid testing after the service exists in Cloud Foundry:

```bash
cds bind -2 mdm-businesspartner-aicore
cds watch --profile hybrid
```

## Run in BAS or VS Code

```bash
npm ci
npm test
npm run watch
```

Open the CAP launch page at `http://localhost:4004` and start the application, or
run the UI tooling separately:

```bash
cd app/businesspartner
npm install
npm start
```

Local live S/4 access requires a usable destination binding. Without one, CAP
can compile and the tests can run, but live requests cannot be completed.

## Build and deploy

```bash
mbt build
cf deploy mta_archives/mdm-md-businesspartner-manage_1.8.0.mtar
```

Open the deployed application from its tile in the SAP Build Work Zone site. The
app is served by the **managed** approuter out of the HTML5 applications
repository — there is no approuter module in this MTA and no Cloud Foundry route
of its own. See "No approuter module" in `CLAUDE.md`.

The imported EDMX/CSN under `srv/external` is the Business Partner API model used
by the official SAP CAP S/4 sample. If your on-premise S/4 release exposes a
different metadata version, re-import that system's `$metadata` and rebuild.
