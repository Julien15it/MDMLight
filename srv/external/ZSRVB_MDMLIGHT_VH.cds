/* checksum : 4522ad24a78df304465748e4fde408ee */
@cds.external : true
@m.IsDefaultEntityContainer : 'true'
service ZSRVB_MDMLIGHT_VH {};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Academic Title'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.AcademicTitles {
  @sap.display.format : 'UpperCase'
  @sap.text : 'AcademicTitle_Text'
  @sap.label : 'Academic Title 1'
  @sap.quickinfo : 'Academic Title: Key'
  key AcademicTitle : String(4) not null;
  @sap.label : 'Academ. Title Descr.'
  @sap.quickinfo : 'Academic title description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  AcademicTitle_Text : String(40);
  @sap.label : 'Academic Title'
  @sap.quickinfo : 'Academic Title: Written Form'
  AcademicTitleName : String(20);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Gender Value help'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.Genders {
  @sap.display.format : 'UpperCase'
  @sap.text : 'GenderCodeName_Text'
  @sap.label : 'Sex'
  @sap.quickinfo : 'Sex of business partner (person)'
  key GenderCodeName : String(1) not null;
  @sap.label : 'Sex Description'
  @sap.quickinfo : 'Gender of Business Partner'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  GenderCodeName_Text : String(50);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Trading Partner of Business Partner'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.TradingPartners {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Company'
  key TradingPartner : String(6) not null;
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'CDS View for BP Identification Types'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.IdentificationTypes {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Identification Type'
  key BPIdentificationType : String(6) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Identification Cat.'
  @sap.quickinfo : 'BP Identification Category'
  BPIdentificationCategory : String(6);
  @sap.label : 'ID Type for Persons'
  @sap.quickinfo : 'Indicator: ID Type Relevant for Persons'
  IsBPPerson : Boolean;
  @sap.label : 'ID Type f.Organizn'
  @sap.quickinfo : 'Indicator: ID Type Relevant for Organizations'
  IsBPOrganization : Boolean;
  @sap.label : 'ID Type for Groups'
  @sap.quickinfo : 'Indicator: ID Type Relevant for Groups'
  IsBPGroup : Boolean;
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Bank'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.Banks {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Business Partner'
  key BusinessPartner : String(10) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Bank Details ID'
  key BankIdentification : String(4) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Bank Country/Region'
  BankCountryKey : String(3);
  @sap.label : 'Bank Name'
  BankName : String(60);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Bank Key'
  BankNumber : String(15);
  @sap.display.format : 'UpperCase'
  @sap.label : 'SWIFT/BIC'
  SWIFTCode : String(11);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Grouping'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerGroupings {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerGrouping_Text'
  @sap.label : 'Grouping'
  key BusinessPartnerGrouping : String(4) not null;
  @sap.label : 'Grouping Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerGrouping_Text : String(40);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Legal Form'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.LegalForms {
  @sap.display.format : 'UpperCase'
  @sap.text : 'LegalForm_Text'
  @sap.label : 'Legal form'
  key LegalForm : String(2) not null;
  @sap.label : 'Short name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  LegalForm_Text : String(15);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Occupation'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.Occupations {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerOccupation_Text'
  @sap.label : 'Occupation'
  key BusinessPartnerOccupation : String(4) not null;
  @sap.label : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerOccupation_Text : String(70);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Print Format'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.PrintFormats {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerPrintFormat_Text'
  @sap.label : 'Print Format'
  key BusinessPartnerPrintFormat : String(1) not null;
  @sap.label : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerPrintFormat_Text : String(60);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Role'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerRoles {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerRole_Text'
  @sap.label : 'BP Role'
  key BusinessPartnerRole : String(6) not null;
  @sap.label : 'Role Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerRole_Text : String(25);
  @sap.display.format : 'UpperCase'
  @sap.label : 'BP Role Category'
  RoleCategory : String(6);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Types'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerTypes {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerType_Text'
  @sap.label : 'BP Type'
  key BusinessPartnerType : String(4) not null;
  @sap.label : 'Business Partner Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerType_Text : String(40);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'BP Address Dependent Tax Category'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.AddressDependentTaxTypes {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Tax Number Category'
  key BPTaxType : String(4) not null;
  @sap.label : 'Tax Category Description'
  BPTaxTypeName : String(40);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Birth Date status'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.BirthDateStatuses {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerBirthDateStatus_Text'
  @sap.label : 'Birth Date Status'
  key BusinessPartnerBirthDateStatus : String(10) not null;
  @sap.label : 'Short Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerBirthDateStatus_Text : String(60);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Category'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerCategories {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerCategory_Text'
  @sap.label : 'Category'
  key BusinessPartnerCategory : String(1) not null;
  @sap.label : 'Business Partner Category Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerCategory_Text : String(60);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Industry Code'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.IndustryCodes {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerIndustryCode_Text'
  @sap.label : 'Industry Code'
  key BusinessPartnerIndustryCode : String(10) not null;
  @sap.label : 'Industry Code Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerIndustryCode_Text : String(20);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Industry Key'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.IndustrySectors {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Industry System'
  key IndustrySystemType : String(4) not null;
  @sap.display.format : 'UpperCase'
  @sap.text : 'IndustrySector_Text'
  @sap.label : 'Industry'
  key IndustrySector : String(10) not null;
  @sap.label : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  IndustrySector_Text : String(100);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Industry System'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.IndustrySystems {
  @sap.display.format : 'UpperCase'
  @sap.text : 'IndustrySystemType_Text'
  @sap.label : 'Industry System'
  key IndustrySystemType : String(4) not null;
  @sap.label : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  IndustrySystemType_Text : String(30);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'BUPA Marital Status'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.MaritalStatuses {
  @sap.display.format : 'UpperCase'
  @sap.text : 'MaritalStatus_Text'
  @sap.label : 'Marital Status'
  key MaritalStatus : String(1) not null;
  @sap.label : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  MaritalStatus_Text : String(20);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Business Partner Tax Type - Text'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.TaxTypes {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Tax Number Category'
  key BPTaxType : String(4) not null;
  @sap.label : 'Tax Category Description'
  TaxTypeName : String(40);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Country/Region'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.Countries {
  @sap.display.format : 'UpperCase'
  @sap.text : 'Country_Text'
  @sap.label : 'Country/Region Key'
  key Country : String(3) not null;
  @sap.label : 'Country/Region Name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  Country_Text : String(50);
  @sap.display.format : 'UpperCase'
  @sap.label : 'ISO Code 3 Char'
  CountryThreeLetterISOCode : String(3);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Customer Account Group'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.CustomerAccountGroups {
  @sap.display.format : 'UpperCase'
  @sap.text : 'CustomerAccountGroup_Text'
  @sap.label : 'Account group'
  key CustomerAccountGroup : String(4) not null;
  @sap.label : 'Name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  CustomerAccountGroup_Text : String(30);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Customer Classification'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.CustomerClassifications {
  @sap.display.format : 'UpperCase'
  @sap.text : 'CustomerClassification_Text'
  @sap.label : 'Customer Classific.'
  key CustomerClassification : String(2) not null;
  @sap.label : 'Customer Classification Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  CustomerClassification_Text : String(20);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Form of Address'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.FormsOfAddress {
  @sap.display.format : 'UpperCase'
  @sap.text : 'FormOfAddress_Text'
  @sap.label : 'Title Key'
  key FormOfAddress : String(4) not null;
  @sap.label : 'Title Text'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  FormOfAddress_Text : String(30);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Language'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.Languages {
  @sap.text : 'Language_Text'
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.label : 'Name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  Language_Text : String(16);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Language Code'
  LanguageISOCode : String(2);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Region'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.Regions {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Country/Region Key'
  key Country : String(3) not null;
  @sap.display.format : 'UpperCase'
  @sap.text : 'Region_Text'
  @sap.label : 'Region'
  key Region : String(3) not null;
  @sap.label : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  Region_Text : String(20);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.label : 'Supplier Account Group'
@sap.content.version : '1'
entity ZSRVB_MDMLIGHT_VH.SupplierAccountGroups {
  @sap.display.format : 'UpperCase'
  @sap.text : 'SupplierAccountGroup_Text'
  @sap.label : 'Account group'
  key SupplierAccountGroup : String(4) not null;
  @sap.label : 'Name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  SupplierAccountGroup_Text : String(30);
};

