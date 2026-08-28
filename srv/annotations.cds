using { BusinessPartnerService as service } from './business-partner-service';

annotate service.BusinessPartners with @(
  UI.HeaderInfo: {
    TypeName      : 'Business Partner',
    TypeNamePlural: 'Business Partners',
    Title         : { Value: BusinessPartnerFullName },
    Description   : { Value: BusinessPartner }
  },

  UI.SelectionFields: [
    BusinessPartner,
    BusinessPartnerCategory,
    BusinessPartnerGrouping,
    BusinessPartnerIsBlocked
  ],

  UI.LineItem: [
    { Value: BusinessPartner,          Label: 'Business Partner' },
    { Value: BusinessPartnerFullName,  Label: 'Full Name' },
    { Value: BusinessPartnerCategory,  Label: 'Category' },
    { Value: BusinessPartnerGrouping,  Label: 'Grouping' },
    { Value: SearchTerm1,              Label: 'Search Term' },
    { Value: BusinessPartnerIsBlocked, Label: 'Blocked' }
  ],

  UI.Facets: [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'GeneralInfoFacet',
      Label : 'General Information',
      Target: '@UI.FieldGroup#General'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'NamesFacet',
      Label : 'Names',
      Target: '@UI.FieldGroup#Names'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'AddressesFacet',
      Label : 'Addresses',
      Target: 'to_BusinessPartnerAddress/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'RolesFacet',
      Label : 'Roles',
      Target: 'to_BusinessPartnerRole/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'TaxNumbersFacet',
      Label : 'Tax Numbers',
      Target: 'to_BusinessPartnerTax/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'BankDetailsFacet',
      Label : 'Bank Details',
      Target: 'to_BusinessPartnerBank/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'IdentificationFacet',
      Label : 'Identification',
      Target: 'to_BuPaIdentification/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'IndustriesFacet',
      Label : 'Industries',
      Target: 'to_BuPaIndustry/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'CustomerFacet',
      Label : 'Customer Data',
      Target: 'to_Customer/@UI.FieldGroup#Customer'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'SupplierFacet',
      Label : 'Supplier Data',
      Target: 'to_Supplier/@UI.FieldGroup#Supplier'
    }
  ],

  UI.FieldGroup #General: {
    Data: [
      { Value: BusinessPartner,          Label: 'Business Partner' },
      { Value: BusinessPartnerCategory,  Label: 'Category' },
      { Value: BusinessPartnerGrouping,  Label: 'Grouping' },
      { Value: SearchTerm1,              Label: 'Search Term 1' },
      { Value: SearchTerm2,              Label: 'Search Term 2' },
      { Value: CorrespondenceLanguage,   Label: 'Correspondence Language' },
      { Value: BusinessPartnerIsBlocked, Label: 'Blocked' },
      { Value: IsMarkedForArchiving,     Label: 'Marked for Archiving' }
    ]
  },

  UI.FieldGroup #Names: {
    Data: [
      { Value: FirstName,                 Label: 'First Name' },
      { Value: MiddleName,                Label: 'Middle Name' },
      { Value: LastName,                  Label: 'Last Name' },
      { Value: OrganizationBPName1,       Label: 'Organization Name 1' },
      { Value: OrganizationBPName2,       Label: 'Organization Name 2' },
      { Value: GroupBusinessPartnerName1, Label: 'Group Name 1' },
      { Value: GroupBusinessPartnerName2, Label: 'Group Name 2' },
      { Value: BusinessPartnerFullName,   Label: 'Full Name' }
    ]
  }
);

