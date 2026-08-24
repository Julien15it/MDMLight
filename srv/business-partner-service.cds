using { API_BUSINESS_PARTNER as S4 } from './external/API_BUSINESS_PARTNER';
using { ZSRVB_MDMLIGHT_VH as VH } from './external/ZSRVB_MDMLIGHT_VH';

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

  /**
   * What the search list reads: the live S/4 partners **and** the change requests still in flight,
   * in one result set. A pending create has no partner number yet, so it can only be seen here as
   * its own row; a change/block/delete request over an existing partner is that partner's row,
   * marked. Before this existed the requests were invisible - worse, a partner under an in-flight
   * request was filtered *out* of the list - so two people could request the same company twice
   * over without either seeing the other.
   *
   * Not persisted and not a projection: one READ handler merges the remote read with staging.
   * `ResultKey` exists because a pending create has no key of its own to be listed under.
   */
  @cds.persistence.skip
  @Capabilities: {
    SearchRestrictions: { Searchable: true },
    InsertRestrictions: { Insertable: false },
    UpdateRestrictions: { Updatable: false },
    DeleteRestrictions: { Deletable: false },
    // The staged half of the list is filtered and sorted in memory, so only the fields S/4 itself
    // can filter on are offered. Sorting on a computed column would silently sort one half only.
    FilterRestrictions: { NonFilterableProperties: [
      ResultKey, RecordStatus, RecordStatusCriticality, IsChangeRequest,
      ChangeRequest, ChangeRequestType, ChangeRequestStatus, RequestedBy, RequestedAt
    ] },
    SortRestrictions: { NonSortableProperties: [
      ResultKey, RecordStatus, RecordStatusCriticality, IsChangeRequest,
      ChangeRequest, ChangeRequestType, ChangeRequestStatus, RequestedBy, RequestedAt
    ] }
  }
  @readonly entity BusinessPartnerSearchResults {
    /** `BP:4711` or `CR:<request id>`. A pending create has no number to be keyed by. */
    key ResultKey                : String(45);
        BusinessPartner          : String(10);
        BusinessPartnerFullName  : String(81);
        BusinessPartnerCategory  : String(1);
        BusinessPartnerGrouping  : String(4);
        SearchTerm1              : String(20);
        BusinessPartnerIsBlocked : Boolean;

        /** What the row is, in words: 'Active', 'Create in approval', 'Change rework required'.
         *  Composed server-side so the list and the request can never disagree about a status. */
        RecordStatus             : String(40);
        /** UI.Criticality: 0 neutral, 2 critical-warning for anything in flight. */
        RecordStatusCriticality  : Integer;

        /** True for a pending create, which is a request and not yet a partner. */
        IsChangeRequest          : Boolean;
        /** The request in flight - whether this row IS that request, or is a partner marked by it. */
        ChangeRequest            : UUID;
        ChangeRequestType        : String(10);
        ChangeRequestStatus      : String(20);
        RequestedBy              : String(120);
        RequestedAt              : Timestamp;
  }

  // Value-help lookups sourced from the custom S/4 value-help service
  // ZSRVB_MDMLIGHT_VH — API_BUSINESS_PARTNER itself exposes none of these.
  // Referenced from srv/annotations.cds via @Common.ValueList and, in the
  // full-screen maintenance UI, via VALUE_HELP_FIELDS in
  // BusinessPartnerMaintenance.controller.js.
  @readonly entity BusinessPartnerGroupings  as projection on VH.BusinessPartnerGroupings;
  @readonly entity BusinessPartnerCategories as projection on VH.BusinessPartnerCategories;
  @readonly entity LegalForms                as projection on VH.LegalForms;
  @readonly entity FormsOfAddress            as projection on VH.FormsOfAddress;
  @readonly entity AcademicTitles            as projection on VH.AcademicTitles;
  @readonly entity Genders                   as projection on VH.Genders;
  @readonly entity IndustryCodes             as projection on VH.IndustryCodes;
  @readonly entity Languages                 as projection on VH.Languages;
  @readonly entity Countries                 as projection on VH.Countries;
  @readonly entity Regions                   as projection on VH.Regions;
  @readonly entity IndustrySectors           as projection on VH.IndustrySectors;
  @readonly entity IndustrySystems           as projection on VH.IndustrySystems;
  // AddressDependentTaxTypes is the address-dependent *subset* — on this system exactly one row
  // (FR1), which is not a list anyone can pick BE0 from. TaxTypes is the full catalogue; its key
  // carries Language, which the READ handler collapses to one row per category.
  @readonly entity AddressDependentTaxTypes  as projection on VH.AddressDependentTaxTypes;
  @readonly entity TaxTypes                  as projection on VH.TaxTypes;
  @readonly entity IdentificationTypes       as projection on VH.IdentificationTypes;
  @readonly entity CustomerAccountGroups     as projection on VH.CustomerAccountGroups;
  @readonly entity CustomerClassifications   as projection on VH.CustomerClassifications;
  @readonly entity SupplierAccountGroups     as projection on VH.SupplierAccountGroups;
  // Renamed to avoid clashing with the existing BusinessPartnerRoles child
  // entity below (S4.A_BusinessPartnerRole) — this one is the code/text list.
  @readonly entity BusinessPartnerRoleCodes  as projection on VH.BusinessPartnerRoles;

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

  action deleteBusinessPartnerEntity(
    Entity : String(40) not null,
    KeyJson: LargeString not null
  ) returns Boolean;

  /** Starts the approval workflow for a newly created Business Partner. Called
   *  by the UI only after every section (root + addresses + ...) has been
   *  saved to S/4, so the workflow sees the complete record instead of the
   *  bare root that exists right after saveBusinessPartner's create call. */
  action startBusinessPartnerApprovalWorkflow(
    BusinessPartner: String(10) not null
  ) returns Boolean;

  /** What the signed-in user is allowed to do, so the UI can hide what they
   *  cannot use. Readable by any authenticated user - it reports permissions,
   *  it does not grant them, and every protected service still checks its own
   *  scope. Hiding a button is courtesy, never the control. */
  function currentUserPermissions() returns {
    isDataSteward       : Boolean;
    /** False when a steward has switched AI assistance off for this
     *  installation. The assistant still answers - from the S/4 search, with no
     *  model involved - so this is what lets the screen stop calling it AI
     *  rather than have to hide it. Courtesy again: the switch is enforced on
     *  the server, in srv/ai/availability.js. */
    aiAssistanceEnabled : Boolean;
  };

  /** Read-only assistant grounded in the Business Partners currently present
   *  in S/4HANA. It never creates or changes master data. */
  action askBusinessPartnerAssistant(
    Question         : String(1000) not null,
    ConversationJson : LargeString
  ) returns BusinessPartnerAssistantAnswer;

  /** The one duplicate check, for callers that hold a whole record rather than
   *  a name - the change-request submit above all. Read-only: it returns
   *  findings and never blocks or writes anything itself. */
  action checkBusinessPartnerDuplicates(
    CandidateJson : LargeString not null,
    ExcludeBP     : String(10),
    /** The caller's own change request, so a submit is never reported as its
     *  own duplicate - it is already staged by the time this runs. */
    ExcludeRequest : UUID
  ) returns LargeString;

  /** Runs a ruleset over the whole partner index without saving it, for the
   *  steward's "test against current BPs" button. Lives here because this is
   *  where the one resident index lives. */
  action testDuplicateRuleset(
    RulesJson  : LargeString,
    SampleSize : Integer
  ) returns LargeString;

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
  // Friendly aliases for the maintenance actions' entity metadata lookup
  // (this.entities[Entity] in saveBusinessPartnerEntity/deleteBusinessPartnerEntity).
  // The full-name projections further below stay as the read-only catalogue;
  // @cds.redirection.target picks this one as the target for Customers/
  // Suppliers' own to_CustomerCompany/to_SupplierCompany navigation, since two
  // projections of the same remote entity leave CAP unable to auto-redirect.
  @readonly @cds.redirection.target entity CustomerCompany as projection on S4.A_CustomerCompany;
  @readonly @cds.redirection.target entity SupplierCompany as projection on S4.A_SupplierCompany;
  // CustomerStatisticsGroup is excluded for the same reason as BR_ICMSTaxPayerType on
  // A_Customer: the VF on-premise implementation no longer exposes it, and asking for it
  // fails the whole read with "Resource not found for the segment
  // 'CustomerStatisticsGroup'" - confirmed against the live service. The drift check in
  // srv/metadata-drift.js reports it; this is the fix it asks for.
  @readonly @cds.redirection.target entity CustomerSalesArea as projection on S4.A_CustomerSalesArea excluding {
    CustomerStatisticsGroup
  };
  @readonly @cds.redirection.target entity CustomerTaxGrouping as projection on S4.A_CustomerTaxGrouping;
  @readonly @cds.redirection.target entity SupplierPurchasingOrg as projection on S4.A_SupplierPurchasingOrg;

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
  // `RecipientType` went the way of the four fields excluded above: the startup drift check
  // reported it gone from the live A_CustomerWithHoldingTax on 2026-08-21, and asking for a field
  // the service no longer exposes answers 404 "Resource not found for the segment" - which fails
  // the WHOLE Customer Withholding Tax read, so the section renders empty for a customer that has
  // withholding tax data. This is a maintained section (MAINTENANCE_ENTITIES.CustomerWithholdingTax,
  // read through to_WithHoldingTax), not one of the read-only catalogue entities nothing touches.
  @readonly entity A_CustomerWithHoldingTax              as projection on S4.A_CustomerWithHoldingTax excluding {
    RecipientType
  };
  @readonly entity A_CustomerSalesArea                   as projection on S4.A_CustomerSalesArea excluding {
    CustomerStatisticsGroup
  };
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
