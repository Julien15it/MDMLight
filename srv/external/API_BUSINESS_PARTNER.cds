/**
 * Lean, hand-written model of the SAP S/4HANA API_BUSINESS_PARTNER (OData V2).
 *
 * Only the fields the app consumes are declared here — enough to read Business
 * Partners live from S/4. If you later need more fields (addresses, roles,
 * bank details, …), replace this file with a full import of the official EDMX:
 *
 *     cds import API_BUSINESS_PARTNER.edmx --as cds
 *
 * The service is declared as a *required* (remote) service in package.json, so
 * CAP connects to it via the destination instead of serving it locally.
 */
service API_BUSINESS_PARTNER {

  entity A_BusinessPartner {
    key BusinessPartner          : String(10);
        BusinessPartnerFullName  : String(81);
        BusinessPartnerName      : String(81);
        BusinessPartnerCategory  : String(1);
        BusinessPartnerGrouping  : String(4);
        SearchTerm1              : String(20);
        FirstName                : String(40);
        LastName                 : String(40);
        OrganizationBPName1      : String(40);
        BusinessPartnerIsBlocked : Boolean;
  }
}
