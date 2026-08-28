namespace mdmlight.staging;

using { cuid, managed } from '@sap/cds/common';

/**
 * Change request staging, MDG-style: one typed table per BP node, not one opaque payload. Nothing
 * here is master data - a request holds the requested state until SPA reports every approval.
 * Types and lengths come from API_BUSINESS_PARTNER.csn, so a staged value cannot be truncated.
 * Approvals are NOT modelled: SPA owns that, and the header only correlates with the process.
 */

type ChangeRequestType : String(10) enum { create; change; block; delete };

/**
 * The request lifecycle, not the approval steps - `inApproval` covers however many steps SPA runs.
 * A rejection lands on `reworkRequired` and goes back to the requester, so it is a loop, not an end;
 * `rejected` is never written but cannot be dropped. Widened from String(12), which cds-deploy allows.
 *
 * `checkAndEnrich` (2026-08-26) is the data steward's own loop, parallel to `reworkRequired` rather
 * than a step inside it: `claimDataStewardReview` moves a request here off `inApproval` the same way
 * `claimRework` does for a rejection, and `decideDataStewardReview` moves it back to `inApproval` (data
 * added, ready to resume) or on to `reworkRequired` (the steward could not make it work, so it goes to
 * the requester like any other rejection) - never to `posted`, because a data steward enriches data,
 * they do not decide the request.
 */
type ChangeRequestStatus : String(20) enum {
  draft; inApproval; approved; rejected; reworkRequired; checkAndEnrich; posted; failed
};

/** Per-row intent for the collection nodes, as MDG's change indicator. */
// `none` is a row staged for context that nobody touched - the whole partner is staged so the
// approver sees it in full, but only touched rows may be replayed to S/4. It was a NULL until
// 2026-08-20, which every one of these columns forbids: a first submit never noticed because every
// row is new, and a resubmit reloads untouched rows from staging and hit the constraint.
type NodeAction : String(1) enum { create = 'C'; update = 'U'; delete = 'D'; none = 'N' };

// --- Header ----------------------------------------------------------------

entity ChangeRequests : cuid, managed {
  requestType       : ChangeRequestType   not null;
  status            : ChangeRequestStatus not null default 'draft';

  /** The requester's own reason. A rejection no longer overwrites it - they come back to rework the
   *  request, and would otherwise resubmit the approver's words as their justification. */
  reason            : String(250);

  /** Why it came back, kept apart from `reason`. Shown on the rework screen: "rejected" with no
   *  why is not something a requester can act on. */
  rejectionComment  : String(250);

  /** Null until a create is posted; set from the outset for change/block/delete. */
  businessPartner   : String(10);

  /** SPA correlation. Set when the request is submitted for approval. */
  processInstanceId : String(60);
  submittedAt       : Timestamp;
  submittedBy       : String(120);

  /** ETag as read when the request was raised, re-compared before posting so a concurrent change
   *  is detected rather than overwritten. */
  sourceETag        : String(60);

  /** Set once the post succeeds, and the idempotency guard: a request with a number never reposts. */
  postedBP          : String(10);
  postedAt          : Timestamp;
  postError         : String(1000);

  /** A create request's own DataJson, snapshotted the moment a submit or a resubmit hands it to
   *  inApproval - the "before" a data steward's or a reworking requester's changes are judged
   *  against, so highlighting survives a reload and is still there for the NEXT actor too (an
   *  approver seeing what the data steward changed). Null until first submitted, and unused for a
   *  `change` request, which is always compared against the BP's own live S/4 values instead - see
   *  "Highlighting what changed" in CLAUDE.md. NOT reset by a data steward's own completed review on
   *  purpose: only submitRequest/resubmitRequest (a fresh round) write a new one. */
  baselineDataJson  : LargeString;

  // One row per node, keyed by the request; General is 1:1, the rest match the object page sections.
  // Every child has a `request` backlink, so the to-ONE compositions need an ON condition too - without
  // it CAP puts a foreign key on the header instead of using the backlink.
  general           : Composition of one  StagedGeneral        on general.request        = $self;
  addresses         : Composition of many StagedAddresses      on addresses.request      = $self;
  roles             : Composition of many StagedRoles          on roles.request          = $self;
  bankDetails       : Composition of many StagedBankDetails    on bankDetails.request    = $self;
  taxNumbers        : Composition of many StagedTaxNumbers     on taxNumbers.request     = $self;
  identifications   : Composition of many StagedIdentifications on identifications.request = $self;
  industries        : Composition of many StagedIndustries     on industries.request     = $self;
  customer          : Composition of one  StagedCustomer       on customer.request       = $self;
  supplier          : Composition of one  StagedSupplier       on supplier.request       = $self;
  customerCompany   : Composition of many StagedCustomerCompany on customerCompany.request = $self;
  supplierCompany   : Composition of many StagedSupplierCompany on supplierCompany.request = $self;
  customerSalesArea : Composition of many StagedCustomerSalesArea on customerSalesArea.request = $self;
  customerTaxGrouping : Composition of many StagedCustomerTaxGrouping on customerTaxGrouping.request = $self;
  supplierPurchasingOrg : Composition of many StagedSupplierPurchasingOrg on supplierPurchasingOrg.request = $self;

  findings          : Composition of many CheckFindings        on findings.request       = $self;
  comments          : Composition of many ChangeRequestComments on comments.request      = $self;
}

