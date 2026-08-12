'use strict';

const cds = require('@sap/cds');
const { catalogFields, validateRule } = require('./ai/rule-config');
const { ruleStore } = require('./ai/duplicate-check');
const { COMPARISONS, INDICATORS } = require('./ai/duplicate-engine');
const { CONDITION_FIELDS } = require('./ai/duplicate-fields');

const RULES = 'mdmlight.config.DuplicateRules';

module.exports = class DuplicateConfigService extends cds.ApplicationService {
  async init() {
    // Catching a bad row here is the point: the engine reports a rule it cannot run, but by then
    // the check has already answered "no duplicates", which is the one wrong answer it must avoid.
    this.before(['CREATE', 'UPDATE'], 'DuplicateRules', async (req) => {
      // A patch carries only what changed, so it is validated against the stored row it lands on.
      // A read failure must not block every save — validate what was sent and let it through.
      let stored = null;
      if (req.event === 'UPDATE' && req.data.ID) {
        try {
          stored = await cds.run(cds.ql.SELECT.one.from(RULES).where({ ID: req.data.ID }));
        } catch (error) {
          console.warn('[duplicates] Could not read the stored rule to validate against:', error.message);
        }
      }
      const { errors, warnings } = validateRule({ ...(stored || {}), ...req.data });
      for (const warning of warnings) req.info(200, warning.message, warning.field);
      for (const error of errors) req.error(400, error.message, error.field);
    });

    // Any write drops the resident ruleset, the same way a partner write drops the name index.
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'DuplicateRules', () => ruleStore.markStale());

    // Straight from the code-defined catalog, never a copy the UI keeps in step by hand.
    this.on('ruleOptions', () => ({
      fields: catalogFields(),
      comparisons: Object.keys(COMPARISONS),
      indicators: [...INDICATORS],
      conditions: [...CONDITION_FIELDS]
    }));

    /**
     * Delegated to BusinessPartnerService, which owns the S/4 connection and the one resident
     * name index. Standing up a second index here would be a second duplicate check by the back
     * door — exactly what the one-engine requirement forbids.
     */
    this.on('testRuleset', async (req) => {
      const bp = await cds.connect.to('BusinessPartnerService');
      return bp.send('testDuplicateRuleset', {
        RulesJson: req.data.RulesJson || null,
        SampleSize: req.data.SampleSize || null
      });
    });

    return super.init();
  }
};
