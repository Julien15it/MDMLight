const cds = require('@sap/cds');

/**
 * Custom logic for the BusinessPartnerService.
 * Keeps the derived full name in sync and provides a small default on create.
 */
module.exports = class BusinessPartnerService extends cds.ApplicationService {
  init() {
    const { BusinessPartners } = this.entities;

    // Derive the full name for persons / organizations before saving.
    this.before(['CREATE', 'UPDATE'], BusinessPartners, (req) => {
      const bp = req.data;
      if (bp.BusinessPartnerCategory_code === '1') {
        bp.BusinessPartnerFullName = [bp.FirstName, bp.LastName].filter(Boolean).join(' ').trim();
      } else if (bp.BusinessPartnerCategory_code === '2') {
        bp.BusinessPartnerFullName = bp.OrganizationBPName1;
      }
      if (bp.BusinessPartnerFullName) {
        bp.BusinessPartnerName = bp.BusinessPartnerFullName;
      }
    });

    // Delegate reads of S4BusinessPartners live to the S/4HANA system.
    // Connects lazily on first use (via destination VF_S4HANA_DEST); filters,
    // sorting and paging from the request are passed straight through.
    this.on('READ', 'S4BusinessPartners', async (req) => {
      const s4 = await cds.connect.to('API_BUSINESS_PARTNER');
      return s4.run(req.query);
    });

    return super.init();
  }
};