// --- Staged nodes ----------------------------------------------------------

// General Information. Derived and system fields are deliberately absent: S/4 owns them, and staging
// them would invite writing stale values back.
entity StagedGeneral : cuid {
  request                        : Association to ChangeRequests;

  BusinessPartner                : String(10);
  BusinessPartnerCategory        : String(1);
  BusinessPartnerGrouping        : String(4);
  BusinessPartnerType            : String(4);
  AuthorizationGroup             : String(4);

  // Person
  FirstName                      : String(40);
  MiddleName                     : String(40);
  LastName                       : String(40);
  AdditionalLastName             : String(40);
  LastNamePrefix                 : String(4);
  LastNameSecondPrefix           : String(4);
  Initials                       : String(10);
  AcademicTitle                  : String(4);
  FormOfAddress                  : String(4);
  NameFormat                     : String(2);
  NameCountry                    : String(3);
  BusinessPartnerBirthName       : String(40);
  BusinessPartnerSupplementName  : String(4);
  IsNaturalPerson                : String(1);
  IsFemale                       : Boolean;
  IsMale                         : Boolean;
  IsSexUnknown                   : Boolean;
  GenderCodeName                 : String(1);
  BirthDate                      : Date;
  BusinessPartnerBirthDateStatus : String(1);
  BusinessPartnerBirthplaceName  : String(40);
  BusinessPartnerDeathDate       : Date;
  BusPartMaritalStatus           : String(1);
  BusPartNationality             : String(3);
  BusinessPartnerOccupation      : String(4);
  NaturalPersonEmployerName      : String(35);

  // Organization
  OrganizationBPName1            : String(40);
  OrganizationBPName2            : String(40);
  OrganizationBPName3            : String(40);
  OrganizationBPName4            : String(40);
  OrganizationFoundationDate     : Date;
  OrganizationLiquidationDate    : Date;
  LegalForm                      : String(2);
  Industry                       : String(10);

  // Group
  GroupBusinessPartnerName1      : String(40);
  GroupBusinessPartnerName2      : String(40);

  // Search, communication, misc
  SearchTerm1                    : String(20);
  SearchTerm2                    : String(20);
  CorrespondenceLanguage         : String(2);
  Language                       : String(2);
  BusinessPartnerPrintFormat     : String(1);
  BusinessPartnerIDByExtSystem   : String(20);
  IndependentAddressID           : String(10);
  InternationalLocationNumber1   : String(7);
  InternationalLocationNumber2   : String(5);
  InternationalLocationNumber3   : String(1);
  TradingPartner                 : String(6);
  BusinessPartnerIsBlocked       : Boolean;
  BPDataControllerIsNotRequired  : Boolean;
}

