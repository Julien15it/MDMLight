using { mdm.md.businesspartner as db } from '../db/schema';
using { API_BUSINESS_PARTNER as S4 } from './external/API_BUSINESS_PARTNER';

/**
 * OData V4 service exposing the Business Partner master data.
 * This is the service the "Manage Business Partner" (F3163) Fiori Elements app binds to.
 */
service BusinessPartnerService @(path: '/service/businesspartner') {

  @odata.draft.enabled
  entity BusinessPartners as projection on db.BusinessPartners;

  entity Addresses            as projection on db.Addresses;
  entity BusinessPartnerRoles as projection on db.BusinessPartnerRoles;
  entity BankDetails          as projection on db.BankDetails;

  // Live, read-only Business Partners fetched directly from S/4HANA (API_BUSINESS_PARTNER).
  // Every request is delegated to S/4 at runtime - no copy is stored locally.
  @readonly entity S4BusinessPartners as projection on S4.A_BusinessPartner {
    key BusinessPartner,
    BusinessPartnerFullName,
    BusinessPartnerName,
    BusinessPartnerCategory,
    BusinessPartnerGrouping,
    SearchTerm1,
    FirstName,
    LastName,
    OrganizationBPName1,
    BusinessPartnerIsBlocked
  };

  // Value help / code lists (read-only)
  @readonly entity BusinessPartnerCategories as projection on db.BusinessPartnerCategories;
  @readonly entity BusinessPartnerGroupings  as projection on db.BusinessPartnerGroupings;
  @readonly entity Roles                     as projection on db.Roles;
  @readonly entity AcademicTitles            as projection on db.AcademicTitles;
  @readonly entity Countries                 as projection on db.Countries;
}
