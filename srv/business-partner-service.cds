using { API_BUSINESS_PARTNER as S4 } from './external/API_BUSINESS_PARTNER';

type BusinessPartnerAssistantAnswer {
  Answer          : LargeString;
  Provider        : String(40);
  SuggestedAction : String(40);
  SuggestedData   : LargeString;
}

/**
 * OData V4 facade for the complete S/4HANA Business Partner (A2X) API.
 * Data is never persisted in CAP; requests are delegated live to S/4HANA.
 */
service BusinessPartnerService @(path: '/service/businesspartner') {

  @cds.search: {
    BusinessPartner,
    BusinessPartnerFullName,
    BusinessPartnerName,
    SearchTerm1,
    SearchTerm2,
    FirstName,
    LastName,
    OrganizationBPName1
  }
  @Capabilities: {
    SearchRestrictions: { Searchable: true },
    InsertRestrictions: { Insertable: true },
    UpdateRestrictions: { Updatable: true },
    DeleteRestrictions: { Deletable: false }
  }
  entity BusinessPartners as projection on S4.A_BusinessPartner;

  /** Explicit maintenance operations used by the non-draft Fiori UI. */
  action createBusinessPartner(
    BusinessPartnerCategory  : String(1) not null,
    BusinessPartnerGrouping  : String(4) not null,
    FirstName                 : String(40),
    LastName                  : String(40),
    OrganizationBPName1       : String(40),
    GroupBusinessPartnerName1 : String(40),
    SearchTerm1               : String(20)
  ) returns BusinessPartners;

  action updateBusinessPartner(
    BusinessPartner           : String(10) not null,
    FirstName                  : String(40),
    LastName                   : String(40),
    OrganizationBPName1        : String(40),
    OrganizationBPName2        : String(40),
    GroupBusinessPartnerName1  : String(40),
    GroupBusinessPartnerName2  : String(40),
    SearchTerm1                : String(20),
    SearchTerm2                : String(20),
    CorrespondenceLanguage     : String(2),
    BusinessPartnerIsBlocked   : Boolean
  ) returns BusinessPartners;

  /** Full-screen maintenance operations. JSON keeps the contract aligned with
   *  the complete S/4 metadata without exposing unrestricted entity names. */
  action saveBusinessPartner(
    BusinessPartner : String(10),
    IsCreate        : Boolean not null,
    DataJson        : LargeString not null
  ) returns BusinessPartners;

  action saveBusinessPartnerEntity(
    Entity  : String(40) not null,
    IsCreate: Boolean not null,
    KeyJson : LargeString,
    DataJson: LargeString not null
  ) returns LargeString;

  /** Read-only assistant grounded in the Business Partners currently present
   *  in S/4HANA. It never creates or changes master data. */
  action askBusinessPartnerAssistant(
    Question : String(1000) not null
  ) returns BusinessPartnerAssistantAnswer;

  // Core business-partner details shown as sections on the object page.
  @readonly entity Addresses            as projection on S4.A_BusinessPartnerAddress;
  @readonly entity BusinessPartnerRoles as projection on S4.A_BusinessPartnerRole;
  @readonly entity BankDetails          as projection on S4.A_BusinessPartnerBank;
  @readonly entity TaxNumbers           as projection on S4.A_BusinessPartnerTaxNumber;
  @readonly entity Identifications      as projection on S4.A_BuPaIdentification;
  @readonly entity Industries           as projection on S4.A_BuPaIndustry;
  // VF S/4HANA does not expose BR_ICMSTaxPayerType. Excluding it keeps the
  // facade compatible while retaining all other customer fields.
  @readonly entity Customers            as projection on S4.A_Customer excluding {
    BR_ICMSTaxPayerType
  };
  // These fields exist in newer API metadata but not in the VF on-premise
  // implementation. Excluding them prevents section reads from failing with
  // "Resource not found for the segment" while retaining all supported data.
  @readonly entity Suppliers            as projection on S4.A_Supplier excluding {
    BusinessPartnerPanNumber,
    JP_SuplrAmtInCapitalAmount,
    JP_SupplierCapitalAmountCrcy
  };

  // Remaining API_BUSINESS_PARTNER entity sets. They are exposed read-only so
  // consumers can use the complete S/4 API without risking accidental writes.
  @readonly entity A_AddressEmailAddress                 as projection on S4.A_AddressEmailAddress;
  @readonly entity A_AddressFaxNumber                    as projection on S4.A_AddressFaxNumber;
  @readonly entity A_AddressHomePageURL                  as projection on S4.A_AddressHomePageURL;
  @readonly entity A_AddressPhoneNumber                  as projection on S4.A_AddressPhoneNumber;
  @readonly entity A_BPAddrDepdntIntlLocNumber           as projection on S4.A_BPAddrDepdntIntlLocNumber;
  @readonly entity A_BPAddressIndependentEmail           as projection on S4.A_BPAddressIndependentEmail;
  @readonly entity A_BPAddressIndependentFax             as projection on S4.A_BPAddressIndependentFax;
  @readonly entity A_BPAddressIndependentMobile          as projection on S4.A_BPAddressIndependentMobile;
  @readonly entity A_BPAddressIndependentPhone           as projection on S4.A_BPAddressIndependentPhone;
  @readonly entity A_BPAddressIndependentWebsite         as projection on S4.A_BPAddressIndependentWebsite;
  @readonly entity A_BPContactPersonEmlAddr              as projection on S4.A_BPContactPersonEmlAddr;
  @readonly entity A_BPContactPersonFaxNmbr              as projection on S4.A_BPContactPersonFaxNmbr;
  @readonly entity A_BPContactPersonMblNmbr              as projection on S4.A_BPContactPersonMblNmbr;
  @readonly entity A_BPContactPersonTelNmbr              as projection on S4.A_BPContactPersonTelNmbr;
  @readonly entity A_BPContactPersonWbsteURL             as projection on S4.A_BPContactPersonWbsteURL;
  @readonly entity A_BPContactToAddress                  as projection on S4.A_BPContactToAddress;
  @readonly entity A_BPContactToFuncAndDept              as projection on S4.A_BPContactToFuncAndDept;
  @readonly entity A_BPCreditWorthiness                  as projection on S4.A_BPCreditWorthiness;
  @readonly entity A_BPDataController                    as projection on S4.A_BPDataController;
  @readonly entity A_BPEmployment                        as projection on S4.A_BPEmployment;
  @readonly entity A_BPFinancialServicesExtn             as projection on S4.A_BPFinancialServicesExtn;
  @readonly entity A_BPFinancialServicesReporting        as projection on S4.A_BPFinancialServicesReporting;
  @readonly entity A_BPFiscalYearInformation             as projection on S4.A_BPFiscalYearInformation;
  @readonly entity A_BPIntlAddressVersion                as projection on S4.A_BPIntlAddressVersion;
  @readonly entity A_BPRelationship                      as projection on S4.A_BPRelationship;
  @readonly entity A_BuPaAddressUsage                    as projection on S4.A_BuPaAddressUsage;
  @readonly entity A_BusinessPartnerAlias                as projection on S4.A_BusinessPartnerAlias;
  @readonly entity A_BusinessPartnerContact              as projection on S4.A_BusinessPartnerContact;
  @readonly entity A_BusinessPartnerIsBank               as projection on S4.A_BusinessPartnerIsBank;
  @readonly entity A_BusinessPartnerRating               as projection on S4.A_BusinessPartnerRating;
  @readonly entity A_BusPartAddrDepdntTaxNmbr            as projection on S4.A_BusPartAddrDepdntTaxNmbr;
  @readonly entity A_CustAddrDepdntExtIdentifier         as projection on S4.A_CustAddrDepdntExtIdentifier;
  @readonly entity A_CustAddrDepdntInformation           as projection on S4.A_CustAddrDepdntInformation;
  @readonly entity A_CustomerCompany                     as projection on S4.A_CustomerCompany;
  @readonly entity A_CustomerCompanyText                 as projection on S4.A_CustomerCompanyText;
  @readonly entity A_CustomerDunning                     as projection on S4.A_CustomerDunning;
  @readonly entity A_CustomerWithHoldingTax              as projection on S4.A_CustomerWithHoldingTax;
  @readonly entity A_CustomerSalesArea                   as projection on S4.A_CustomerSalesArea;
  @readonly entity A_CustSalesPartnerFunc                as projection on S4.A_CustSalesPartnerFunc;
  @readonly entity A_CustomerSalesAreaTax                as projection on S4.A_CustomerSalesAreaTax;
  @readonly entity A_CustSlsAreaAddrDepdntTaxInfo        as projection on S4.A_CustSlsAreaAddrDepdntTaxInfo;
  @readonly entity A_CustomerSalesAreaText               as projection on S4.A_CustomerSalesAreaText;
  @readonly entity A_CustSlsAreaAddrDepdntInfo           as projection on S4.A_CustSlsAreaAddrDepdntInfo;
  @readonly entity A_CustomerTaxGrouping                 as projection on S4.A_CustomerTaxGrouping;
  @readonly entity A_CustomerText                        as projection on S4.A_CustomerText;
  @readonly entity A_CustomerUnloadingPoint              as projection on S4.A_CustomerUnloadingPoint;
  @readonly entity A_CustUnldgPtAddrDepdntInfo           as projection on S4.A_CustUnldgPtAddrDepdntInfo;
  @readonly entity A_BusinessPartnerPaymentCard          as projection on S4.A_BusinessPartnerPaymentCard;
  @readonly entity A_SupplierCompany                     as projection on S4.A_SupplierCompany;
  @readonly entity A_SupplierCompanyText                 as projection on S4.A_SupplierCompanyText;
  @readonly entity A_SupplierDunning                     as projection on S4.A_SupplierDunning;
  @readonly entity A_SupplierWithHoldingTax              as projection on S4.A_SupplierWithHoldingTax;
  @readonly entity A_SupplierPurchasingOrg               as projection on S4.A_SupplierPurchasingOrg;
  @readonly entity A_SupplierPartnerFunc                 as projection on S4.A_SupplierPartnerFunc;
  @readonly entity A_SupplierPurchasingOrgText           as projection on S4.A_SupplierPurchasingOrgText;
  @readonly entity A_SupplierText                        as projection on S4.A_SupplierText;
}