// S/4 generates these values. Category and grouping are fixed after creation.
annotate service.BusinessPartners with {
  BusinessPartner         @Core.Computed;
  BusinessPartnerFullName @Core.Computed;
  BusinessPartnerName     @Core.Computed;
  BusinessPartnerUUID     @Core.Computed;
  CreationDate            @Core.Computed;
  CreationTime            @Core.Computed;
  CreatedByUser           @Core.Computed;
  LastChangeDate          @Core.Computed;
  LastChangeTime          @Core.Computed;
  LastChangedByUser       @Core.Computed;
  ETag                    @Core.Computed;
  // Value help backed by ZSRVB_MDMLIGHT_VH (see srv/external/ZSRVB_MDMLIGHT_VH).
  // The UI additionally renders BusinessPartnerCategory as a fixed 3-value
  // Select (see BusinessPartnerMaintenance.controller.js) rather than this F4
  // dialog — the annotation is kept for OData consumers other than our UI.
  BusinessPartnerCategory @Core.Immutable @Common.ValueList: {
    CollectionPath: 'BusinessPartnerCategories',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: BusinessPartnerCategory, ValueListProperty: 'BusinessPartnerCategory' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerCategory_Text' }
    ]
  };
  BusinessPartnerGrouping @Core.Immutable @Common.ValueList: {
    CollectionPath: 'BusinessPartnerGroupings',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: BusinessPartnerGrouping, ValueListProperty: 'BusinessPartnerGrouping' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerGrouping_Text' }
    ]
  };
  LegalForm @Common.ValueList: {
    CollectionPath: 'LegalForms',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: LegalForm, ValueListProperty: 'LegalForm' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'LegalForm_Text' }
    ]
  };
  FormOfAddress @Common.ValueList: {
    CollectionPath: 'FormsOfAddress',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: FormOfAddress, ValueListProperty: 'FormOfAddress' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'FormOfAddress_Text' }
    ]
  };
  AcademicTitle @Common.ValueList: {
    CollectionPath: 'AcademicTitles',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: AcademicTitle, ValueListProperty: 'AcademicTitle' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'AcademicTitle_Text' }
    ]
  };
  GenderCodeName @Common.ValueList: {
    CollectionPath: 'Genders',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: GenderCodeName, ValueListProperty: 'GenderCodeName' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'GenderCodeName_Text' }
    ]
  };
  Industry @Common.ValueList: {
    CollectionPath: 'IndustryCodes',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Industry, ValueListProperty: 'BusinessPartnerIndustryCode' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerIndustryCode_Text' }
    ]
  };
  CorrespondenceLanguage @Common.ValueList: {
    CollectionPath: 'Languages',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CorrespondenceLanguage, ValueListProperty: 'Language' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Language_Text' }
    ]
  };
};

annotate service.Addresses with @(
  UI.LineItem: [
    { Value: AddressID,   Label: 'Address ID' },
    { Value: StreetName,  Label: 'Street' },
    { Value: HouseNumber, Label: 'House Number' },
    { Value: PostalCode,  Label: 'Postal Code' },
    { Value: CityName,    Label: 'City' },
    { Value: Region,      Label: 'Region' },
    { Value: Country,     Label: 'Country' }
  ]
);

annotate service.Addresses with {
  Country @Common.ValueList: {
    CollectionPath: 'Countries',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Country, ValueListProperty: 'Country' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Country_Text' }
    ]
  };
  Region @Common.ValueList: {
    CollectionPath: 'Regions',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Region, ValueListProperty: 'Region' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Region_Text' }
    ]
  };
  Language @Common.ValueList: {
    CollectionPath: 'Languages',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Language, ValueListProperty: 'Language' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Language_Text' }
    ]
  };
  FormOfAddress @Common.ValueList: {
    CollectionPath: 'FormsOfAddress',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: FormOfAddress, ValueListProperty: 'FormOfAddress' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'FormOfAddress_Text' }
    ]
  };
};

annotate service.BusinessPartnerRoles with @(
  UI.LineItem: [
    { Value: BusinessPartnerRole, Label: 'Role' },
    { Value: ValidFrom,           Label: 'Valid From' },
    { Value: ValidTo,             Label: 'Valid To' }
  ]
);

annotate service.BusinessPartnerRoles with {
  // BusinessPartnerRoleCodes (not BusinessPartnerRoles — that name is already
  // this entity itself) is the code/text list from ZSRVB_MDMLIGHT_VH.
  BusinessPartnerRole @Common.ValueList: {
    CollectionPath: 'BusinessPartnerRoleCodes',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: BusinessPartnerRole, ValueListProperty: 'BusinessPartnerRole' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerRole_Text' }
    ]
  };
};

