using { API_BUSINESS_PARTNER as S4 } from './external/API_BUSINESS_PARTNER';

/**
 * Read-only OData V4 service that shows Business Partners LIVE from S/4HANA.
 * There is no local database: every request is delegated to S/4 at runtime
 * via destination VF_S4HANA_DEST (see business-partner-service.js).
 * This is the service the Fiori Elements app binds to.
 */
service BusinessPartnerService @(path: '/service/businesspartner') {

  @readonly
  entity BusinessPartners as projection on S4.A_BusinessPartner {
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
}
