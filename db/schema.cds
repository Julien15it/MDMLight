namespace mdm.md.businesspartner;

using { cuid, managed, sap.common.CodeList } from '@sap/cds/common';

/**
 * Central Business Partner entity.
 * Field names mirror the SAP S/4HANA API_BUSINESS_PARTNER (A_BusinessPartner)
 * so the model stays familiar to the standard "Manage Business Partner" (F3163) app.
 */
entity BusinessPartners : cuid, managed {
  BusinessPartner          : String(10)  @title: 'Business Partner'      @Common.Label: 'Business Partner';
  BusinessPartnerFullName  : String(160) @title: 'Full Name';
  BusinessPartnerName      : String(81)  @title: 'Name';
  BusinessPartnerCategory  : Association to BusinessPartnerCategories    @title: 'Category';
  BusinessPartnerGrouping   : Association to BusinessPartnerGroupings     @title: 'Grouping';
  SearchTerm1              : String(20)  @title: 'Search Term';

  // Person (BusinessPartnerCategory = 1)
  FirstName                : String(40)  @title: 'First Name';
  LastName                 : String(40)  @title: 'Last Name';
  MiddleName               : String(40)  @title: 'Middle Name';
  CorrespondenceLanguage   : String(2)   @title: 'Language';
  Title                    : Association to AcademicTitles              @title: 'Title';

  // Organization (BusinessPartnerCategory = 2)
  OrganizationBPName1      : String(40)  @title: 'Organization Name 1';
  OrganizationBPName2      : String(40)  @title: 'Organization Name 2';
  OrganizationFoundationDate : Date       @title: 'Foundation Date';

  // Status
  IsBlocked                : Boolean      @title: 'Blocked'   default false;
  IsMarkedForArchiving     : Boolean      @title: 'Archiving' default false;

  // Compositions
  to_Addresses             : Composition of many Addresses
                               on to_Addresses.up_ = $self;
  to_Roles                 : Composition of many BusinessPartnerRoles
                               on to_Roles.up_ = $self;
  to_BankDetails           : Composition of many BankDetails
                               on to_BankDetails.up_ = $self;
}

/** Postal addresses of a business partner. */
entity Addresses : cuid {
  up_          : Association to BusinessPartners;
  AddressID    : String(10)  @title: 'Address ID';
  Country      : Association to Countries @title: 'Country';
  CityName     : String(40)  @title: 'City';
  PostalCode   : String(10)  @title: 'Postal Code';
  StreetName   : String(60)  @title: 'Street';
  HouseNumber  : String(10)  @title: 'House Number';
  Region       : String(3)   @title: 'Region';
  PhoneNumber  : String(30)  @title: 'Phone';
  EmailAddress : String(241) @title: 'E-Mail';
  IsDefaultAddress : Boolean  @title: 'Default' default false;
}

/** Roles a business partner can hold (e.g. Customer, Supplier, Contact). */
entity BusinessPartnerRoles : cuid {
  up_               : Association to BusinessPartners;
  BusinessPartnerRole : Association to Roles @title: 'Role';
  ValidFrom         : Date @title: 'Valid From';
  ValidTo           : Date @title: 'Valid To';
}

/** Bank details of a business partner. */
entity BankDetails : cuid {
  up_               : Association to BusinessPartners;
  BankIdentification : String(4)  @title: 'Bank ID';
  BankCountry       : Association to Countries @title: 'Bank Country';
  BankNumber        : String(15) @title: 'Bank Number';
  IBAN              : String(34) @title: 'IBAN';
  SWIFTCode         : String(11) @title: 'SWIFT / BIC';
  BankAccount       : String(18) @title: 'Account Number';
}

//
// --- Code lists / value helps ------------------------------------------------
//

entity BusinessPartnerCategories : CodeList {
  key code : String(1) @title: 'Category';   // 1 = Person, 2 = Organization, 3 = Group
}

entity BusinessPartnerGroupings : CodeList {
  key code : String(4) @title: 'Grouping';
}

entity Roles : CodeList {
  key code : String(6) @title: 'Role';        // e.g. FLCU00 (Customer), FLVN00 (Supplier)
}

entity AcademicTitles : CodeList {
  key code : String(4) @title: 'Title';
}

entity Countries : CodeList {
  key code : String(3) @title: 'Country';
}