annotate service.TaxNumbers with @(
  UI.LineItem: [
    { Value: BPTaxType,       Label: 'Tax Type' },
    { Value: BPTaxNumber,     Label: 'Tax Number' },
    { Value: BPTaxLongNumber, Label: 'Long Tax Number' }
  ]
);

annotate service.TaxNumbers with {
  // TaxTypes, not AddressDependentTaxTypes: the latter is the address-dependent subset and returns
  // a single row (FR1) on this system, so BE0/BE1/BE2 could never be picked. The service collapses
  // the language key to one row per category — see oneRowPerTaxType.
  BPTaxType @Common.ValueList: {
    CollectionPath: 'TaxTypes',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: BPTaxType, ValueListProperty: 'BPTaxType' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'TaxTypeName' }
    ]
  };
};

annotate service.BankDetails with @(
  UI.LineItem: [
    { Value: BankIdentification,    Label: 'Bank ID' },
    { Value: BankCountryKey,        Label: 'Bank Country' },
    { Value: BankName,              Label: 'Bank Name' },
    { Value: IBAN,                  Label: 'IBAN' },
    { Value: SWIFTCode,             Label: 'SWIFT / BIC' },
    { Value: BankAccountHolderName, Label: 'Account Holder' }
  ]
);

annotate service.Identifications with @(
  UI.LineItem: [
    { Value: BPIdentificationType,     Label: 'Identification Type' },
    { Value: BPIdentificationNumber,   Label: 'Identification Number' },
    { Value: BPIdnNmbrIssuingInstitute, Label: 'Issuing Institute' },
    { Value: Country,                  Label: 'Country' },
    { Value: ValidityStartDate,        Label: 'Valid From' },
    { Value: ValidityEndDate,          Label: 'Valid To' }
  ]
);

annotate service.Identifications with {
  // IdentificationTypes has no description column in ZSRVB_MDMLIGHT_VH —
  // the value help lists the raw code only.
  BPIdentificationType @Common.ValueList: {
    CollectionPath: 'IdentificationTypes',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: BPIdentificationType, ValueListProperty: 'BPIdentificationType' }
    ]
  };
  Country @Common.ValueList: {
    CollectionPath: 'Countries',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Country, ValueListProperty: 'Country' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Country_Text' }
    ]
  };
};

annotate service.Industries with @(
  UI.LineItem: [
    { Value: IndustrySystemType,     Label: 'Industry System' },
    { Value: IndustrySector,         Label: 'Industry' },
    { Value: IndustryKeyDescription, Label: 'Description' },
    { Value: IsStandardIndustry,     Label: 'Standard Industry' }
  ]
);

annotate service.Industries with {
  IndustrySystemType @Common.ValueList: {
    CollectionPath: 'IndustrySystems',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: IndustrySystemType, ValueListProperty: 'IndustrySystemType' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'IndustrySystemType_Text' }
    ]
  };
  // IndustrySectors is keyed by IndustrySystemType + IndustrySector in S/4;
  // this value help searches by IndustrySector alone (not scoped to the
  // system already chosen on the record).
  IndustrySector @Common.ValueList: {
    CollectionPath: 'IndustrySectors',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: IndustrySector, ValueListProperty: 'IndustrySector' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'IndustrySector_Text' }
    ]
  };
};

annotate service.Customers with @(
  UI.FieldGroup #Customer: {
    Data: [
      { Value: Customer,                     Label: 'Customer' },
      { Value: CustomerAccountGroup,         Label: 'Account Group' },
      { Value: CustomerFullName,             Label: 'Customer Name' },
      { Value: PostingIsBlocked,             Label: 'Posting Blocked' },
      { Value: DeliveryIsBlocked,            Label: 'Delivery Block' },
      { Value: BillingIsBlockedForCustomer,  Label: 'Billing Block' },
      { Value: OrderIsBlockedForCustomer,    Label: 'Order Block' }
    ]
  }
);

