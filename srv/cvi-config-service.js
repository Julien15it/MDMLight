'use strict';

const cds = require('@sap/cds');

// One place, so the CDS and the READ handler loop stay in sync when a set is added.
const CVI_CONFIG_ENTITIES = Object.freeze([
  'RoleCategories',
  'BusinessPartnerRoles',
  'ContactMapping',
  'PostprocessingControl',
  'NumberRanges'
]);

// The remote sets behind them, for the metadata drift check — the projections are renamed, and the
// remote name is the one to ask $metadata about.
const CVI_REMOTE_SETS = Object.freeze([
  'CviRoleCategories',
  'CviBusinessPartnerRoles',
  'CviContactMapping',
  'CviPostprocessingControl',
  'CviNumberRanges'
]);

/**
 * Read-only by construction: this is customizing owned by S/4, maintained in SPRO, and nothing in
 * MDM Light has any business writing it back.
 */
class CviConfigService extends cds.ApplicationService {
  async init() {
    const valueHelp = await cds.connect.to('ZSRVB_MDMLIGHT_VH');

    for (const entity of CVI_CONFIG_ENTITIES) {
      this.on('READ', entity, (req) => valueHelp.run(req.query));
    }

    return super.init();
  }
}

module.exports = CviConfigService;
module.exports.CVI_CONFIG_ENTITIES = CVI_CONFIG_ENTITIES;
module.exports.CVI_REMOTE_SETS = CVI_REMOTE_SETS;