// Collection nodes. `ID` is the key because on a create the S/4 natural key does not exist yet;
// `action` carries whether the row is added, changed or removed.
entity StagedAddresses : cuid {
  request         : Association to ChangeRequests;
  action          : NodeAction not null default 'C';
  AddressID       : String(10);
  StreetName      : String(60);
  HouseNumber     : String(10);
  PostalCode      : String(10);
  CityName        : String(40);
  Country         : String(3);
  Region          : String(3);
  POBox           : String(10);
  // ADDR1_DATA-LANGU, and required by S/4 (FSBP_GENERIC/008). NOT the same field as the root's
  // CorrespondenceLanguage, which is BP-level and person-only on an organisation (R11/336).
  Language        : String(2);
  // ADRC-TIME_ZONE. Derived from country + REGION via TTZ5S, so a row with no region has no time
  // zone to derive - see derivation-checks.js. TransportZone is deliberately absent: TZONE holds
  // valid zones per country and no determination data at all, so nothing could fill it.
  AddressTimeZone : String(6);
}

entity StagedRoles : cuid {
  request             : Association to ChangeRequests;
  action              : NodeAction not null default 'C';
  BusinessPartnerRole : String(6);
  ValidFrom           : DateTime;
  ValidTo             : DateTime;
}

entity StagedBankDetails : cuid {
  request               : Association to ChangeRequests;
  action                : NodeAction not null default 'C';
  BankIdentification    : String(4);
  BankCountryKey        : String(3);
  BankName              : String(60);
  BankNumber            : String(15);
  SWIFTCode             : String(11);
  BankAccountHolderName : String(60);
  BankAccountName       : String(40);
  IBAN                  : String(34);
  BankAccount           : String(18);
  CityName              : String(35);
}

entity StagedTaxNumbers : cuid {
  request         : Association to ChangeRequests;
  action          : NodeAction not null default 'C';
  BPTaxType       : String(4);
  BPTaxNumber     : String(20);
  BPTaxLongNumber : String(60);
}

entity StagedIdentifications : cuid {
  request                   : Association to ChangeRequests;
  action                    : NodeAction not null default 'C';
  BPIdentificationType      : String(6);
  BPIdentificationNumber    : String(60);
  BPIdnNmbrIssuingInstitute : String(40);
  BPIdentificationEntryDate : Date;
  Country                   : String(3);
  Region                    : String(3);
}

entity StagedIndustries : cuid {
  request                : Association to ChangeRequests;
  action                 : NodeAction not null default 'C';
  IndustrySector         : String(10);
  IndustrySystemType     : String(4);
  IsStandardIndustry     : String(1);
  IndustryKeyDescription : String(100);
}

// Customer Data. Names are read-only in S/4, kept for display. `action` is here even though there is
// one row: postToS4 still needs to know whether the requester touched it.
entity StagedCustomer : cuid {
  request                     : Association to ChangeRequests;
  action                      : NodeAction;
  Customer                    : String(10);
  CustomerFullName            : String(220);
  CustomerName                : String(80);
  CustomerAccountGroup        : String(4);
  CustomerClassification      : String(2);
  BillingIsBlockedForCustomer : String(2);
  DeliveryIsBlocked           : String(2);
  OrderIsBlockedForCustomer   : String(2);
  PostingIsBlocked            : Boolean;
}

/** Supplier Data. See StagedCustomer for `action`. */
entity StagedSupplier : cuid {
  request                     : Association to ChangeRequests;
  action                      : NodeAction;
  Supplier                    : String(10);
  SupplierFullName            : String(220);
  SupplierName                : String(80);
  SupplierAccountGroup        : String(4);
  PaymentIsBlockedForSupplier : Boolean;
  PostingIsBlocked            : Boolean;
  PurchasingIsBlocked         : Boolean;
  SupplierProcurementBlock    : String(2);
  VATRegistration             : String(20);
}

// A_CustomerCompany, one row per company code. `Customer` is unstaged like every relation field: it
// does not exist on a create, and postToS4 fills it from the posted partner number.
entity StagedCustomerCompany : cuid {
  request               : Association to ChangeRequests;
  action                : NodeAction not null default 'C';
  CompanyCode           : String(4);
  ReconciliationAccount : String(10);
  PaymentTerms          : String(4);
  PaymentMethodsList    : String(10);
  PaymentBlockingReason : String(1);
  HouseBank             : String(5);
  AccountingClerk       : String(2);
  CustomerAccountNote   : String(30);
}

