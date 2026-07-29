using { BusinessPartnerService as service } from './business-partner-service';

//
// --- List Report + Object Page annotations for BusinessPartners --------------
//

annotate service.BusinessPartners with @(

  // Title / subtitle shown on the object page header
  UI.HeaderInfo: {
    TypeName      : '{i18n>BusinessPartner}',
    TypeNamePlural: '{i18n>BusinessPartners}',
    Title         : { Value: BusinessPartnerFullName },
    Description   : { Value: BusinessPartner }
  },

  // Filter bar fields on the list report
  UI.SelectionFields: [
    BusinessPartner,
    BusinessPartnerCategory_code,
    BusinessPartnerGrouping_code,
    IsBlocked
  ],

  // Columns of the list report table
  UI.LineItem: [
    { Value: BusinessPartner,               Label: '{i18n>BusinessPartner}' },
    { Value: BusinessPartnerFullName,        Label: '{i18n>FullName}' },
    { Value: BusinessPartnerCategory_code,   Label: '{i18n>Category}' },
    { Value: BusinessPartnerGrouping_code,    Label: '{i18n>Grouping}' },
    { Value: IsBlocked,                       Label: '{i18n>Blocked}',
      Criticality: #Negative, CriticalityRepresentation: #WithoutIcon }
  ],

  // Object page layout
  UI.Facets: [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'GeneralInfoFacet',
      Label : '{i18n>GeneralInformation}',
      Target: '@UI.FieldGroup#General'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'AddressesFacet',
      Label : '{i18n>Addresses}',
      Target: 'to_Addresses/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'RolesFacet',
      Label : '{i18n>Roles}',
      Target: 'to_Roles/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'BankFacet',
      Label : '{i18n>BankDetails}',
      Target: 'to_BankDetails/@UI.LineItem'
    }
  ],

  UI.FieldGroup #General: {
    Data: [
      { Value: BusinessPartner },
      { Value: BusinessPartnerCategory_code },
      { Value: BusinessPartnerGrouping_code },
      { Value: BusinessPartnerFullName },
      { Value: FirstName },
      { Value: LastName },
      { Value: OrganizationBPName1 },
      { Value: SearchTerm1 },
      { Value: IsBlocked },
      { Value: IsMarkedForArchiving }
    ]
  }
);

// Value help for the category, grouping and title code fields
annotate service.BusinessPartners with {
  BusinessPartnerCategory @Common.ValueList: { CollectionPath: 'BusinessPartnerCategories', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: BusinessPartnerCategory_code, ValueListProperty: 'code' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
  ]};
  BusinessPartnerGrouping @Common.ValueList: { CollectionPath: 'BusinessPartnerGroupings', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: BusinessPartnerGrouping_code, ValueListProperty: 'code' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
  ]};
}

//
// --- Nested tables (object page) ---------------------------------------------
//

annotate service.Addresses with @(
  UI.LineItem: [
    { Value: AddressID,    Label: '{i18n>AddressID}' },
    { Value: StreetName,   Label: '{i18n>Street}' },
    { Value: HouseNumber,  Label: '{i18n>HouseNumber}' },
    { Value: PostalCode,   Label: '{i18n>PostalCode}' },
    { Value: CityName,     Label: '{i18n>City}' },
    { Value: Country_code, Label: '{i18n>Country}' },
    { Value: EmailAddress, Label: '{i18n>Email}' }
  ]
);

annotate service.BusinessPartnerRoles with @(
  UI.LineItem: [
    { Value: BusinessPartnerRole_code, Label: '{i18n>Role}' },
    { Value: ValidFrom,                Label: '{i18n>ValidFrom}' },
    { Value: ValidTo,                  Label: '{i18n>ValidTo}' }
  ]
);

annotate service.BankDetails with @(
  UI.LineItem: [
    { Value: BankIdentification, Label: '{i18n>BankID}' },
    { Value: BankCountry_code,   Label: '{i18n>BankCountry}' },
    { Value: IBAN,               Label: '{i18n>IBAN}' },
    { Value: SWIFTCode,          Label: '{i18n>SWIFT}' }
  ]
);
