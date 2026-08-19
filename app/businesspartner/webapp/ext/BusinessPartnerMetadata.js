sap.ui.define([], function () {
  "use strict";

  return   {
    "sections": [
      {
        "id": "BusinessPartners",
        "title": "General Information",
        "entitySet": "BusinessPartners",
        "remoteEntity": "A_BusinessPartner",
        "relationField": "BusinessPartner",
        "typeName": "A_BusinessPartnerType",
        "kind": "root",
        "fields": [
          {
            "name": "BusinessPartner",
            "label": "Business Partner",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Customer",
            "label": "Customer",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "Supplier",
            "label": "Supplier",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "AcademicTitle",
            "label": "Academic Title 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AuthorizationGroup",
            "label": "Authorization Group",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerCategory",
            "label": "BP Category",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerFullName",
            "label": "Business Partner Full Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 81,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "BusinessPartnerGrouping",
            "label": "Grouping",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerName",
            "label": "Business Partner Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 81,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "BusinessPartnerUUID",
            "label": "BP GUID",
            "type": "cds.UUID",
            "key": false,
            "nullable": true,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "CorrespondenceLanguage",
            "label": "Correspondence Lang.",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CreatedByUser",
            "label": "Created By",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 12,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "CreationDate",
            "label": "Created On",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "CreationTime",
            "label": "Created at",
            "type": "cds.Time",
            "key": false,
            "nullable": true,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "FirstName",
            "label": "First Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FormOfAddress",
            "label": "Title Key",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Industry",
            "label": "Industry sector",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "InternationalLocationNumber1",
            "label": "Int. location no. 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 7,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "InternationalLocationNumber2",
            "label": "Int. location no. 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 5,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IsFemale",
            "label": "Female",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IsMale",
            "label": "Male",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IsNaturalPerson",
            "label": "Natural Person",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IsSexUnknown",
            "label": "Unknown",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "GenderCodeName",
            "label": "Gender",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Language",
            "label": "Language",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "LastChangeDate",
            "label": "Changed on",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "LastChangeTime",
            "label": "Changed at",
            "type": "cds.Time",
            "key": false,
            "nullable": true,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "LastChangedByUser",
            "label": "Changed by",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 12,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "LastName",
            "label": "Last Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "LegalForm",
            "label": "Legal form",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "OrganizationBPName1",
            "label": "Name 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "OrganizationBPName2",
            "label": "Name 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "OrganizationBPName3",
            "label": "Name 3",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "OrganizationBPName4",
            "label": "Name 4",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "OrganizationFoundationDate",
            "label": "Date founded",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "OrganizationLiquidationDate",
            "label": "Liquidation date",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SearchTerm1",
            "label": "Search Term 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 20,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SearchTerm2",
            "label": "Search Term 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 20,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AdditionalLastName",
            "label": "Other Last Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BirthDate",
            "label": "Date of Birth",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerBirthDateStatus",
            "label": "Birth Date Status",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerBirthplaceName",
            "label": "Birthplace",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerDeathDate",
            "label": "Death date",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerIsBlocked",
            "label": "Central Block",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerType",
            "label": "BP Type",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ETag",
            "label": "E Tag",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 26,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "GroupBusinessPartnerName1",
            "label": "Name 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "GroupBusinessPartnerName2",
            "label": "Name 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IndependentAddressID",
            "label": "Address Number",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "InternationalLocationNumber3",
            "label": "Check digit",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "MiddleName",
            "label": "Middle Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "NameCountry",
            "label": "Ctry/Reg. for Format",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "NameFormat",
            "label": "Name Format",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PersonFullName",
            "label": "Full Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 80,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PersonNumber",
            "label": "Person Number",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "IsMarkedForArchiving",
            "label": "Archiving Flag",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerIDByExtSystem",
            "label": "Ext. Partner Number",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 20,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerPrintFormat",
            "label": "Print Format",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerOccupation",
            "label": "Occupation",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusPartMaritalStatus",
            "label": "Marital Status",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusPartNationality",
            "label": "Nationality",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerBirthName",
            "label": "Name at Birth",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerSupplementName",
            "label": "Name Supplement",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "NaturalPersonEmployerName",
            "label": "Employer",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 35,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "LastNamePrefix",
            "label": "Prefix Key",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "LastNameSecondPrefix",
            "label": "2nd prefix",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Initials",
            "label": "Initials",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BPDataControllerIsNotRequired",
            "label": "DC Not Required",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "TradingPartner",
            "label": "Trading Partner No.",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 6,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "Addresses",
        "title": "Addresses",
        "entitySet": "Addresses",
        "remoteEntity": "A_BusinessPartnerAddress",
        "relationField": "BusinessPartner",
        "typeName": "A_BusinessPartnerAddressType",
        "kind": "collection",
        "summaryFields": [
          "StreetName",
          "HouseNumber",
          "PostalCode",
          "CityName",
          "Country",
          "Region",
          "POBox"
        ],
        "requiredCreateFields": [
          "Country"
        ],
        "fields": [
          {
            "name": "BusinessPartner",
            "label": "Business Partner",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AddressID",
            "label": "Address Number",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": false,
            "updatable": true
          },
          {
            "name": "CityName",
            "label": "City",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Country",
            "label": "Country/Region Key",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "HouseNumber",
            "label": "House Number",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "POBox",
            "label": "PO Box",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PostalCode",
            "label": "Postal Code",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Region",
            "label": "Region",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "StreetName",
            "label": "Street",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 60,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "BusinessPartnerRoles",
        "title": "Roles",
        "entitySet": "BusinessPartnerRoles",
        "remoteEntity": "A_BusinessPartnerRole",
        "relationField": "BusinessPartner",
        "typeName": "A_BusinessPartnerRoleType",
        "kind": "collection",
        "summaryFields": [
          "BusinessPartnerRole",
          "ValidFrom",
          "ValidTo"
        ],
        "requiredCreateFields": [
          "BusinessPartnerRole"
        ],
        "fields": [
          {
            "name": "BusinessPartner",
            "label": "Business Partner",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartnerRole",
            "label": "BP Role",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 6,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ValidFrom",
            "label": "Valid From",
            "type": "cds.DateTime",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ValidTo",
            "label": "Valid To",
            "type": "cds.DateTime",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "TaxNumbers",
        "title": "Tax Numbers",
        "entitySet": "TaxNumbers",
        "remoteEntity": "A_BusinessPartnerTaxNumber",
        "relationField": "BusinessPartner",
        "typeName": "A_BusinessPartnerTaxNumberType",
        "kind": "collection",
        "summaryFields": [
          "BPTaxType",
          "BPTaxNumber",
          "BPTaxLongNumber"
        ],
        "requiredCreateFields": [
          "BPTaxType"
        ],
        "oneOfCreateFields": [
          "BPTaxNumber",
          "BPTaxLongNumber"
        ],
        "fields": [
          {
            "name": "BusinessPartner",
            "label": "Business Partner",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BPTaxType",
            "label": "Tax Number Category",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BPTaxNumber",
            "label": "Tax number",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 20,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BPTaxLongNumber",
            "label": "Tax Number Long",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 60,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "BankDetails",
        "title": "Bank Details",
        "entitySet": "BankDetails",
        "remoteEntity": "A_BusinessPartnerBank",
        "relationField": "BusinessPartner",
        "typeName": "A_BusinessPartnerBankType",
        "kind": "collection",
        "summaryFields": [
          "BankName",
          "BankCountryKey",
          "BankNumber",
          "IBAN",
          "BankAccount",
          "CityName"
        ],
        "requiredCreateFields": [
          "BankIdentification"
        ],
        "oneOfCreateFields": [
          "IBAN",
          "BankAccount"
        ],
        "fields": [
          {
            "name": "BusinessPartner",
            "label": "Business Partner",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BankIdentification",
            "label": "Bank Details ID",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BankCountryKey",
            "label": "Bank Country/Region",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BankName",
            "label": "Bank Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 60,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "BankNumber",
            "label": "Bank Key",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 15,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SWIFTCode",
            "label": "SWIFT/BIC",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 11,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "BankAccountHolderName",
            "label": "Account Holder",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 60,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BankAccountName",
            "label": "Account Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IBAN",
            "label": "IBAN",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 34,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BankAccount",
            "label": "Bank Account",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 18,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CityName",
            "label": "City",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 35,
            "creatable": false,
            "updatable": false
          }
        ]
      },
      {
        "id": "Identifications",
        "title": "Identifications",
        "entitySet": "Identifications",
        "remoteEntity": "A_BuPaIdentification",
        "relationField": "BusinessPartner",
        "typeName": "A_BuPaIdentificationType",
        "kind": "collection",
        "summaryFields": [
          "BPIdentificationType",
          "BPIdentificationNumber",
          "BPIdnNmbrIssuingInstitute",
          "Country",
          "Region"
        ],
        "requiredCreateFields": [
          "BPIdentificationType",
          "BPIdentificationNumber"
        ],
        "fields": [
          {
            "name": "BusinessPartner",
            "label": "Business Partner",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BPIdentificationType",
            "label": "Identification Type",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 6,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BPIdentificationNumber",
            "label": "ID Number",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 60,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BPIdnNmbrIssuingInstitute",
            "label": "Responsible Institn",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 40,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BPIdentificationEntryDate",
            "label": "Entry date",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Country",
            "label": "Country/Region",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Region",
            "label": "Region",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "Industries",
        "title": "Industries",
        "entitySet": "Industries",
        "remoteEntity": "A_BuPaIndustry",
        "relationField": "BusinessPartner",
        "typeName": "A_BuPaIndustryType",
        "kind": "collection",
        "summaryFields": [
          "IndustrySector",
          "IndustrySystemType",
          "IndustryKeyDescription",
          "IsStandardIndustry"
        ],
        "requiredCreateFields": [
          "IndustrySector",
          "IndustrySystemType"
        ],
        "fields": [
          {
            "name": "IndustrySector",
            "label": "Industry",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IndustrySystemType",
            "label": "Industry System",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BusinessPartner",
            "label": "Business Partner",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IsStandardIndustry",
            "label": "Standard Industry",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IndustryKeyDescription",
            "label": "Description",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 100,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "Customers",
        "title": "Customer Data",
        "entitySet": "Customers",
        "remoteEntity": "A_Customer",
        "relationField": "Customer",
        "typeName": "A_CustomerType",
        "kind": "single",
        "creatable": true,
        "deletable": false,
        "childSections": [
          "CustomerTaxGrouping",
          "CustomerCompany",
          "CustomerSalesArea",
          "CustomerTaxIndicators"
        ],
        "fieldGroups": [
          {
            "title": "Control Data",
            "fields": [
              "Customer",
              "CustomerAccountGroup",
              "CustomerFullName",
              "CustomerName",
              "CustomerClassification",
              "CustomerCorporateGroup",
              "AuthorizationGroup",
              "CreatedByUser",
              "CreationDate"
            ]
          },
          {
            "title": "Tax Information",
            "fields": [
              "VATRegistration",
              "TaxNumberType",
              "TaxNumber1",
              "TaxNumber2",
              "TaxNumber3",
              "TaxNumber4",
              "TaxNumber5",
              "FiscalAddress",
              "CityCode",
              "County",
              "ResponsibleType",
              "NFPartnerIsNaturalPerson"
            ]
          },
          {
            "title": "Industry",
            "fields": [
              "Industry",
              "IndustryCode1",
              "IndustryCode2",
              "IndustryCode3",
              "IndustryCode4",
              "IndustryCode5",
              "NielsenRegion"
            ]
          },
          {
            "title": "Reference Data",
            "fields": [
              "Supplier",
              "PaymentReason",
              "ExpressTrainStationName",
              "TrainStationName",
              "InternationalLocationNumber1",
              "InternationalLocationNumber2",
              "InternationalLocationNumber3"
            ]
          },
          {
            "title": "Blocks and Status",
            "fields": [
              "BillingIsBlockedForCustomer",
              "DeliveryIsBlocked",
              "OrderIsBlockedForCustomer",
              "PostingIsBlocked",
              "DeletionIndicator"
            ]
          },
          {
            "title": "Additional Data",
            "fields": [
              "FreeDefinedAttribute01",
              "FreeDefinedAttribute02",
              "FreeDefinedAttribute03",
              "FreeDefinedAttribute04",
              "FreeDefinedAttribute05",
              "FreeDefinedAttribute06",
              "FreeDefinedAttribute07",
              "FreeDefinedAttribute08",
              "FreeDefinedAttribute09",
              "FreeDefinedAttribute10"
            ]
          }
        ],
        "summaryFields": [
          "CustomerFullName",
          "CustomerAccountGroup",
          "CustomerClassification",
          "BillingIsBlockedForCustomer",
          "DeliveryIsBlocked",
          "PostingIsBlocked"
        ],
        "requiredCreateFields": [
          "CustomerAccountGroup"
        ],
        "fields": [
          {
            "name": "Customer",
            "label": "Customer",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AuthorizationGroup",
            "label": "Authorization",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BillingIsBlockedForCustomer",
            "label": "Billing Block",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CreatedByUser",
            "label": "Created by",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 12,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "CreationDate",
            "label": "Created On",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "CustomerAccountGroup",
            "label": "Account Group",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerClassification",
            "label": "Customer Classific.",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerFullName",
            "label": "Customer Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 220,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "CustomerName",
            "label": "Name of Customer",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 80,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "DeliveryIsBlocked",
            "label": "Delivery block",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute01",
            "label": "Attribute 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute02",
            "label": "Attribute 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute03",
            "label": "Attribute 3",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute04",
            "label": "Attribute 4",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute05",
            "label": "Attribute 5",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute06",
            "label": "Attribute 6",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute07",
            "label": "Attribute 7",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute08",
            "label": "Attribute 8",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute09",
            "label": "Attribute 9",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FreeDefinedAttribute10",
            "label": "Attribute 10",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "NFPartnerIsNaturalPerson",
            "label": "Natural Person",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "OrderIsBlockedForCustomer",
            "label": "Order Block",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PostingIsBlocked",
            "label": "Posting Block",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Supplier",
            "label": "Supplier",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerCorporateGroup",
            "label": "Group Key",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FiscalAddress",
            "label": "Fiscal address",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Industry",
            "label": "Industry",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "IndustryCode1",
            "label": "Industry Code 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IndustryCode2",
            "label": "Industry Code 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IndustryCode3",
            "label": "Industry Code 3",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IndustryCode4",
            "label": "Industry Code 4",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IndustryCode5",
            "label": "Industry Code 5",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "InternationalLocationNumber1",
            "label": "Int. location no. 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 7,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "InternationalLocationNumber2",
            "label": "Int. location no. 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 5,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "InternationalLocationNumber3",
            "label": "Check digit",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "NielsenRegion",
            "label": "Nielsen Indicator",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PaymentReason",
            "label": "Payment Reason",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ResponsibleType",
            "label": "Tax Type",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "TaxNumber1",
            "label": "Tax Number 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 16,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumber2",
            "label": "Tax Number 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 11,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumber3",
            "label": "Tax Number 3",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 18,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumber4",
            "label": "Tax Number 4",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 18,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumber5",
            "label": "Tax Number 5",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 60,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumberType",
            "label": "Tax Number Type",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "VATRegistration",
            "label": "VAT Registration No.",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 20,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "DeletionIndicator",
            "label": "Deletion Flag",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ExpressTrainStationName",
            "label": "Express station",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 25,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "TrainStationName",
            "label": "Train station",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 25,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CityCode",
            "label": "City Code",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "County",
            "label": "County Code",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "CustomerCompany",
        "title": "Customer Company Code Data",
        "entitySet": "CustomerCompany",
        "remoteEntity": "A_CustomerCompany",
        "relationField": "Customer",
        "typeName": "A_CustomerCompanyType",
        "kind": "collection",
        "summaryFields": [
          "CompanyCode",
          "ReconciliationAccount",
          "PaymentTerms",
          "PaymentBlockingReason",
          "HouseBank"
        ],
        "requiredCreateFields": [
          "CompanyCode"
        ],
        "fields": [
          {
            "name": "Customer",
            "label": "Customer",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CompanyCode",
            "label": "Company Code",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AccountingClerk",
            "label": "Clerk Abbrev.",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AlternativePayerAccount",
            "label": "Alternative payer",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerAccountNote",
            "label": "Account Memo",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 30,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "HouseBank",
            "label": "House Bank",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 5,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PaymentBlockingReason",
            "label": "Payment Block",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PaymentMethodsList",
            "label": "Payment Methods",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PaymentTerms",
            "label": "Terms of Payment",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ReconciliationAccount",
            "label": "Reconciliation Acct",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "CustomerSalesArea",
        "title": "Customer Sales Area Data",
        "entitySet": "CustomerSalesArea",
        "remoteEntity": "A_CustomerSalesArea",
        "relationField": "Customer",
        "typeName": "A_CustomerSalesAreaType",
        "kind": "collection",
        "summaryFields": [
          "SalesOrganization",
          "DistributionChannel",
          "Division",
          "CreditControlArea",
          "Currency",
          "CustomerPaymentTerms"
        ],
        "requiredCreateFields": [
          "SalesOrganization",
          "DistributionChannel",
          "Division"
        ],
        "fields": [
          {
            "name": "Customer",
            "label": "Customer",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SalesOrganization",
            "label": "Sales Organization",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "DistributionChannel",
            "label": "Distribution Channel",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Division",
            "label": "Division",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BillingIsBlockedForCustomer",
            "label": "BBlock for SlsA",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CreditControlArea",
            "label": "Credit Control Area",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Currency",
            "label": "Currency",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 5,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerPaymentTerms",
            "label": "Terms of Payment",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerPriceGroup",
            "label": "Customer Price Group",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerPricingProcedure",
            "label": "Cust.Pric.Procedure",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "DeliveryPriority",
            "label": "Delivery Priority",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ShippingCondition",
            "label": "Shipping Conditions",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AdditionalCustomerGroup1",
            "label": "Customer Group 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AdditionalCustomerGroup2",
            "label": "Customer Group 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AdditionalCustomerGroup3",
            "label": "Customer Group 3",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AdditionalCustomerGroup4",
            "label": "Customer Group 4",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AdditionalCustomerGroup5",
            "label": "Customer Group 5",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "CustomerTaxGrouping",
        "title": "Customer Tax Categories",
        "entitySet": "CustomerTaxGrouping",
        "remoteEntity": "A_CustomerTaxGrouping",
        "relationField": "Customer",
        "typeName": "A_CustomerTaxGroupingType",
        "kind": "collection",
        "summaryFields": [
          "CustomerTaxGroupingCode",
          "CustTaxGroupSubjectedStartDate",
          "CustTaxGroupSubjectedEndDate",
          "CustTaxGrpExemptionCertificate",
          "CustTaxGroupExemptionRate"
        ],
        "requiredCreateFields": [
          "CustomerTaxGroupingCode"
        ],
        "fields": [
          {
            "name": "Customer",
            "label": "Customer",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerTaxGroupingCode",
            "label": "Tax Category",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustTaxGrpExemptionCertificate",
            "label": "Exempt. Number",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 15,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustTaxGroupExemptionRate",
            "label": "Exemption Rate",
            "type": "cds.Decimal",
            "key": false,
            "nullable": true,
            "precision": 5,
            "scale": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustTaxGroupExemptionStartDate",
            "label": "Exempted from",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustTaxGroupExemptionEndDate",
            "label": "Exempted Until",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustTaxGroupSubjectedStartDate",
            "label": "subjected from",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustTaxGroupSubjectedEndDate",
            "label": "subjected until",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "CustomerTaxIndicators",
        "title": "Customer Tax Indicators",
        "entitySet": "A_CustomerSalesAreaTax",
        "remoteEntity": "A_CustomerSalesAreaTax",
        "relationField": "Customer",
        "typeName": "A_CustomerSalesAreaTaxType",
        "kind": "collection",
        "creatable": false,
        "deletable": false,
        "emptyText": "No tax indicators for this customer.",
        "summaryFields": [
          "DepartureCountry",
          "CustomerTaxCategory",
          "CustomerTaxClassification",
          "SalesOrganization",
          "DistributionChannel",
          "Division"
        ],
        "fields": [
          {
            "name": "Customer",
            "label": "Customer",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SalesOrganization",
            "label": "Sales Organization",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "DistributionChannel",
            "label": "RefDistCh-Cust/Mat.",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Division",
            "label": "Division",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "DepartureCountry",
            "label": "Departure Ctry/Reg.",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerTaxCategory",
            "label": "Tax Condition Type",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CustomerTaxClassification",
            "label": "Tax Classification",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "Suppliers",
        "title": "Supplier Data",
        "entitySet": "Suppliers",
        "remoteEntity": "A_Supplier",
        "relationField": "Supplier",
        "typeName": "A_SupplierType",
        "kind": "single",
        "creatable": true,
        "deletable": false,
        "childSections": [
          "SupplierCompany",
          "SupplierPurchasingOrg"
        ],
        "fieldGroups": [
          {
            "title": "Control Data",
            "fields": [
              "Supplier",
              "SupplierAccountGroup",
              "SupplierFullName",
              "SupplierName",
              "SupplierCorporateGroup",
              "AuthorizationGroup",
              "CreatedByUser",
              "CreationDate"
            ]
          },
          {
            "title": "Tax Information",
            "fields": [
              "VATRegistration",
              "TaxNumberType",
              "TaxNumber1",
              "TaxNumber2",
              "TaxNumber3",
              "TaxNumber4",
              "TaxNumber5",
              "TaxNumberResponsible",
              "FiscalAddress",
              "ResponsibleType",
              "IsNaturalPerson",
              "BR_TaxIsSplit"
            ]
          },
          {
            "title": "Quality Management",
            "fields": [
              "SuplrQualityManagementSystem",
              "SuplrQltyInProcmtCertfnValidTo",
              "SuplrProofOfDelivRlvtCode"
            ]
          },
          {
            "title": "Reference Data",
            "fields": [
              "Customer",
              "Industry",
              "AlternativePayeeAccountNumber",
              "PaymentReason",
              "DataExchangeInstructionKey",
              "BirthDate",
              "ConcatenatedInternationalLocNo",
              "InternationalLocationNumber1",
              "InternationalLocationNumber2",
              "InternationalLocationNumber3"
            ]
          },
          {
            "title": "Blocks and Status",
            "fields": [
              "PaymentIsBlockedForSupplier",
              "PostingIsBlocked",
              "PurchasingIsBlocked",
              "SupplierProcurementBlock",
              "DeletionIndicator"
            ]
          }
        ],
        "summaryFields": [
          "SupplierFullName",
          "SupplierAccountGroup",
          "VATRegistration",
          "PaymentIsBlockedForSupplier",
          "PostingIsBlocked",
          "PurchasingIsBlocked"
        ],
        "requiredCreateFields": [
          "SupplierAccountGroup"
        ],
        "fields": [
          {
            "name": "Supplier",
            "label": "Supplier",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AlternativePayeeAccountNumber",
            "label": "Alternative Payee",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AuthorizationGroup",
            "label": "Authorization",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CreatedByUser",
            "label": "Created by",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 12,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "CreationDate",
            "label": "Created On",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "Customer",
            "label": "Customer",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PaymentIsBlockedForSupplier",
            "label": "Payment block",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PostingIsBlocked",
            "label": "Posting Block",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PurchasingIsBlocked",
            "label": "Purch. block",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SupplierAccountGroup",
            "label": "Account Group",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SupplierFullName",
            "label": "Supplier Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 220,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "SupplierName",
            "label": "Name of Supplier",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 80,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "VATRegistration",
            "label": "VAT Registration No.",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 20,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "BirthDate",
            "label": "Date of Birth",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ConcatenatedInternationalLocNo",
            "label": "Int. Location No.",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 20,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "DeletionIndicator",
            "label": "Deletion Flag",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "FiscalAddress",
            "label": "Fiscal address",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "Industry",
            "label": "Industry",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "InternationalLocationNumber1",
            "label": "Int. location no. 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 7,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "InternationalLocationNumber2",
            "label": "Int. location no. 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 5,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "InternationalLocationNumber3",
            "label": "Check digit",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "IsNaturalPerson",
            "label": "Natural Person",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "PaymentReason",
            "label": "Payment Reason",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ResponsibleType",
            "label": "Tax Type",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SuplrQltyInProcmtCertfnValidTo",
            "label": "QM System Valid To",
            "type": "cds.Date",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SuplrQualityManagementSystem",
            "label": "Actual QM System",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SupplierCorporateGroup",
            "label": "Group Key",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SupplierProcurementBlock",
            "label": "Block Function",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "TaxNumber1",
            "label": "Tax Number 1",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 16,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumber2",
            "label": "Tax Number 2",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 11,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumber3",
            "label": "Tax Number 3",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 18,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumber4",
            "label": "Tax Number 4",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 18,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumber5",
            "label": "Tax Number 5",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 60,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "TaxNumberResponsible",
            "label": "Tax Number",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 18,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "TaxNumberType",
            "label": "Tax Number Type",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "SuplrProofOfDelivRlvtCode",
            "label": "Relevant for POD",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "BR_TaxIsSplit",
            "label": "Tax split",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "DataExchangeInstructionKey",
            "label": "Instruction Key",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "SupplierCompany",
        "title": "Supplier Company Code Data",
        "entitySet": "SupplierCompany",
        "remoteEntity": "A_SupplierCompany",
        "relationField": "Supplier",
        "typeName": "A_SupplierCompanyType",
        "kind": "collection",
        "summaryFields": [
          "CompanyCode",
          "CompanyCodeName",
          "ReconciliationAccount",
          "PaymentTerms",
          "PaymentBlockingReason"
        ],
        "requiredCreateFields": [
          "CompanyCode"
        ],
        "fields": [
          {
            "name": "Supplier",
            "label": "Supplier",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CompanyCode",
            "label": "Company Code",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "CompanyCodeName",
            "label": "Company Name",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 25,
            "creatable": false,
            "updatable": false
          },
          {
            "name": "PaymentBlockingReason",
            "label": "Payment Block",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 1,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "AccountingClerk",
            "label": "Clerk Abbrev.",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 2,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PaymentMethodsList",
            "label": "Payment Methods",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PaymentTerms",
            "label": "Terms of Payment",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "HouseBank",
            "label": "House Bank",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 5,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "ReconciliationAccount",
            "label": "Reconciliation Acct",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          }
        ]
      },
      {
        "id": "SupplierPurchasingOrg",
        "title": "Supplier Purchasing Organization Data",
        "entitySet": "SupplierPurchasingOrg",
        "remoteEntity": "A_SupplierPurchasingOrg",
        "relationField": "Supplier",
        "typeName": "A_SupplierPurchasingOrgType",
        "kind": "collection",
        "summaryFields": [
          "PurchasingOrganization",
          "PurchasingGroup",
          "PaymentTerms",
          "PurchaseOrderCurrency",
          "PurchasingIsBlockedForSupplier"
        ],
        "requiredCreateFields": [
          "PurchasingOrganization"
        ],
        "fields": [
          {
            "name": "Supplier",
            "label": "Supplier",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 10,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PurchasingOrganization",
            "label": "Purch. Organization",
            "type": "cds.String",
            "key": true,
            "nullable": false,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "IncotermsClassification",
            "label": "Incoterms",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "InvoiceIsGoodsReceiptBased",
            "label": "GR-Based Inv. Verif.",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "MinimumOrderAmount",
            "label": "Minimum order value",
            "type": "cds.Decimal",
            "key": false,
            "nullable": true,
            "precision": 14,
            "scale": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PaymentTerms",
            "label": "Terms of Payment",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 4,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PurchaseOrderCurrency",
            "label": "Order currency",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 5,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PurchasingGroup",
            "label": "Purchasing Group",
            "type": "cds.String",
            "key": false,
            "nullable": true,
            "maxLength": 3,
            "creatable": true,
            "updatable": true
          },
          {
            "name": "PurchasingIsBlockedForSupplier",
            "label": "Pur. block POrg",
            "type": "cds.Boolean",
            "key": false,
            "nullable": true,
            "creatable": true,
            "updatable": true
          }
        ]
      }
    ]
  };
});
