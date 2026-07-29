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

    return super.init();
  }
};