annotate service.Customers with {
  CustomerAccountGroup @Common.ValueList: {
    CollectionPath: 'CustomerAccountGroups',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CustomerAccountGroup, ValueListProperty: 'CustomerAccountGroup' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CustomerAccountGroup_Text' }
    ]
  };
  CustomerClassification @Common.ValueList: {
    CollectionPath: 'CustomerClassifications',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CustomerClassification, ValueListProperty: 'CustomerClassification' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CustomerClassification_Text' }
    ]
  };
  // Needed nothing new (abap/valuehelp/README.md) - the already-exposed TaxTypes set.
  TaxNumberType @Common.ValueList: {
    CollectionPath: 'TaxTypes',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: TaxNumberType, ValueListProperty: 'BPTaxType' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'TaxTypeName' }
    ]
  };
};

// A_CustomerType.IndustryCode1-5 (Additional Data) are Edm.String(10), the same length and domain
// as A_BusinessPartnerType.Industry, already wired to IndustryCodes above - reused rather than
// treated as five separate lookups.
annotate service.Customers with {
  IndustryCode1 @Common.ValueList: { CollectionPath: 'IndustryCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: IndustryCode1, ValueListProperty: 'BusinessPartnerIndustryCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerIndustryCode_Text' }
  ] };
  IndustryCode2 @Common.ValueList: { CollectionPath: 'IndustryCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: IndustryCode2, ValueListProperty: 'BusinessPartnerIndustryCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerIndustryCode_Text' }
  ] };
  IndustryCode3 @Common.ValueList: { CollectionPath: 'IndustryCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: IndustryCode3, ValueListProperty: 'BusinessPartnerIndustryCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerIndustryCode_Text' }
  ] };
  IndustryCode4 @Common.ValueList: { CollectionPath: 'IndustryCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: IndustryCode4, ValueListProperty: 'BusinessPartnerIndustryCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerIndustryCode_Text' }
  ] };
  IndustryCode5 @Common.ValueList: { CollectionPath: 'IndustryCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: IndustryCode5, ValueListProperty: 'BusinessPartnerIndustryCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerIndustryCode_Text' }
  ] };
};

annotate service.Suppliers with @(
  UI.FieldGroup #Supplier: {
    Data: [
      { Value: Supplier,                    Label: 'Supplier' },
      { Value: SupplierAccountGroup,        Label: 'Account Group' },
      { Value: SupplierFullName,            Label: 'Supplier Name' },
      { Value: PostingIsBlocked,            Label: 'Posting Blocked' },
      { Value: PurchasingIsBlocked,         Label: 'Purchasing Blocked' },
      { Value: PaymentIsBlockedForSupplier, Label: 'Payment Blocked' }
    ]
  }
);

annotate service.Suppliers with {
  SupplierAccountGroup @Common.ValueList: {
    CollectionPath: 'SupplierAccountGroups',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: SupplierAccountGroup, ValueListProperty: 'SupplierAccountGroup' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'SupplierAccountGroup_Text' }
    ]
  };
  TaxNumberType @Common.ValueList: {
    CollectionPath: 'TaxTypes',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: TaxNumberType, ValueListProperty: 'BPTaxType' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'TaxTypeName' }
    ]
  };
};

// KNVI-TATYP - country-scoped (CustomerTaxCategories is keyed by Country + SequenceNumber, and
// CustomerTaxGrouping carries no country of its own to filter the dialog by), so this lists every
// country's rows rather than just the customer's own.
annotate service.CustomerTaxGrouping with {
  CustomerTaxGroupingCode @Common.ValueList: {
    CollectionPath: 'CustomerTaxCategories',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CustomerTaxGroupingCode, ValueListProperty: 'TaxCategory' }
    ]
  };
};

// Org-unit and pricing value helps (abap/valuehelp/README.md, 2026-08-28) - released SAP views
// activated on the service; see srv/business-partner-service.cds for which.
annotate service.CustomerCompany with {
  CompanyCode @Common.ValueList: {
    CollectionPath: 'CompanyCodes',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CompanyCode, ValueListProperty: 'CompanyCode' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CompanyCodeName' }
    ]
  };
};