/** Supplier Company Code Data (A_SupplierCompany). See StagedCustomerCompany. */
entity StagedSupplierCompany : cuid {
  request               : Association to ChangeRequests;
  action                : NodeAction not null default 'C';
  CompanyCode           : String(4);
  CompanyCodeName       : String(25);
  ReconciliationAccount : String(10);
  PaymentTerms          : String(4);
  PaymentMethodsList    : String(10);
  PaymentBlockingReason : String(1);
  HouseBank             : String(5);
  AccountingClerk       : String(2);
}

// A_CustomerSalesArea. The three sales-area keys are staged, unlike Company Code, because there is no
// default: a customer with no sales area cannot sell, so the requester picks all three on create.
entity StagedCustomerSalesArea : cuid {
  request                    : Association to ChangeRequests;
  action                     : NodeAction not null default 'C';
  SalesOrganization          : String(4);
  DistributionChannel        : String(2);
  Division                   : String(2);
  // KNVV-BZIRK. Required entry on account group DEBI, and the activation failure of 2026-08-28.
  SalesDistrict              : String(6);
  CreditControlArea          : String(4);
  Currency                   : String(5);
  CustomerPriceGroup         : String(2);
  CustomerPricingProcedure   : String(2);
  CustomerPaymentTerms       : String(4);
  DeliveryPriority           : String(2);
  ShippingCondition          : String(2);
  BillingIsBlockedForCustomer : String(2);
}

// A_CustomerTaxGrouping - the Tax Categories block of the MDG ERP Customer screen.
entity StagedCustomerTaxGrouping : cuid {
  request                        : Association to ChangeRequests;
  action                         : NodeAction not null default 'C';
  CustomerTaxGroupingCode        : String(3);
  CustTaxGrpExemptionCertificate : String(15);
  CustTaxGroupExemptionRate      : Decimal;
  CustTaxGroupExemptionStartDate : Date;
  CustTaxGroupExemptionEndDate   : Date;
  CustTaxGroupSubjectedStartDate : Date;
  CustTaxGroupSubjectedEndDate   : Date;
}

// A_SupplierPurchasingOrg. Natural key is Supplier + PurchasingOrganization.
entity StagedSupplierPurchasingOrg : cuid {
  request                        : Association to ChangeRequests;
  action                         : NodeAction not null default 'C';
  PurchasingOrganization         : String(4);
  PurchasingGroup                : String(3);
  PaymentTerms                   : String(4);
  PurchaseOrderCurrency          : String(5);
  IncotermsClassification        : String(3);
  MinimumOrderAmount             : Decimal(14, 3);
  PurchasingIsBlockedForSupplier : Boolean;
  InvoiceIsGoodsReceiptBased     : Boolean;
}

// --- Check results ---------------------------------------------------------

/** Output of the duplicate and data quality checks against a staged request. */
entity CheckFindings : cuid, managed {
  request     : Association to ChangeRequests;
  checkName   : String(60) not null;
  severity    : String(10) enum { info; warning; error } not null;
  message     : String(500);

  /** Node and element the finding is about, for pointing the UI at a field. */
  nodeName    : String(40);
  fieldName   : String(60);

  /** For duplicate findings: the active BP matched, and how strongly. */
  candidateBP : String(10);
  score       : Decimal(5, 4);

  /** Instead of `candidateBP` when the match is a request that has not posted: a pending create has
   *  no partner number, and two requests for one company are what the check must catch. */
  candidateRequest : UUID;

  /** Its own column, not folded into `severity`: severity says whether to act, verdict says what
   *  was found, and they are not the same concept. */
  verdict     : String(12);

  /** Set when a re-check supersedes this finding rather than deleting it. */
  isStale     : Boolean default false;
}

/**
 * The requester/approver conversation, one row per message. `reason` and `rejectionComment` on the
 * header only ever held the latest side's word, which is fine for a request rejected once but not
 * for a rework loop that can run several rounds - this is the running thread both screens read, and
 * nothing here is ever overwritten or deleted, unlike those two fields which keep working exactly as
 * before for whatever still reads them.
 */
