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
- Editable related sections for addresses, roles, tax numbers, bank details,
  identifications, industries, customer data, and supplier data
- Complete imported `API_BUSINESS_PARTNER` model with all 65 entity sets
- Standalone application router, XSUAA, Destination service, Connectivity
  service, and HTML5 Application Repository deployment

Deletion is deliberately disabled in the CAP facade.

## BTP destination

The existing destination must be named `VF_S4HANA_DEST`. Its URL already ends
at `/sap/opu/odata/sap`, so CAP adds only `/API_BUSINESS_PARTNER`.

For an on-premise S/4HANA system, configure the destination with Cloud Connector
(`ProxyType=OnPremise`) and an authentication method that is allowed to read and
maintain business partners. Creation also requires CSRF token support, which is
enabled in `package.json`.

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
cf deploy mta_archives/mdm-md-businesspartner-manage_1.3.1.mtar
```

Open the deployed application through the standalone approuter route:

```text
https://<approuter-route>/mdmmdbusinesspartnermanage/index.html
```

The imported EDMX/CSN under `srv/external` is the Business Partner API model used
by the official SAP CAP S/4 sample. If your on-premise S/4 release exposes a
different metadata version, re-import that system's `$metadata` and rebuild.
