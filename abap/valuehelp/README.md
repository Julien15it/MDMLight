# BP value helps — OData service

One service definition exposing the SAP released value-help views behind the
fields of the Maintain Business Partner app. No Z copies of the views: all of
them are `SAP_BASIS` / `SAP_ABA` / `S4CORE`, released, clean-core level A, and
ship with every S/4 system regardless of MDG licensing.

## Create in ADT

1. Create data definition-free **service definition** `ZAPI_BP_VALUEHELP` from
   `ZAPI_BP_VALUEHELP.asrvdsrv`, assign to a Z package, activate.
2. Create a **service binding** on it — binding type **ODATA V2 – Web API**,
   external service name `ZAPI_BP_VALUEHELP`. Activate, then publish.
3. The service is then reachable at
   `/sap/opu/odata/sap/ZAPI_BP_VALUEHELP`.

The V2/V4 choice lives in the *binding*, not in the service definition — the
source file is identical either way.

## Why V2

`VF_S4HANA_DEST` points at `/sap/opu/odata/sap`, the V2 gateway root, so a V2
binding is reachable through the destination the app already has. Add to
`package.json`:

```json
"ZAPI_BP_VALUEHELP": {
  "kind": "odata-v2",
  "model": "srv/external/ZAPI_BP_VALUEHELP",
  "credentials": {
    "destination": "VF_S4HANA_DEST",
    "path": "/ZAPI_BP_VALUEHELP"
  }
}
```

A V4 binding would be served from `/sap/opu/odata4/sap/…`, a different root,
needing a second destination.

## Field → entity set

| Maintain BP field | Section | Entity set | SAP view |
|---|---|---|---|
| `Country`, `NameCountry`, `BusPartNationality`, `BankCountryKey` | General, Addresses, Identifications, Bank | `Countries` | `I_CountryVH` |
| `Region` | Addresses, Identifications | `Regions` | `I_RegionVH` |
| `CorrespondenceLanguage`, `Language` | General | `Languages` (+ `LanguageTexts`) | `I_Language` |
| `AcademicTitle` | General | `AcademicTitles` | `I_AcademicTitleVH` |
| `FormOfAddress` | General | `FormsOfAddress` (+ `FormOfAddressTexts`) | `I_FormOfAddress` |
| `BusinessPartnerCategory` | General | `BusinessPartnerCategories` (+ texts) | `I_BusPartCategory` |
| `BusinessPartnerGrouping` | General | `BusinessPartnerGroupings` (+ texts) | `I_BusinessPartnerGrouping` |
| `BusinessPartnerRole` | Roles | `BusinessPartnerRoles` | `I_BusinessPartnerRoleStdVH` |
| `BusinessPartnerType` | General | `BusinessPartnerTypes` (+ texts) | `I_BusinessPartnerType` |
| `LegalForm` | General | `LegalForms` (+ texts) | `I_BusinessPartnerLegalForm` |
| `BusinessPartnerOccupation` | General | `Occupations` (+ texts) | `I_BusinessPartnerOccupation` |
| `BusinessPartnerPrintFormat` | General | `PrintFormats` (+ texts) | `I_BusinessPartnerPrintFormat` |
| `BusPartMaritalStatus` | General | `MaritalStatuses` (+ texts) | `I_BusPartMaritalStatus` |
| `BusinessPartnerBirthDateStatus` | General | `BirthDateStatuses` (+ texts) | `I_BusPartBirthDateStatus` |
| `IsFemale`, `IsMale`, `IsSexUnknown`, `GenderCodeName` | General | `Genders` | `I_BPGenderValueHelp` |
| `TradingPartner` | General | `TradingPartners` | `I_BPTradingPartner` |
| `Industry` | General | `IndustryCodes` (+ texts) | `I_BusPartIndustryCode` |
| `BPIdentificationType` | Identifications | `IdentificationTypes` | `I_BuPaIdentificationType` |
| `BPTaxType` | Tax Numbers | `TaxTypes` | `I_BusPartTaxTypeText` |
| `BPTaxType` (address-dependent) | Tax Numbers | `AddressDependentTaxTypes` | `I_BusPartAddrDepdntTaxTypeVH` |
| `IndustrySystemType` | Industries | `IndustrySystems` (+ texts) | `I_BusPartIndustrySystem` |
| `IndustrySector` | Industries | `IndustrySectors` (+ texts) | `I_BusPartIndustryKey` |
| `BankNumber`, `BankName`, `SWIFTCode` | Bank Details | `Banks` | `I_BusinessPartnerBank` |
| `CustomerAccountGroup` | Customer Data | `CustomerAccountGroups` | `I_CustomerAccountGroupStdVH` |
| `CustomerClassification` | Customer Data | `CustomerClassifications` (+ texts) | `I_CustomerClassification` |
| `SupplierAccountGroup` | Supplier Data | `SupplierAccountGroups` | `I_SupplierAccountGroupStdVH` |

Text entity sets are exposed alongside their key view because the SAP key views
carry no description. They are language-dependent — filter on `Language`.

### Fields with no released value-help view

| Field | Check table | Note |
|---|---|---|
| `NameFormat` | `TSADFMT` | No released CDS view found. |
| `AuthorizationGroup` | `TBRG` | No BP-specific released CDS view found. |
| `SupplierProcurementBlock` | domain fixed values | Small fixed list. |

## If a view refuses to expose

Two things can block activation of the binding, both fixable per view:

- **No key / unsuitable key.** Some VDM views are not keyed for OData.
- **Input parameters.** Parameterised views can't be exposed as a plain set.

The fix in either case is a thin Z projection over that one view (declaring the
key, or supplying the parameter), exposed in place of the SAP view. Only needed
for the views that actually complain.
