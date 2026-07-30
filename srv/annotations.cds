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
  BusinessPartnerCategory @Core.Immutable;
  BusinessPartnerGrouping @Core.Immutable;
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

annotate service.BusinessPartnerRoles with @(
  UI.LineItem: [
    { Value: BusinessPartnerRole, Label: 'Role' },
    { Value: ValidFrom,           Label: 'Valid From' },
    { Value: ValidTo,             Label: 'Valid To' }
  ]
);

annotate service.TaxNumbers with @(
  UI.LineItem: [
    { Value: BPTaxType,       Label: 'Tax Type' },
    { Value: BPTaxNumber,     Label: 'Tax Number' },
    { Value: BPTaxLongNumber, Label: 'Long Tax Number' }
  ]
);

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

annotate service.Industries with @(
  UI.LineItem: [
    { Value: IndustrySystemType,     Label: 'Industry System' },
    { Value: IndustrySector,         Label: 'Industry' },
    { Value: IndustryKeyDescription, Label: 'Description' },
    { Value: IsStandardIndustry,     Label: 'Standard Industry' }
  ]
);

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
