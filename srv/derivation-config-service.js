'use strict';

const cds = require('@sap/cds');

// One place, so the CDS and the READ handler loop stay in sync when a set is added.
const DERIVATION_CONFIG_ENTITIES = Object.freeze([
  'AddressDefaults',
  'TimeZones',
  'TaxCategories',
  'PartnerFunctions',
  'PartnerFunctionProcedures',
  'PartnerFunctionsByAccountGroup'
]);

// The remote sets behind them, for the metadata drift check — the projections are renamed, and the
// remote name is the one to ask $metadata about.
const DERIVATION_REMOTE_SETS = Object.freeze([
  'DerAddressDefaults',
  'DerTimeZones',
  'DerTaxCategories',
  'DerPartnerFunctions',
  'DerPartnerFunctionProcedures',
  'DerPartnerFunctionAccGrp'
]);

/**
 * Read-only by construction, exactly like `CviConfigService`: this is customizing owned by S/4 and
 * maintained in SPRO, and nothing in MDM Light has any business writing it back.
 */
class DerivationConfigService extends cds.ApplicationService {
  async init() {
    const valueHelp = await cds.connect.to('ZSRVB_MDMLIGHT_VH');

    for (const entity of DERIVATION_CONFIG_ENTITIES) {
      this.on('READ', entity, (req) => valueHelp.run(req.query));
    }

    return super.init();
  }
}

module.exports = DerivationConfigService;
module.exports.DERIVATION_CONFIG_ENTITIES = DERIVATION_CONFIG_ENTITIES;
module.exports.DERIVATION_REMOTE_SETS = DERIVATION_REMOTE_SETS;
