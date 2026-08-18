# Customer master fields — OData service

The fields the standard MDG *ERP Customer* screen shows but
`API_BUSINESS_PARTNER` does not expose. This service closes that gap without
touching a single SAP object: it exposes the released `I_Customer` view, which
already selects them from `KNA1`.

Same shape as `abap/valuehelp` — a service definition plus a binding, no Z
copies of any view.

| | Name |
|---|---|
| Service definition (this folder) | `ZMDML_CUST_ENTITY` |
| Service binding / external name | `ZSRVB_MDMLIGHT_CUST` |
| URL | `/sap/opu/odata/sap/ZSRVB_MDMLIGHT_CUST` |

## Why this is needed at all

`API_BUSINESS_PARTNER`'s `A_Customer` carries 53 fields. `KNA1` carries far
more, and the MDG screen renders from the MDG staging model, so it shows fields
the API never had. Verified field by field against this system's data
dictionary — see the table below, and the drift note in `srv/metadata-drift.js`
for the reverse problem.

`MDG_BP_SRV` is **not** an alternative: checked all 189 of its properties, it
carries only BP central data (names, addresses, banks, tax numbers, roles,
relationships) and has no customer segment at all.

## What this gets you immediately

`I_Customer` already selects these from `KNA1`. Exposing the view is all that is
needed — no ABAP change:

| MDG screen field | `I_Customer` element | `KNA1` |
|---|---|---|
| Trading Partner | `TradingPartner` | `VBUND` |
| DME Indicator | `DataMediumExchangeIndicator` | `DTAMS` |
| Liable for VAT | `VATLiability` | `STKZU` |
| Condition Group 1–5 | `CustomerConditionGroup1`…`5` | `KDKG1`–`KDKG5` |
| Type of Business | `BusinessType` | `J_1KFTBUS` |
| Type of Industry | `IndustryType` | `J_1KFTIND` |
| Representative's Name | `TaxInvoiceRepresentativeName` | `J_1KFREPRE` |
| Alternative Payer | `AlternativePayerAccount` | `KNRZA` |

## What it does not get you, and why

These sit in `KNA1` and are written in `I_Customer` — but **commented out** in
the shipped view, so they are not selected:

| MDG screen field | `KNA1` | Commented-out alias in `I_Customer` |
|---|---|---|
| Instruction Key | `DTAWS` | `DataMediumExchangeKey` |
| Sales Equalization Tax | `STKZA` | `BPSubjectToEqualizationTax` |
| Non-Military / Military Use | `CIVVE` / `MILVE` | `CustomerIsForCivilUse` / `CustomerIdentityForMilitaryUse` |
| ICMS-Exempt / IPI-Exempt | `XICMS` / `XXIPI` | `CustomerExempt1` / `CustomerExempt` |
| SubTrib Group | `XSUBT` | `CustomerGroupForCalculation` |
| CFOP Category | `CFOPC` | `CustomerCategory` |
| Export Data (4 checkboxes) | `CCC01`–`CCC04` | `BioChemicalWarfareLegal`, `NuclearNonProliferationLegal`, `NationalSecurityLegalControl`, `MissileTechnologyLegalControl` |
| Alternative Payer in Document | `XKNZA` | `AlternativePayerUsingAccount` |

Getting these needs a second step, and **not** by editing `I_Customer` — it is
an SAP object and a modification would be picked up by every upgrade. Two clean
options:

1. **CDS view extension** on `I_Customer` (`extend view I_Customer with …`),
   selecting the remaining `KNA1` fields. `I_Customer` is annotated
   `@Metadata.allowExtensions: true` and already associates an extension include
   (`E_Customer`), so this is the intended route.
2. **A small Z view** on `KNA1` keyed by `KUNNR` exposing only the leftovers,
   exposed alongside `I_Customer` in this same service.

Option 1 keeps one entity in the service and is the cleaner of the two.

`Location Code` appears on the MDG screen but has no `KNA1` counterpart — it
comes from the MDG staging model and is out of reach either way.

## Create in ADT

1. Create a **service definition** `ZMDML_CUST_ENTITY` from
   `ZMDML_CUST_ENTITY.asrvdsrv`, assign to a Z package, activate.
2. Create a **service binding** on it — binding type **ODATA V2 – Web API**,
   external service name `ZSRVB_MDMLIGHT_CUST`. Activate, then publish.

V2, not V4, for the same reason as the value-help service: `VF_S4HANA_DEST`
points at `/sap/opu/odata/sap`, the V2 gateway root. A V4 binding lands on
`/sap/opu/odata4/sap/…` and would need a second destination.

Publishing matters — `ZMDG_CUSTOMER_SRV` exists on this system as a service
group with no ICF node, and `/$metadata` on it answers
*"No service found for namespace '', name 'ZMDG_CUSTOMER_SRV'"*. An unactivated
binding looks identical from the app's side.

## Wire it into the app

Add to `package.json` under `cds.requires` (read-only, so no CSRF round trip):

```json
"ZSRVB_MDMLIGHT_CUST": {
  "kind": "odata-v2",
  "model": "srv/external/ZSRVB_MDMLIGHT_CUST",
  "csrf": false,
  "credentials": {
    "destination": "VF_S4HANA_DEST",
    "path": "/ZSRVB_MDMLIGHT_CUST"
  }
}
```

Then import the metadata once and commit it, exactly as the other two services:

```bash
npm run import:bp -- --url https://<host>:44301/sap/opu/odata/sap
```

`tools/import-metadata.js` only knows the services listed in its `SCRIPTS` map,
so add an `import:custfields` script alongside `import:bp` and
`import:valuehelp`.

The destination route does not resolve from BAS — no destination binding
reaches that process — so use `--url` with `S4_USER` / `S4_PASSWORD`, or run it
from the deployed Cloud Foundry app.

## Then, in the CAP app

The maintenance screen is metadata-driven, so once the model is in
`srv/external` the remaining work is small:

- project the new entity in `srv/business-partner-service.cds`
- add the fields to the `Customers` group in
  `app/businesspartner/scripts/generate-maintenance-metadata.js`
- regenerate with `npm run generate:metadata`

No controller or view change — `fieldGroups` drives the rendering.