annotate service.SupplierCompany with {
  CompanyCode @Common.ValueList: {
    CollectionPath: 'CompanyCodes',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CompanyCode, ValueListProperty: 'CompanyCode' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CompanyCodeName' }
    ]
  };
};

annotate service.CustomerSalesArea with {
  SalesOrganization @Common.ValueList: {
    CollectionPath: 'SalesOrganizations',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: SalesOrganization, ValueListProperty: 'SalesOrganization' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'SalesOrganization_Text' }
    ]
  };
  DistributionChannel @Common.ValueList: {
    CollectionPath: 'DistributionChannels',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: DistributionChannel, ValueListProperty: 'DistributionChannel' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'DistributionChannel_Text' }
    ]
  };
  Division @Common.ValueList: {
    CollectionPath: 'Divisions',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Division, ValueListProperty: 'Division' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Division_Text' }
    ]
  };
  // KNVV-BZIRK - joined the mandatory fields this section requires 2026-08-28.
  SalesDistrict @Common.ValueList: {
    CollectionPath: 'SalesDistricts',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: SalesDistrict, ValueListProperty: 'SalesDistrict' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'SalesDistrict_Text' }
    ]
  };
  CustomerPriceGroup @Common.ValueList: {
    CollectionPath: 'CustomerPriceGroups',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CustomerPriceGroup, ValueListProperty: 'CustomerPriceGroup' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CustomerPriceGroup_Text' }
    ]
  };
  // C_CustPriceProcedureTextVHTemp - Language is part of its own key, collapsed server-side the same
  // way TaxTypes is (oneRowPerTaxType), so this collection already carries one row per procedure.
  CustomerPricingProcedure @Common.ValueList: {
    CollectionPath: 'CustomerPricingProcedures',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CustomerPricingProcedure, ValueListProperty: 'CustomerPricingProcedure' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CustomerPricingProcedureText' }
    ]
  };
  Currency @Common.ValueList: {
    CollectionPath: 'Currencies',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Currency, ValueListProperty: 'Currency' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Currency_Text' }
    ]
  };
};

annotate service.SupplierPurchasingOrg with {
  PurchasingOrganization @Common.ValueList: {
    CollectionPath: 'PurchasingOrganizations',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: PurchasingOrganization, ValueListProperty: 'PurchasingOrganization' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'PurchasingOrganizationName' }
    ]
  };
  PurchaseOrderCurrency @Common.ValueList: {
    CollectionPath: 'Currencies',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: PurchaseOrderCurrency, ValueListProperty: 'Currency' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Currency_Text' }
    ]
  };
};

