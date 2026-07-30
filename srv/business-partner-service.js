const cds = require('@sap/cds');

/**
 * Delegates every read of BusinessPartners live to the S/4HANA system
 * (API_BUSINESS_PARTNER) via destination VF_S4HANA_DEST. Nothing is stored locally:
 * filters, sorting and paging from the request are passed straight through to S/4.
 */
module.exports = class BusinessPartnerService extends cds.ApplicationService {
  init() {
    this.on('READ', 'BusinessPartners', async (req) => {
      const s4 = await cds.connect.to('API_BUSINESS_PARTNER');
      return s4.run(req.query);
    });

    return super.init();
  }
};