entity ChangeRequestComments : cuid, managed {
  request : Association to ChangeRequests;
  /** Who is speaking, not who is logged in - a steward reworking someone else's draft is still
   *  the requester's side of the conversation. `System` is neither: a failed S/4 post is reported
   *  by `postAndRecord`, not by the approver who pressed Approve, and must not read as a rejection.
   *  `DataSteward` (2026-08-26) is its own value, not `Approver`: a steward enriching data during
   *  `checkAndEnrich` is a distinct step from the approver's decision, and the conversation should
   *  say which one actually spoke. */
  role    : String(20) enum { Requester; Approver; System; DataSteward } not null;
  /** The actual identity, for display next to `role` - two rejections from two different
   *  approvers should not read as the same person twice. */
  author  : String(120);
  text    : String(1000) not null;
}

/**
 * The rest of the MDG ERP Customer / Supplier tree. Each row carries its PARENT's keys, because that
 * is what makes it addressable on replay - postToS4 builds the parent URI from them. Customer and
 * Supplier themselves stay unstaged, resolved from the business partner at posting time.
 */

/** Customer Texts (A_CustomerText). */
entity StagedCustomerText : cuid {
  request    : Association to ChangeRequests;
  action     : NodeAction not null default 'C';
  Language   : String(2);
  LongTextID : String(4);
  LongText   : LargeString;
}

/** Customer Address External Identifiers (A_CustAddrDepdntExtIdentifier). */
entity StagedCustomerAddressExtIdentifier : cuid {
  request               : Association to ChangeRequests;
  action                : NodeAction not null default 'C';
  AddressID             : String(10);
  CustomerExternalRefID : String(12);
}

/** Customer Address-Dependent Information (A_CustAddrDepdntInformation). */
entity StagedCustomerAddressInfo : cuid {
  request                 : Association to ChangeRequests;
  action                  : NodeAction not null default 'C';
  AddressID               : String(10);
  ExpressTrainStationName : String(25);
  TrainStationName        : String(25);
  CityCode                : String(4);
  County                  : String(3);
}

/** Customer Company Code Texts (A_CustomerCompanyText). */
entity StagedCustomerCompanyText : cuid {
  request     : Association to ChangeRequests;
  action      : NodeAction not null default 'C';
  CompanyCode : String(4);
  Language    : String(2);
  LongTextID  : String(4);
  LongText    : LargeString;
}

/** Customer Dunning (A_CustomerDunning). */
entity StagedCustomerDunning : cuid {
  request               : Association to ChangeRequests;
  action                : NodeAction not null default 'C';
  CompanyCode           : String(4);
  DunningArea           : String(2);
  DunningProcedure      : String(4);
  DunningLevel          : String(1);
  DunningBlock          : String(1);
  DunningRecipient      : String(10);
  DunningClerk          : String(2);
  LastDunnedOn          : Date;
  LegDunningProcedureOn : Date;
  AuthorizationGroup    : String(4);
}

/** Customer Withholding Tax (A_CustomerWithHoldingTax). */
entity StagedCustomerWithholdingTax : cuid {
  request                    : Association to ChangeRequests;
  action                     : NodeAction not null default 'C';
  CompanyCode                : String(4);
  WithholdingTaxType         : String(2);
  WithholdingTaxCode         : String(2);
  WithholdingTaxAgent        : Boolean;
  ObligationDateBegin        : Date;
  ObligationDateEnd          : Date;
  WithholdingTaxNumber       : String(16);
  WithholdingTaxCertificate  : String(25);
  WithholdingTaxExmptPercent : Decimal(5,2);
  ExemptionDateBegin         : Date;
  ExemptionDateEnd           : Date;
  ExemptionReason            : String(2);
  RecipientType              : String(2);
  AuthorizationGroup         : String(4);
}

/** Customer Sales Area Texts (A_CustomerSalesAreaText). */
entity StagedCustomerSalesAreaText : cuid {
  request             : Association to ChangeRequests;
  action              : NodeAction not null default 'C';
  SalesOrganization   : String(4);
  DistributionChannel : String(2);
  Division            : String(2);
  Language            : String(2);
  LongTextID          : String(4);
  LongText            : LargeString;
}

