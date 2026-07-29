# Manage Business Partner (F3163) — CAP recreation

A recreated, importable project structure for the SAP standard Fiori app
**Manage Business Partner**.

| | |
|---|---|
| **App ID** | `F3163` |
| **Technical name** | `mdm.md.businesspartner.manage` |
| **Semantic object / action** | `BusinessPartner` / `manage` |
| **Stack** | SAP CAP (Node.js) + Fiori Elements (OData **V4**) List Report / Object Page |

> ⚠️ **About this recreation.** The real SAP standard app F3163 is a proprietary
> SmartTemplate (Fiori Elements for OData **V2**) application whose source is not
> publicly available. This repository is a faithful *reconstruction* of the
> directory layout, manifest, and data model, rebuilt on **OData V4** so it drops
> straight into a modern CAP project. Entity and field names mirror the SAP
> `API_BUSINESS_PARTNER` (`A_BusinessPartner`) so it stays recognizable. Adjust
> the model to your own needs.

## Directory structure

```
.
├── app/
│   └── businesspartner/                 # ← the Fiori Elements UI app (import this into your CAP app/)
│       ├── webapp/
│       │   ├── Component.js
│       │   ├── index.html
│       │   ├── manifest.json            # app descriptor: FE templates, routing, data source
│       │   ├── i18n/i18n.properties
│       │   ├── localService/            # mock server metadata + data (see its README)
│       │   └── test/                    # OPA5 integration + QUnit unit test scaffold
│       │       ├── flpSandbox.html
│       │       ├── integration/
│       │       └── unit/
│       ├── package.json                 # UI5 tooling scripts (start / build / deploy)
│       ├── ui5.yaml                     # live backend (proxy to CAP on :4004)
│       ├── ui5-mock.yaml                # mock server config
│       ├── xs-app.json                  # app router routes
│       └── .gitignore
├── db/
│   ├── schema.cds                       # Business Partner domain model
│   └── data/                            # sample data (CSV)
├── srv/
│   ├── business-partner-service.cds     # OData V4 service definition
│   ├── business-partner-service.js      # custom handlers
│   └── annotations.cds                  # Fiori Elements UI annotations (columns, facets, value help)
├── package.json                         # CAP project
├── mta.yaml                             # BTP multi-target deployment descriptor
├── xs-security.json                     # XSUAA scopes & roles
├── .cdsrc.json
└── .gitignore
```

## How to import into your own CAP application

You have two options:

**A. Take the whole project** — clone/copy everything and run it as-is.

**B. Import just the app** (most common) — copy `app/businesspartner/` into the
`app/` folder of your existing CAP project, then either:
- reuse your own service by pointing `manifest.json` → `sap.app.dataSources.mainService.uri`
  at your OData V4 service path, **or**
- also copy `db/schema.cds`, `srv/business-partner-service*.cds/js` and
  `srv/annotations.cds` to get the matching backend.

Make sure your root `package.json` lists the app under `"sapux"` so the SAP Fiori
tools recognize it:

```json
"sapux": [ "app/businesspartner" ]
```

## Run locally

```bash
npm install                 # install CAP dependencies
npm run watch               # start CAP backend on http://localhost:4004 (serves the app too)
```

Or run the UI with the Fiori tooling against the live backend:

```bash
cd app/businesspartner
npm install
npm start                   # opens the FLP sandbox with the app
```

The service is served at `/service/businesspartner/` and the app opens under the
intent **`BusinessPartner-manage`**.

## Deploy to SAP BTP, Cloud Foundry

```bash
npm install -g mbt
mbt build                   # produces mta_archives/*.mtar
cf deploy mta_archives/mdm-md-businesspartner-manage_1.0.0.mtar
```

This provisions the HANA HDI container, XSUAA, HTML5 apps repo, and destination
service as declared in `mta.yaml`.
