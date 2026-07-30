using { BusinessPartnerService as service } from './business-partner-service';

//
// --- List Report + Object Page annotations for the live BusinessPartners ------
// Fields come straight from S/4HANA API_BUSINESS_PARTNER (read-only).
//
annotate service.BusinessPartners with @(

  UI.HeaderInfo: {
    TypeName      : 'Business Partner',
    TypeNamePlural: 'Business Partners',
    Title         : { Value: BusinessPartnerFullName },
    Description   : { Value: BusinessPartner }
  },

  // Filter bar fields on the list report
  UI.SelectionFields: [
    BusinessPartner,
    BusinessPartnerCategory,
    BusinessPartnerGrouping
  ],

  // Columns of the list report table
  UI.LineItem: [
    { Value: BusinessPartner,         Label: 'Business Partner' },
    { Value: BusinessPartnerFullName, Label: 'Full Name' },
    { Value: BusinessPartnerCategory, Label: 'Category' },
    { Value: BusinessPartnerGrouping, Label: 'Grouping' },
    { Value: SearchTerm1,             Label: 'Search Term' }
  ],

  // Object page layout
  UI.Facets: [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'GeneralInfoFacet',
      Label : 'General Information',
      Target: '@UI.FieldGroup#General'
    }
  ],

  UI.FieldGroup #General: {
    Data: [
      { Value: BusinessPartner },
      { Value: BusinessPartnerFullName },
      { Value: BusinessPartnerName },
      { Value: BusinessPartnerCategory },
      { Value: BusinessPartnerGrouping },
      { Value: SearchTerm1 },
      { Value: FirstName },
      { Value: LastName },
      { Value: OrganizationBPName1 }
    ]
  }
);
