/* checksum : 2963dfeb13ad0d27f3d4c67d910ce87d */
@cds.external : true
@m.IsDefaultEntityContainer : 'true'
@sap.message.scope.supported : 'true'
@sap.supported.formats : 'atom json xlsx'
service ZSRVB_MDMLIGHT_VH {};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Academic Title'
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
@sap.content.version : '1'
@sap.label : 'Business Partner Gender Value help'
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
@sap.content.version : '1'
@sap.label : 'Trading Partner of Business Partner'
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
@sap.content.version : '1'
@sap.label : 'CDS View for BP Identification Types'
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
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Bank'
entity ZSRVB_MDMLIGHT_VH.Banks {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Business Partner'
  @sap.quickinfo : 'Business Partner Number'
  key BusinessPartner : String(10) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Bank Details ID'
  key BankIdentification : String(4) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Bank Country/Region'
  @sap.quickinfo : 'Bank Country/Region Key'
  BankCountryKey : String(3);
  @sap.label : 'Bank Name'
  @sap.quickinfo : 'Name of Financial Institution'
  BankName : String(60);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Bank Key'
  BankNumber : String(15);
  @sap.display.format : 'UpperCase'
  @sap.label : 'SWIFT/BIC'
  @sap.quickinfo : 'SWIFT/BIC for International Payments'
  SWIFTCode : String(11);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Bank Control Key'
  BankControlKey : String(2);
  @sap.label : 'Account Holder'
  @sap.quickinfo : 'Account Holder Name'
  BankAccountHolderName : String(60);
  @sap.label : 'Account Name'
  @sap.quickinfo : 'Name of Bank Account'
  BankAccountName : String(40);
  @odata.Type : 'Edm.DateTimeOffset'
  @sap.label : 'Valid From'
  @sap.quickinfo : 'Validity Start of Business Partner Bank Details'
  ValidityStartDate : DateTime;
  @odata.Type : 'Edm.DateTimeOffset'
  @sap.label : 'Valid To'
  @sap.quickinfo : 'Validity End of Business Partner Bank Details'
  ValidityEndDate : DateTime;
  @sap.label : 'TRUE'
  @sap.quickinfo : 'Data element for domain BOOLE: TRUE (=''X'') and FALSE (='' '')'
  IsActualDate : Boolean;
  @sap.label : 'TRUE'
  @sap.quickinfo : 'Data element for domain BOOLE: TRUE (=''X'') and FALSE (='' '')'
  BPIsActualDate : Boolean;
  @sap.display.format : 'UpperCase'
  @sap.label : 'IBAN'
  @sap.quickinfo : 'IBAN (International Bank Account Number)'
  IBAN : String(34);
  @sap.display.format : 'Date'
  @sap.label : 'IBAN Valid From'
  @sap.quickinfo : 'Validity Start of IBAN'
  IBANValidityStartDate : Date;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Bank acct'
  @sap.quickinfo : 'Bank Account Number'
  BankAccount : String(18);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Reference Details'
  @sap.quickinfo : 'Reference Details for Bank Details'
  BankAccountReferenceText : String(20);
  @sap.label : 'Collect.author.'
  @sap.quickinfo : 'Indicator: Collection Authorization'
  CollectionAuthInd : Boolean;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Extern.bank dtls ID'
  @sap.quickinfo : 'Bank details ID in external system'
  BusinessPartnerExternalBankID : String(20);
  @odata.Type : 'Edm.DateTimeOffset'
  @sap.label : 'Date of Change'
  @sap.quickinfo : 'Date of Change to Bank Details (BP)'
  BPBankDetailsChangeDate : DateTime;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Target Bank Details'
  @sap.quickinfo : 'ID of Target Details for Change of Bank Details (BP)'
  BPBankDetailsChangeTargetID : String(4);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Sensitivity'
  @sap.quickinfo : 'BP: Sensitivity Indicator'
  BPBankIsProtected : String(1);
  @sap.label : 'BP Bank GUID'
  @sap.quickinfo : 'BP: Bank Account Alias GUID'
  BPBankUUID : UUID;
  @sap.label : 'City'
  CityName : String(35);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Authorization Group'
  AuthorizationGroup : String(4);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Grouping'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerGroupings {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerGrouping_Text'
  @sap.label : 'Grouping'
  @sap.quickinfo : 'Business Partner Grouping'
  key BusinessPartnerGrouping : String(4) not null;
  @sap.label : 'Grouping Description'
  @sap.quickinfo : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerGrouping_Text : String(40);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.BusinessPartnerGroupingTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Grouping - Text'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerGroupingTexts {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Grouping'
  @sap.quickinfo : 'Business Partner Grouping'
  key BusinessPartnerGrouping : String(4) not null;
  @sap.label : 'Grouping Description'
  @sap.quickinfo : 'Description'
  BusinessPartnerGroupingText : String(40);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Business Partner Legal Form'
entity ZSRVB_MDMLIGHT_VH.LegalForms {
  @sap.display.format : 'UpperCase'
  @sap.text : 'LegalForm_Text'
  @sap.label : 'Legal form'
  @sap.quickinfo : 'BP: Legal form of organization'
  key LegalForm : String(2) not null;
  @sap.label : 'Short name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  LegalForm_Text : String(15);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.LegalFormTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Legal Form - Text'
entity ZSRVB_MDMLIGHT_VH.LegalFormTexts {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Legal form'
  @sap.quickinfo : 'BP: Legal form of organization'
  key LegalForm : String(2) not null;
  @sap.label : 'Short name'
  LegalFormShortName : String(15);
  @sap.label : 'Description'
  LegalFormDescription : String(40);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Business Partner Occupation'
entity ZSRVB_MDMLIGHT_VH.Occupations {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerOccupation_Text'
  @sap.label : 'Occupation'
  @sap.quickinfo : 'Occupation/group'
  key BusinessPartnerOccupation : String(4) not null;
  @sap.label : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerOccupation_Text : String(70);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.OccupationTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Print Format'
entity ZSRVB_MDMLIGHT_VH.PrintFormats {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerPrintFormat_Text'
  @sap.label : 'Print Format'
  @sap.quickinfo : 'Business Partner Print Format'
  key BusinessPartnerPrintFormat : String(1) not null;
  @sap.label : 'Description'
  @sap.quickinfo : 'Short Text for Fixed Values'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerPrintFormat_Text : String(60);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.PrintFormatTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Category - Text'
entity ZSRVB_MDMLIGHT_VH.PrintFormatTexts {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Print Format'
  @sap.quickinfo : 'Business Partner Print Format'
  key BusinessPartnerPrintFormat : String(1) not null;
  @sap.label : 'Lang.'
  @sap.quickinfo : 'Language Key'
  key Language : String(2) not null;
  @sap.label : 'Description'
  @sap.quickinfo : 'Short Text for Fixed Values'
  BusinessPartnerPrintFormatText : String(60);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Role'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerRoles {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerRole_Text'
  @sap.label : 'BP Role'
  key BusinessPartnerRole : String(6) not null;
  @sap.label : 'Role Description'
  @sap.quickinfo : 'BP Role Title'
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
@sap.content.version : '1'
@sap.label : 'Business Partner Types'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerTypes {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerType_Text'
  @sap.label : 'BP Type'
  @sap.quickinfo : 'Business Partner Type'
  key BusinessPartnerType : String(4) not null;
  @sap.label : 'Business Partner Description'
  @sap.quickinfo : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerType_Text : String(40);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.BusinessPartnerTypeTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Business Partner Type - Text'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerTypeTexts {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'BP Type'
  @sap.quickinfo : 'Business Partner Type'
  key BusinessPartnerType : String(4) not null;
  @sap.label : 'Business Partner Description'
  @sap.quickinfo : 'Description'
  BusinessPartnerTypeDesc : String(40);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'BP Address Dependent Tax Category'
entity ZSRVB_MDMLIGHT_VH.AddressDependentTaxTypes {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Tax Number Category'
  key BPTaxType : String(4) not null;
  @sap.label : 'Tax Category Description'
  @sap.quickinfo : 'Name: Business Partner Tax Number Categories'
  BPTaxTypeName : String(40);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Birth Date status'
entity ZSRVB_MDMLIGHT_VH.BirthDateStatuses {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerBirthDateStatus_Text'
  @sap.label : 'Birth Date Status'
  @sap.quickinfo : 'Values for Domains: Single Value/Lower Limit'
  key BusinessPartnerBirthDateStatus : String(10) not null;
  @sap.label : 'Short Description'
  @sap.quickinfo : 'Short Text for Fixed Values'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerBirthDateStatus_Text : String(60);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.BirthDateStatusTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Birth Date Status - Text'
entity ZSRVB_MDMLIGHT_VH.BirthDateStatusTexts {
  @sap.label : 'Lang.'
  @sap.quickinfo : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Lower Value'
  @sap.quickinfo : 'Values for Domains: Single Value/Lower Limit'
  key BusinessPartnerBirthDateStatus : String(10) not null;
  @sap.label : 'Short Description'
  @sap.quickinfo : 'Short Text for Fixed Values'
  BusPartBirthDateStatusText : String(60);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Category'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerCategories {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerCategory_Text'
  @sap.label : 'Category'
  @sap.quickinfo : 'Business Partner Category'
  key BusinessPartnerCategory : String(1) not null;
  @sap.label : 'Business Partner Category Description'
  @sap.quickinfo : 'Short Text for Fixed Values'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerCategory_Text : String(60);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.BusinessPartnerCategoryTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Category - Text'
entity ZSRVB_MDMLIGHT_VH.BusinessPartnerCategoryTexts {
  @sap.display.format : 'UpperCase'
  @sap.text : 'to_CategoryValueHelp/BusinessPartnerCategory_Text'
  @sap.label : 'BP Category'
  @sap.quickinfo : 'Business Partner Category'
  @sap.value.list : 'fixed-values'
  key BusinessPartnerCategory : String(1) not null;
  @sap.label : 'Lang.'
  @sap.quickinfo : 'Language Key'
  key Language : String(2) not null;
  @sap.label : 'Business Partner Category Description'
  @sap.quickinfo : 'Short Text for Fixed Values'
  BusinessPartnerCategoryText : String(60);
  to_CategoryValueHelp : Association to ZSRVB_MDMLIGHT_VH.BusinessPartnerCategories {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Business Partner Industry Code'
entity ZSRVB_MDMLIGHT_VH.IndustryCodes {
  @sap.display.format : 'UpperCase'
  @sap.text : 'BusinessPartnerIndustryCode_Text'
  @sap.label : 'Industry Code'
  @sap.quickinfo : 'Industry code'
  key BusinessPartnerIndustryCode : String(10) not null;
  @sap.label : 'Industry Code Description'
  @sap.quickinfo : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  BusinessPartnerIndustryCode_Text : String(20);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.IndustryCodeTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'BusPartIndustryCode - Text'
entity ZSRVB_MDMLIGHT_VH.IndustryCodeTexts {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Industry code'
  key BusinessPartnerIndustryCode : String(10) not null;
  @sap.label : 'Industry Code Description'
  @sap.quickinfo : 'Description'
  CustomerIndustryCodeText : String(20);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Business Partner Industry Key'
entity ZSRVB_MDMLIGHT_VH.IndustrySectors {
  @sap.display.format : 'UpperCase'
  @sap.text : 'to_BusPartIndustrySystem/IndustrySystemType_Text'
  @sap.label : 'Industry System'
  @sap.value.list : 'standard'
  key IndustrySystemType : String(4) not null;
  @sap.display.format : 'UpperCase'
  @sap.text : 'IndustrySector_Text'
  @sap.label : 'Industry'
  key IndustrySector : String(10) not null;
  @sap.label : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  IndustrySector_Text : String(100);
  to_BusPartIndustrySystem : Association to ZSRVB_MDMLIGHT_VH.IndustrySystems {  };
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.IndustrySectorTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Business Partner Industry Key Text'
entity ZSRVB_MDMLIGHT_VH.IndustrySectorTexts {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Industry System'
  @sap.value.list : 'standard'
  key IndustrySystemType : String(4) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Industry'
  key IndustrySector : String(10) not null;
  @sap.label : 'Description'
  IndustryKeyDescription : String(100);
  to_BusPartIndustryKey : Association to ZSRVB_MDMLIGHT_VH.IndustrySectors {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Business Partner Industry System'
entity ZSRVB_MDMLIGHT_VH.IndustrySystems {
  @sap.display.format : 'UpperCase'
  @sap.text : 'IndustrySystemType_Text'
  @sap.label : 'Industry System'
  key IndustrySystemType : String(4) not null;
  @sap.label : 'Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  IndustrySystemType_Text : String(30);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.IndustrySystemTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Industry System - Text'
entity ZSRVB_MDMLIGHT_VH.IndustrySystemTexts {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Industry System'
  key IndustrySystemType : String(4) not null;
  @sap.label : 'Description'
  IndustrySystemName : String(30);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'BUPA Marital Status'
entity ZSRVB_MDMLIGHT_VH.MaritalStatuses {
  @sap.display.format : 'UpperCase'
  @sap.text : 'MaritalStatus_Text'
  @sap.label : 'Marital Status'
  @sap.quickinfo : 'Marital Status of Business Partner'
  key MaritalStatus : String(1) not null;
  @sap.label : 'Description'
  @sap.quickinfo : 'Short name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  MaritalStatus_Text : String(20);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.MaritalStatusTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'BUPA Marital Status - Text'
entity ZSRVB_MDMLIGHT_VH.MaritalStatusTexts {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Marital Status'
  @sap.quickinfo : 'Marital Status of Business Partner'
  key MaritalStatus : String(1) not null;
  @sap.label : 'Description'
  @sap.quickinfo : 'Short name'
  MaritalStatusName : String(20);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Business Partner Occupation - Text'
entity ZSRVB_MDMLIGHT_VH.OccupationTexts {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Occupation'
  @sap.quickinfo : 'Occupation/group'
  key BusinessPartnerOccupation : String(4) not null;
  @sap.label : 'Description'
  OccupationDescription : String(70);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Business Partner Tax Type - Text'
entity ZSRVB_MDMLIGHT_VH.TaxTypes {
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Tax Number Category'
  key BPTaxType : String(4) not null;
  @sap.label : 'Tax Category Description'
  @sap.quickinfo : 'Name: Business Partner Tax Number Categories'
  TaxTypeName : String(40);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Country/Region'
entity ZSRVB_MDMLIGHT_VH.Countries {
  @sap.display.format : 'UpperCase'
  @sap.text : 'Country_Text'
  @sap.label : 'Country/Region Key'
  key Country : String(3) not null;
  @sap.label : 'Country/Region Name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  Country_Text : String(50);
  @sap.label : 'Country/Region Name'
  Description : String(50);
  @sap.display.format : 'UpperCase'
  @sap.label : 'ISO Code 3 Char'
  @sap.quickinfo : 'ISO Country/Region Code 3 Characters'
  CountryThreeLetterISOCode : String(3);
  @sap.display.format : 'NonNegative'
  @sap.label : 'ISO Code Num. 3'
  @sap.quickinfo : 'ISO Country/Region Code Numeric 3-Characters'
  CountryThreeDigitISOCode : String(3);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Customer Account Group'
entity ZSRVB_MDMLIGHT_VH.CustomerAccountGroups {
  @sap.display.format : 'UpperCase'
  @sap.text : 'CustomerAccountGroup_Text'
  @sap.label : 'Account group'
  @sap.quickinfo : 'Customer Account Group'
  key CustomerAccountGroup : String(4) not null;
  @sap.label : 'Name'
  @sap.quickinfo : 'Account Group Name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  CustomerAccountGroup_Text : String(30);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Customer Classification'
entity ZSRVB_MDMLIGHT_VH.CustomerClassifications {
  @sap.display.format : 'UpperCase'
  @sap.text : 'CustomerClassification_Text'
  @sap.label : 'Customer Classific.'
  @sap.quickinfo : 'Customer Classification'
  key CustomerClassification : String(2) not null;
  @sap.label : 'Customer Classification Description'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  CustomerClassification_Text : String(20);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.CustomerClassificationTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Customer Classification - Text'
entity ZSRVB_MDMLIGHT_VH.CustomerClassificationTexts {
  @sap.display.format : 'UpperCase'
  @sap.text : 'to_CustomerClassification/CustomerClassification_Text'
  @sap.label : 'Customer Classific.'
  @sap.quickinfo : 'Customer Classification'
  @sap.value.list : 'standard'
  key CustomerClassification : String(2) not null;
  @sap.text : 'to_Language/Language_Text'
  @sap.label : 'Language Key'
  @sap.value.list : 'standard'
  key Language : String(2) not null;
  @sap.label : 'Customer Classification Description'
  CustomerClassificationDesc : String(20);
  to_CustomerClassification : Association to ZSRVB_MDMLIGHT_VH.CustomerClassifications {  };
  to_Language : Association to ZSRVB_MDMLIGHT_VH.Languages {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Form of Address'
entity ZSRVB_MDMLIGHT_VH.FormsOfAddress {
  @sap.display.format : 'UpperCase'
  @sap.text : 'FormOfAddress_Text'
  @sap.label : 'Title Key'
  @sap.quickinfo : 'Form-of-Address Key'
  key FormOfAddress : String(4) not null;
  @sap.label : 'Title Text'
  @sap.quickinfo : 'Title text'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  FormOfAddress_Text : String(30);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.FormOfAddressTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Form Of Address - Text'
entity ZSRVB_MDMLIGHT_VH.FormOfAddressTexts {
  @sap.text : 'to_Language/Language_Text'
  @sap.label : 'Language Key'
  @sap.value.list : 'standard'
  key Language : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.text : 'to_FormOfAddress/FormOfAddress_Text'
  @sap.label : 'Title Key'
  @sap.quickinfo : 'Form-of-Address Key'
  @sap.value.list : 'standard'
  key FormOfAddress : String(4) not null;
  @sap.label : 'Title Text'
  @sap.quickinfo : 'Title text'
  FormOfAddressName : String(30);
  to_FormOfAddress : Association to ZSRVB_MDMLIGHT_VH.FormsOfAddress {  };
  to_Language : Association to ZSRVB_MDMLIGHT_VH.Languages {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Language'
entity ZSRVB_MDMLIGHT_VH.Languages {
  @sap.text : 'Language_Text'
  @sap.label : 'Language Key'
  key Language : String(2) not null;
  @sap.label : 'Name'
  @sap.quickinfo : 'Name of Language'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  Language_Text : String(16);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Language Code'
  @sap.quickinfo : '2-Character SAP Language Code'
  LanguageISOCode : String(2);
  to_Text : Association to many ZSRVB_MDMLIGHT_VH.LanguageTexts {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Language Text'
entity ZSRVB_MDMLIGHT_VH.LanguageTexts {
  @sap.text : 'to_Language/Language_Text'
  @sap.label : 'Language Key'
  @sap.value.list : 'standard'
  key Language : String(2) not null;
  @sap.text : 'to_LanguageCode/Language_Text'
  @sap.label : 'Language Key'
  @sap.value.list : 'standard'
  key LanguageCode : String(2) not null;
  @sap.label : 'Name'
  @sap.quickinfo : 'Name of Language'
  LanguageName : String(16);
  to_Language : Association to ZSRVB_MDMLIGHT_VH.Languages {  };
  to_LanguageCode : Association to ZSRVB_MDMLIGHT_VH.Languages {  };
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Region'
entity ZSRVB_MDMLIGHT_VH.Regions {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Country/Region Key'
  key Country : String(3) not null;
  @sap.display.format : 'UpperCase'
  @sap.text : 'Region_Text'
  @sap.label : 'Region'
  @sap.quickinfo : 'Region (State, Province, County)'
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
@sap.searchable : 'true'
@sap.content.version : '1'
@sap.label : 'Supplier Account Group'
entity ZSRVB_MDMLIGHT_VH.SupplierAccountGroups {
  @sap.display.format : 'UpperCase'
  @sap.text : 'SupplierAccountGroup_Text'
  @sap.label : 'Account group'
  @sap.quickinfo : 'Vendor account group'
  key SupplierAccountGroup : String(4) not null;
  @sap.label : 'Name'
  @sap.quickinfo : 'Account Group Name'
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  SupplierAccountGroup_Text : String(30);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'CVI Check: BP Role to Role Category'
entity ZSRVB_MDMLIGHT_VH.CviBusinessPartnerRoles {
  @sap.display.format : 'UpperCase'
  @sap.label : 'BP Role'
  key BPRole : String(6) not null;
  @sap.label : 'Description'
  @sap.quickinfo : 'BP Role Description'
  BPRoleName : String(50);
  @sap.display.format : 'UpperCase'
  @sap.label : 'BP Role Category'
  BPRoleCategory : String(6);
  @sap.label : 'Std Assignment BP Role -> BP Role Cat.'
  @sap.quickinfo : 'Indic.:Standard Assignment BP Role -> BP Role Category'
  IsStandardRoleForCategory : Boolean;
  @sap.display.format : 'UpperCase'
  @sap.label : 'BP View'
  BPView : String(6);
  @sap.label : 'Hide BP Role'
  @sap.quickinfo : 'Indicator: Hide Business Partner Role in Dialog'
  IsHidden : Boolean;
  @sap.display.format : 'NonNegative'
  @sap.label : 'Position'
  @sap.quickinfo : 'Position of Business Partner Role'
  RolePosition : String(3);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'CVI Check: Contact Person Mapping Active'
entity ZSRVB_MDMLIGHT_VH.CviContactMapping {
  @sap.label : 'Cntct Person Active'
  @sap.quickinfo : 'Activate Assignment of Contact Person'
  key IsContactPersonMappingActive : Boolean not null;
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'CVI Check: BP and Cust/Supp Number Ranges'
entity ZSRVB_MDMLIGHT_VH.CviNumberRanges {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Object name'
  @sap.quickinfo : 'Number Range Object'
  key NumberRangeObject : String(10) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Subobject value'
  @sap.quickinfo : 'Number range object subobject value'
  key NumberRangeSubobject : String(6) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Number range number'
  key NumberRangeNumber : String(2) not null;
  @sap.display.format : 'NonNegative'
  @sap.label : 'To year'
  @sap.quickinfo : 'To fiscal year'
  key ToFiscalYear : String(4) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'From number'
  FromNumber : String(20);
  @sap.display.format : 'UpperCase'
  @sap.label : 'To number'
  ToNumber : String(20);
  @sap.label : 'External'
  @sap.quickinfo : 'Internal ('' '') or external (''X'') number range flag'
  IsExternalNumberRange : Boolean;
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'CVI Check: BP/Customer Number Assignment'
entity ZSRVB_MDMLIGHT_VH.CviCustomerNumberAssignments {
  key SyncDirection : String(14) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Grouping'
  @sap.quickinfo : 'Business Partner Grouping'
  key BPGrouping : String(4) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Account group'
  @sap.quickinfo : 'Customer Account Group'
  key CustomerAccountGroup : String(4) not null;
  @sap.label : 'Same Numbers'
  @sap.quickinfo : 'Same Number When Creating Customer/Vendor from a BP'
  HasSameNumber : Boolean;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Number range'
  @sap.quickinfo : 'BP Number Range'
  BPNumberRange : String(2);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Number Range'
  CustomerNumberRange : String(2);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'CVI Check: BP/Supplier Number Assignment'
entity ZSRVB_MDMLIGHT_VH.CviSupplierNumberAssignments {
  key SyncDirection : String(12) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Grouping'
  @sap.quickinfo : 'Business Partner Grouping'
  key BPGrouping : String(4) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Account group'
  @sap.quickinfo : 'Vendor account group'
  key SupplierAccountGroup : String(4) not null;
  @sap.label : 'Same Numbers'
  @sap.quickinfo : 'Create Vendor with Same Number'
  HasSameNumber : Boolean;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Number range'
  @sap.quickinfo : 'BP Number Range'
  BPNumberRange : String(2);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Number Range'
  SupplierNumberRange : String(2);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'CVI Check: Postprocessing Office Control'
entity ZSRVB_MDMLIGHT_VH.CviPostprocessingControl {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Syn.Object'
  @sap.quickinfo : 'Synchronization Object'
  key SynchronizationObject : String(10) not null;
  @sap.label : 'PPO Active'
  @sap.quickinfo : 'Indicator Post-Processing Active'
  IsPostprocessingActive : Boolean;
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'CVI Check: BP Role Category Settings'
entity ZSRVB_MDMLIGHT_VH.CviRoleCategories {
  @sap.display.format : 'UpperCase'
  @sap.label : 'BP Role Category'
  key BPRoleCategory : String(6) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Differentiation Type'
  DifferentiationType : String(2);
  @sap.label : 'Person'
  @sap.quickinfo : 'Partner Category ''Natural Person'' Is Relevant'
  IsAllowedForPerson : Boolean;
  @sap.label : 'Organization'
  @sap.quickinfo : 'Partner Category ''Organization'' Is Relevant'
  IsAllowedForOrganization : Boolean;
  @sap.label : 'Group'
  @sap.quickinfo : 'Partner Category ''Group'' Is Relevant'
  IsAllowedForGroup : Boolean;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Business Object'
  @sap.quickinfo : 'ESF: Business Object'
  BusinessObjectName : String(30);
  @sap.label : 'Mandatory'
  @sap.quickinfo : 'BP Role Category is Mandatory for Customer'
  CreatesCustomerMandatory : Boolean;
  @sap.label : 'Optional'
  @sap.quickinfo : 'BP Role Category is Optional for Customer'
  CreatesCustomerOptional : Boolean;
  @sap.label : 'Mandatory'
  @sap.quickinfo : 'BP Role Category is Mandatory for Vendor'
  CreatesSupplierMandatory : Boolean;
  @sap.label : 'Optional'
  @sap.quickinfo : 'BP Role Category is Optional for Vendor'
  CreatesSupplierOptional : Boolean;
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'CVI Check: Active Sync Directions'
entity ZSRVB_MDMLIGHT_VH.CviSyncDirections {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Source Object'
  @sap.quickinfo : 'Source Synchronization Object'
  key SourceObject : String(10) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Target Object'
  @sap.quickinfo : 'Target Synchronization Object'
  key TargetObject : String(10) not null;
  @sap.label : 'Active Indicator'
  @sap.quickinfo : 'Active Indicator for Synchronization Options'
  IsActive : Boolean;
};


/* --------------------------------------------------------------------------
 * The five Der* entities below were transcribed BY HAND from the served
 * $metadata on 2026-08-27, because `npm run import:valuehelp` could not be
 * run against this landscape. They were added to ZSRVB_MDMLIGHT_VH.edmx too, so
 * the two copies agree; only the `checksum` above is now stale, and nothing
 * verifies it. Types and annotations are verbatim from $metadata, so what is
 * here is what the service actually serves. A real `cds import` supersedes it.
 * -------------------------------------------------------------------------- */

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Derivation: address defaults per country'
entity ZSRVB_MDMLIGHT_VH.DerAddressDefaults {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Country/Region Key'
  key Country : String(3) not null;
  @sap.label : 'Language Key'
  AddressLanguage : String(2);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Standard name format'
  NameFormat : String(2);
  @sap.label : 'City file active'
  @sap.quickinfo : 'Flag: City file address check'
  CityFileActive : Boolean;
  @sap.label : 'Print C/R Name'
  @sap.quickinfo : 'Indicator: Print Country/Region for Addresses of Other C/R'
  PrintCountryName : Boolean;
  @sap.display.format : 'NonNegative'
  @sap.label : 'Postal code'
  @sap.quickinfo : 'Postal code length'
  PostalCodeLength : String(2);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Check rule for postal code'
  @sap.quickinfo : 'Rule for the postal code field check'
  PostalCodeCheckRule : String(1);
  @sap.label : 'EU Member'
  @sap.quickinfo : 'Indicator: European Union Member?'
  IsEuCountry : Boolean;
  @sap.display.format : 'UpperCase'
  @sap.label : 'ISO Code'
  @sap.quickinfo : 'ISO Code of the Country/Region'
  IsoCode : String(2);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Derivation: time zone per country and region'
entity ZSRVB_MDMLIGHT_VH.DerTimeZones {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Country/Region Key'
  key Country : String(3) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Region'
  @sap.quickinfo : 'Region (State, Province, County)'
  key Region : String(3) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Time Zone'
  key AddressTimeZone : String(6) not null;
  @sap.label : 'Default Time Zone'
  @sap.quickinfo : 'Indicator for Default Time Zone'
  IsDefault : Boolean;
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Derivation: valid tax categories per country'
entity ZSRVB_MDMLIGHT_VH.DerTaxCategories {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Tax country/region'
  @sap.quickinfo : 'Country/Region is relevant for taxes'
  key Country : String(3) not null;
  @sap.display.format : 'NonNegative'
  @sap.label : 'Tax sequence'
  @sap.quickinfo : 'Sequence of possible taxes for each country/region'
  key SequenceNumber : String(1) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Tax Condition Type'
  @sap.quickinfo : 'Tax Condition Type (Sales Tax, Value-Added Tax,...)'
  TaxCategory : String(4);
  @sap.label : '% rate from T007'
  @sap.quickinfo : 'Tax percentage rate from Table T007'
  RateFromTableT007 : Boolean;
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Derivation: partner functions valid per account group'
entity ZSRVB_MDMLIGHT_VH.DerPartnerFunctions {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Account group'
  @sap.quickinfo : 'Customer Account Group'
  key AccountGroup : String(4) not null;
  key PartnerFunction : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Partner Type'
  @sap.quickinfo : 'Type of partner number'
  PartnerType : String(2);
  HigherLevelFunction : String(2);
  @sap.label : 'Unique in the master'
  @sap.quickinfo : 'Uniqueness in the master data'
  IsUniqueInMasterData : Boolean;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Cust.hierarchy type'
  @sap.quickinfo : 'Customer hierarchy type'
  HierarchyType : String(1);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Derivation: mandatory partner functions per procedure'
entity ZSRVB_MDMLIGHT_VH.DerPartnerFunctionProcedures {
  @sap.display.format : 'UpperCase'
  @sap.label : 'PartnerDetermProced.'
  @sap.quickinfo : 'Partner Determination Procedure'
  key DeterminationProcedure : String(4) not null;
  key PartnerFunction : String(2) not null;
  @sap.label : 'Partner mandatory'
  @sap.quickinfo : 'Partner is mandatory'
  IsMandatory : Boolean;
  @sap.label : 'No change possible'
  @sap.quickinfo : 'After entry,partner can no longer be changed in the document'
  NoChangeAllowed : Boolean;
  @sap.label : 'Unique'
  @sap.quickinfo : 'Partner must be unique'
  IsUnique : Boolean;
  @sap.display.format : 'NonNegative'
  @sap.label : 'Sequence'
  @sap.quickinfo : 'Sequence in which partners are determined in the sales doc.'
  SortOrder : String(2);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Partner Type'
  @sap.quickinfo : 'Type of partner number'
  PartnerType : String(2);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Derivation: partner functions per account group'
entity ZSRVB_MDMLIGHT_VH.DerPartnerFunctionAccGrp {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Account group'
  @sap.quickinfo : 'Customer Account Group'
  key AccountGroup : String(4) not null;
  key PartnerFunction : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'PartnerDetermProced.'
  @sap.quickinfo : 'Partner Determination Procedure'
  DeterminationProcedure : String(4);
  @sap.label : 'Partner mandatory'
  @sap.quickinfo : 'Partner is mandatory'
  IsMandatory : Boolean;
  @sap.display.format : 'NonNegative'
  @sap.label : 'Sequence'
  @sap.quickinfo : 'Sequence in which partners are determined in the sales doc.'
  SortOrder : String(2);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Partner Type'
  @sap.quickinfo : 'Type of partner number'
  PartnerType : String(2);
};

@cds.external : true
@cds.persistence.skip : true
@sap.creatable : 'false'
@sap.updatable : 'false'
@sap.deletable : 'false'
@sap.content.version : '1'
@sap.label : 'Derivation: supplier partner functions per account group'
entity ZSRVB_MDMLIGHT_VH.DerSupplierFunctionAccGrp {
  @sap.display.format : 'UpperCase'
  @sap.label : 'Account group'
  @sap.quickinfo : 'Vendor account group'
  key AccountGroup : String(4) not null;
  key PartnerFunction : String(2) not null;
  @sap.display.format : 'UpperCase'
  @sap.label : 'Part. schema'
  @sap.quickinfo : 'Partner schema: purchasing organization level'
  PurchasingOrgProcedure : String(4);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Part. schema'
  @sap.quickinfo : 'Partner schema, sub-range'
  SecondLevelProcedure : String(4);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Part. schema'
  @sap.quickinfo : 'Partner schema: plant level'
  ThirdLevelProcedure : String(4);
  @sap.label : 'Partner mandatory'
  @sap.quickinfo : 'Partner is mandatory'
  IsMandatory : Boolean;
  @sap.display.format : 'NonNegative'
  @sap.label : 'Sequence'
  @sap.quickinfo : 'Sequence in which partners are determined in the sales doc.'
  SortOrder : String(2);
  @sap.display.format : 'UpperCase'
  @sap.label : 'Partner Type'
  @sap.quickinfo : 'Type of partner number'
  PartnerType : String(2);
};
