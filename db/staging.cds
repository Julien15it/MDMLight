namespace mdmlight.staging;

using { cuid, managed } from '@sap/cds/common';

/**
 * Staging for MDMLight change requests, modelled after the MDG staging tables:
 * one typed table per Business Partner node, mirroring the sections of the
 * Maintain BP app, rather than one opaque payload.
 *
 * Nothing here is master data. A request holds the requested state until the
 * SAP Process Automation workflow reports every approval given, at which point
 * the rows are assembled into an API_BUSINESS_PARTNER call and the request is
 * closed.
 *
 * Column types and lengths are taken from srv/external/API_BUSINESS_PARTNER.csn
 * so staged values can never be truncated on the way to S/4.
 *
 * Approvals are NOT modelled here - SPA owns the approval state. The header
 * keeps only what is needed to correlate with the running process.
 */

type ChangeRequestType : String(10) enum { create; change; block; delete };

/**
 * Mirrors the request lifecycle, not the approval steps. `inApproval` covers
 * the whole time SPA owns the request, however many steps that involves.
 */
type ChangeRequestStatus : String(12) enum {
  draft; inApproval; approved; rejected; posted; failed
};

/** Per-row intent for the collection nodes, as MDG's change indicator. */
type NodeAction : String(1) enum { create = 'C'; update = 'U'; delete = 'D' };

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

entity ChangeRequests : cuid, managed {
  requestType       : ChangeRequestType   not null;
  status            : ChangeRequestStatus not null default 'draft';
  reason            : String(250);

  /** Null until a create is posted; set from the outset for change/block/delete. */
  businessPartner   : String(10);

  /** SPA correlation. Set when the request is submitted for approval. */
  processInstanceId : String(60);
  submittedAt       : Timestamp;
  submittedBy       : String(120);

  /**
   * ETag of the BP as read when the request was created. Compared against S/4
   * again immediately before posting, so a concurrent change is detected
   * instead of silently overwritten.
   */
  sourceETag        : String(60);

  /**
   * Set once the post succeeds, and the idempotency guard: a request that
   * already carries a number must never post again.
   */
  postedBP          : String(10);
  postedAt          : Timestamp;
  postError         : String(1000);

  // One row per node, keyed by the request. General is 1:1, the rest are
  // collections matching the object page sections.
  // Every child carries an explicit `request` backlink, so the to-one
  // compositions need an ON condition too - without it CAP would put a foreign
  // key on the header instead of using the backlink.
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

  findings          : Composition of many CheckFindings        on findings.request       = $self;
}

// ---------------------------------------------------------------------------
// Staged nodes
// ---------------------------------------------------------------------------

/**
 * General Information. Derived and system fields (full names, UUID, ETag,
 * created/changed by and on) are deliberately absent - S/4 owns them, and
 * staging them would invite writing stale values back.
 */
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

/**
 * Collection nodes. The surrogate `ID` is the key because on a create the S/4
 * natural key does not exist yet - AddressID and friends stay null until S/4
 * assigns them. `action` carries whether the row is being added, changed or
 * removed.
 */
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

/** Customer Data. Full name and name are read-only in S/4; kept for display. */
entity StagedCustomer : cuid {
  request                     : Association to ChangeRequests;
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

entity StagedSupplier : cuid {
  request                     : Association to ChangeRequests;
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

/**
 * Customer Company Code Data (A_CustomerCompany). One row per company code a
 * customer is extended to - unlike StagedCustomer, several can exist per
 * request. `Customer` is left unstaged like every other child's business
 * partner backlink: it does not exist yet on a create, and postToS4 fills it
 * in from the posted partner number before replaying the row to S/4.
 */
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

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

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

  /** Set instead of `candidateBP` when the match is another change request that
   *  has not posted yet. A pending create has no partner number, and two
   *  requests for the same company are exactly what the check has to catch. */
  candidateRequest : UUID;

  /** Duplicate verdict tier. Its own column rather than folded into `severity`:
   *  severity says whether someone must act, verdict says what was found, and
   *  they are not the same concept. Adding a column is safe - the deployer only
   *  refuses to drop them. */
  verdict     : String(12);

  /** Set when a re-check supersedes this finding rather than deleting it. */
  isStale     : Boolean default false;
}