/** Customer Partner Functions (A_CustSalesPartnerFunc). */
entity StagedCustomerSalesPartnerFunc : cuid {
  request             : Association to ChangeRequests;
  action              : NodeAction not null default 'C';
  SalesOrganization   : String(4);
  DistributionChannel : String(2);
  Division            : String(2);
  PartnerFunction     : String(2);
  PartnerCounter      : String(3);
  BPCustomerNumber    : String(10);
  DefaultPartner      : Boolean;
  Supplier            : String(10);
  PersonnelNumber     : String(8);
  ContactPerson       : String(10);
  AddressID           : String(10);
  AuthorizationGroup  : String(4);
}

/** Customer Sales Area Address-Dependent Information (A_CustSlsAreaAddrDepdntInfo). */
entity StagedCustomerSalesAreaAddressInfo : cuid {
  request                 : Association to ChangeRequests;
  action                  : NodeAction not null default 'C';
  SalesOrganization       : String(4);
  DistributionChannel     : String(2);
  Division                : String(2);
  AddressID               : String(10);
  IncotermsClassification : String(3);
  IncotermsLocation1      : String(70);
  IncotermsLocation2      : String(70);
  IncotermsVersion        : String(4);
  DeliveryIsBlocked       : String(2);
  SalesOffice             : String(4);
  SalesGroup              : String(3);
  ShippingCondition       : String(2);
  SupplyingPlant          : String(4);
}

/** Customer Unloading Points (A_CustomerUnloadingPoint). */
entity StagedCustomerUnloadingPoint : cuid {
  request                       : Association to ChangeRequests;
  action                        : NodeAction not null default 'C';
  UnloadingPointName            : String(25);
  CustomerFactoryCalenderCode   : String(2);
  BPGoodsReceivingHoursCode     : String(3);
  IsDfltBPUnloadingPoint        : Boolean;
  MondayMorningOpeningTime      : Time;
  MondayMorningClosingTime      : Time;
  MondayAfternoonOpeningTime    : Time;
  MondayAfternoonClosingTime    : Time;
  TuesdayMorningOpeningTime     : Time;
  TuesdayMorningClosingTime     : Time;
  TuesdayAfternoonOpeningTime   : Time;
  TuesdayAfternoonClosingTime   : Time;
  WednesdayMorningOpeningTime   : Time;
  WednesdayMorningClosingTime   : Time;
  WednesdayAfternoonOpeningTime : Time;
  WednesdayAfternoonClosingTime : Time;
  ThursdayMorningOpeningTime    : Time;
  ThursdayMorningClosingTime    : Time;
  ThursdayAfternoonOpeningTime  : Time;
  ThursdayAfternoonClosingTime  : Time;
  FridayMorningOpeningTime      : Time;
  FridayMorningClosingTime      : Time;
  FridayAfternoonOpeningTime    : Time;
  FridayAfternoonClosingTime    : Time;
  SaturdayMorningOpeningTime    : Time;
  SaturdayMorningClosingTime    : Time;
  SaturdayAfternoonOpeningTime  : Time;
  SaturdayAfternoonClosingTime  : Time;
  SundayMorningOpeningTime      : Time;
  SundayMorningClosingTime      : Time;
  SundayAfternoonOpeningTime    : Time;
  SundayAfternoonClosingTime    : Time;
}

/** Customer Unloading Point Address-Dependent Information (A_CustUnldgPtAddrDepdntInfo). */
entity StagedCustomerUnloadingPointAddressInfo : cuid {
  request                       : Association to ChangeRequests;
  action                        : NodeAction not null default 'C';
  AddressID                     : String(10);
  UnloadingPointName            : String(25);
  CustomerFactoryCalenderCode   : String(2);
  BPGoodsReceivingHoursCode     : String(3);
  IsDfltBPUnloadingPoint        : Boolean;
  MondayMorningOpeningTime      : Time;
  MondayMorningClosingTime      : Time;
  MondayAfternoonOpeningTime    : Time;
  MondayAfternoonClosingTime    : Time;
  TuesdayMorningOpeningTime     : Time;
  TuesdayMorningClosingTime     : Time;
  TuesdayAfternoonOpeningTime   : Time;
  TuesdayAfternoonClosingTime   : Time;
  WednesdayMorningOpeningTime   : Time;
  WednesdayMorningClosingTime   : Time;
  WednesdayAfternoonOpeningTime : Time;
  WednesdayAfternoonClosingTime : Time;
  ThursdayMorningOpeningTime    : Time;
  ThursdayMorningClosingTime    : Time;
  ThursdayAfternoonOpeningTime  : Time;
  ThursdayAfternoonClosingTime  : Time;
  FridayMorningOpeningTime      : Time;
  FridayMorningClosingTime      : Time;
  FridayAfternoonOpeningTime    : Time;
  FridayAfternoonClosingTime    : Time;
  SaturdayMorningOpeningTime    : Time;
  SaturdayMorningClosingTime    : Time;
  SaturdayAfternoonOpeningTime  : Time;
  SaturdayAfternoonClosingTime  : Time;
  SundayMorningOpeningTime      : Time;
  SundayMorningClosingTime      : Time;
  SundayAfternoonOpeningTime    : Time;
  SundayAfternoonClosingTime    : Time;
}