// The same field, the same value help, on the text/dunning/withholding-tax children of the sections
// already annotated above - no new VH entity needed, these were simply never carried over to the
// sibling nodes that repeat the same key. VALUE_HELP_FIELDS on the maintenance screen already covers
// every one of these by field name alone (it does not key off section), so this is CDS-side
// consistency for other OData consumers rather than a change to what the app itself renders.
annotate service.A_CustomerText with {
  Language @Common.ValueList: { CollectionPath: 'Languages', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Language, ValueListProperty: 'Language' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Language_Text' }
  ] };
};
annotate service.A_SupplierText with {
  Language @Common.ValueList: { CollectionPath: 'Languages', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Language, ValueListProperty: 'Language' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Language_Text' }
  ] };
};
annotate service.A_CustomerCompanyText with {
  Language @Common.ValueList: { CollectionPath: 'Languages', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Language, ValueListProperty: 'Language' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Language_Text' }
  ] };
  CompanyCode @Common.ValueList: { CollectionPath: 'CompanyCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CompanyCode, ValueListProperty: 'CompanyCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CompanyCodeName' }
  ] };
};
annotate service.A_SupplierCompanyText with {
  Language @Common.ValueList: { CollectionPath: 'Languages', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Language, ValueListProperty: 'Language' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Language_Text' }
  ] };
  CompanyCode @Common.ValueList: { CollectionPath: 'CompanyCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CompanyCode, ValueListProperty: 'CompanyCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CompanyCodeName' }
  ] };
};
annotate service.A_CustomerDunning with {
  CompanyCode @Common.ValueList: { CollectionPath: 'CompanyCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CompanyCode, ValueListProperty: 'CompanyCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CompanyCodeName' }
  ] };
};
annotate service.A_SupplierDunning with {
  CompanyCode @Common.ValueList: { CollectionPath: 'CompanyCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CompanyCode, ValueListProperty: 'CompanyCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CompanyCodeName' }
  ] };
};
annotate service.A_CustomerWithHoldingTax with {
  CompanyCode @Common.ValueList: { CollectionPath: 'CompanyCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CompanyCode, ValueListProperty: 'CompanyCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CompanyCodeName' }
  ] };
};
annotate service.A_SupplierWithHoldingTax with {
  CompanyCode @Common.ValueList: { CollectionPath: 'CompanyCodes', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: CompanyCode, ValueListProperty: 'CompanyCode' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'CompanyCodeName' }
  ] };
};
annotate service.A_CustomerSalesAreaText with {
  Language @Common.ValueList: { CollectionPath: 'Languages', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Language, ValueListProperty: 'Language' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Language_Text' }
  ] };
  SalesOrganization @Common.ValueList: { CollectionPath: 'SalesOrganizations', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: SalesOrganization, ValueListProperty: 'SalesOrganization' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'SalesOrganization_Text' }
  ] };
  DistributionChannel @Common.ValueList: { CollectionPath: 'DistributionChannels', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: DistributionChannel, ValueListProperty: 'DistributionChannel' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'DistributionChannel_Text' }
  ] };
  Division @Common.ValueList: { CollectionPath: 'Divisions', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Division, ValueListProperty: 'Division' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Division_Text' }
  ] };
};
annotate service.A_CustSalesPartnerFunc with {
  SalesOrganization @Common.ValueList: { CollectionPath: 'SalesOrganizations', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: SalesOrganization, ValueListProperty: 'SalesOrganization' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'SalesOrganization_Text' }
  ] };
  DistributionChannel @Common.ValueList: { CollectionPath: 'DistributionChannels', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: DistributionChannel, ValueListProperty: 'DistributionChannel' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'DistributionChannel_Text' }
  ] };
  Division @Common.ValueList: { CollectionPath: 'Divisions', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Division, ValueListProperty: 'Division' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Division_Text' }
  ] };
};
annotate service.A_CustSlsAreaAddrDepdntInfo with {
  SalesOrganization @Common.ValueList: { CollectionPath: 'SalesOrganizations', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: SalesOrganization, ValueListProperty: 'SalesOrganization' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'SalesOrganization_Text' }
  ] };
  DistributionChannel @Common.ValueList: { CollectionPath: 'DistributionChannels', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: DistributionChannel, ValueListProperty: 'DistributionChannel' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'DistributionChannel_Text' }
  ] };
  Division @Common.ValueList: { CollectionPath: 'Divisions', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Division, ValueListProperty: 'Division' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Division_Text' }
  ] };
};
annotate service.A_SupplierPartnerFunc with {
  PurchasingOrganization @Common.ValueList: { CollectionPath: 'PurchasingOrganizations', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: PurchasingOrganization, ValueListProperty: 'PurchasingOrganization' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'PurchasingOrganizationName' }
  ] };
};
annotate service.A_SupplierPurchasingOrgText with {
  Language @Common.ValueList: { CollectionPath: 'Languages', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: Language, ValueListProperty: 'Language' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Language_Text' }
  ] };
  PurchasingOrganization @Common.ValueList: { CollectionPath: 'PurchasingOrganizations', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: PurchasingOrganization, ValueListProperty: 'PurchasingOrganization' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'PurchasingOrganizationName' }
  ] };
};

