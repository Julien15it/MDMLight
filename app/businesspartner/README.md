# mdm.md.businesspartner.manage

Fiori Elements (OData V4) List Report / Object Page for **Manage Business Partner** (F3163).

## Scripts

| Command | Description |
|---|---|
| `npm start` | Run against the live CAP backend (proxy to `http://localhost:4004`). |
| `npm run start-mock` | Run with the local mock server (`ui5-mock.yaml`). |
| `npm run build` | Build the app into `dist/`. |
| `npm run int-tests` | Run the OPA5 integration tests. |
| `npm run unit-tests` | Run the QUnit unit tests. |

## Backend

The app binds to the OData V4 service `mainService` → `/service/businesspartner/`
(see `webapp/manifest.json`). Point this at your own CAP service if you already
expose the Business Partner entities.

Launch intent: `BusinessPartner-manage` (semantic object `BusinessPartner`, action `manage`).