/** Supplier Texts (A_SupplierText). */
entity StagedSupplierText : cuid {
  request    : Association to ChangeRequests;
  action     : NodeAction not null default 'C';
  Language   : String(2);
  LongTextID : String(4);
  LongText   : LargeString;
}

/** Supplier Company Code Texts (A_SupplierCompanyText). */
entity StagedSupplierCompanyText : cuid {
  request     : Association to ChangeRequests;
  action      : NodeAction not null default 'C';
  CompanyCode : String(4);
  Language    : String(2);
  LongTextID  : String(4);
  LongText    : LargeString;
}

/** Supplier Dunning (A_SupplierDunning). */
entity StagedSupplierDunning : cuid {
  request               : Association to ChangeRequests;
  action                : NodeAction not null default 'C';
  CompanyCode           : String(4);
  DunningArea           : String(2);
  DunningProcedure      : String(4);
  DunningLevel          : String(1);
  DunningBlock          : String(1);
  DunningRecipient      : String(10);
  DunningClerk          : String(2);
  LastDunnedOn          : Date;
  LegDunningProcedureOn : Date;
  AuthorizationGroup    : String(4);
}

/** Supplier Withholding Tax (A_SupplierWithHoldingTax). */
entity StagedSupplierWithholdingTax : cuid {
  request                    : Association to ChangeRequests;
  action                     : NodeAction not null default 'C';
  CompanyCode                : String(4);
  WithholdingTaxType         : String(2);
  WithholdingTaxCode         : String(2);
  IsWithholdingTaxSubject    : Boolean;
  WithholdingTaxNumber       : String(16);
  WithholdingTaxCertificate  : String(25);
  WithholdingTaxExmptPercent : Decimal(5,2);
  ExemptionDateBegin         : Date;
  ExemptionDateEnd           : Date;
  ExemptionReason            : String(2);
  RecipientType              : String(2);
  AuthorizationGroup         : String(4);
}

/** Supplier Purchasing Organization Texts (A_SupplierPurchasingOrgText). */
entity StagedSupplierPurchasingOrgText : cuid {
  request                : Association to ChangeRequests;
  action                 : NodeAction not null default 'C';
  PurchasingOrganization : String(4);
  Language               : String(2);
  LongTextID             : String(4);
  LongText               : LargeString;
}

/** Supplier Partner Functions (A_SupplierPartnerFunc). */
entity StagedSupplierPartnerFunc : cuid {
  request                : Association to ChangeRequests;
  action                 : NodeAction not null default 'C';
  PurchasingOrganization : String(4);
  SupplierSubrange       : String(6);
  Plant                  : String(4);
  PartnerFunction        : String(2);
  PartnerCounter         : String(3);
  DefaultPartner         : Boolean;
  ReferenceSupplier      : String(10);
  AuthorizationGroup     : String(4);
}

/** Customer Tax Indicators (A_CustomerSalesAreaTax). */
entity StagedCustomerTaxIndicators : cuid {
  request                   : Association to ChangeRequests;
  action                    : NodeAction not null default 'C';
  SalesOrganization         : String(4);
  DistributionChannel       : String(2);
  Division                  : String(2);
  DepartureCountry          : String(3);
  CustomerTaxCategory       : String(4);
  CustomerTaxClassification : String(1);
}