// The merged search list. Deliberately the same columns as BusinessPartners plus one status column:
// the point is that a pending create reads as a partner, so nobody requests it a second time.
annotate service.BusinessPartnerSearchResults with @(
  UI.HeaderInfo: {
    TypeName      : 'Business Partner',
    TypeNamePlural: 'Business Partners',
    Title         : { Value: BusinessPartnerFullName },
    Description   : { Value: RecordStatus }
  },

  // Every LineItem column that can be filtered on is listed here too, so "Adapt Filters" can offer
  // it - in OData V4 Fiori Elements the filter bar (and its Adapt Filters dialog) is built from
  // SelectionFields alone, unlike V2's "every property is a candidate" behaviour, so a column left
  // out of this list is simply never offerable as a filter, however visible it already is in the
  // table.
  //
  // The change-request columns (RecordStatus, IsChangeRequest, ChangeRequestType,
  // ChangeRequestStatus, RequestedBy, RequestedAt) are filterable too now (2026-08-28, asked for):
  // the READ handler evaluates a filter naming one of them against the full merged row rather than
  // forwarding it to S/4, which has never heard of them - see `referencedFields` in
  // search-results.js and its use in the READ handler. `ChangeRequest` (a raw UUID, not something a
  // person types) stays off this list on purpose, the same reasoning that keeps ResultKey and
  // RecordStatusCriticality off it - a field that means nothing as a typed value is not worth
  // offering as a filter candidate even though it can technically be filtered on.
  UI.SelectionFields: [
    BusinessPartner,
    BusinessPartnerFullName,
    BusinessPartnerCategory,
    BusinessPartnerGrouping,
    SearchTerm1,
    BusinessPartnerIsBlocked,
    RecordStatus,
    IsChangeRequest,
    ChangeRequestType,
    ChangeRequestStatus,
    RequestedBy,
    RequestedAt
  ],

  UI.LineItem: [
    { Value: BusinessPartner,          Label: 'Business Partner' },
    { Value: BusinessPartnerFullName,  Label: 'Full Name' },
    { Value: BusinessPartnerCategory,  Label: 'Category' },
    { Value: BusinessPartnerGrouping,  Label: 'Grouping' },
    { Value: SearchTerm1,              Label: 'Search Term' },
    { Value: BusinessPartnerIsBlocked, Label: 'Blocked' },
    // Criticality colours it, so an in-flight request is visible without reading the text.
    { Value: RecordStatus, Label: 'Status', Criticality: RecordStatusCriticality }
  ]
);

// This is its own entity (@cds.persistence.skip, merged in srv/search-results.js), not a
// projection on BusinessPartners - so the value-help annotations that already exist on
// BusinessPartners.BusinessPartnerCategory/.BusinessPartnerGrouping are not inherited here, and
// the list report's filter bar (and its "Adapt Filters" dialog) had no F4 help on either field.
// Reported directly - the CDS value-help views already exist, this is only the missing annotation.
annotate service.BusinessPartnerSearchResults with {
  BusinessPartnerCategory @Common.ValueList: {
    CollectionPath: 'BusinessPartnerCategories',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: BusinessPartnerCategory, ValueListProperty: 'BusinessPartnerCategory' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerCategory_Text' }
    ]
  };
  BusinessPartnerGrouping @Common.ValueList: {
    CollectionPath: 'BusinessPartnerGroupings',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: BusinessPartnerGrouping, ValueListProperty: 'BusinessPartnerGrouping' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'BusinessPartnerGrouping_Text' }
    ]
  };
  // ChangeRequestTypeValues/ChangeRequestStatusValues are local, not S/4 or ZSRVB_MDMLIGHT_VH data -
  // see business-partner-service.cds where they are declared. RecordStatus itself stays without a
  // value list: it is these two labels composed into prose ("Create in approval"), not a value
  // either list holds on its own - filter on ChangeRequestType/ChangeRequestStatus instead.
  ChangeRequestType @Common.ValueList: {
    CollectionPath: 'ChangeRequestTypeValues',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: ChangeRequestType, ValueListProperty: 'ChangeRequestType' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'ChangeRequestType_Text' }
    ]
  };
  ChangeRequestStatus @Common.ValueList: {
    CollectionPath: 'ChangeRequestStatusValues',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: ChangeRequestStatus, ValueListProperty: 'ChangeRequestStatus' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'ChangeRequestStatus_Text' }
    ]
  };
};
