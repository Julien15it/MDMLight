'use strict';

const cds = require('@sap/cds');
const { catalogFields, validateRule } = require('./ai/rule-config');
const { ruleStore, refreshRules } = require('./ai/duplicate-check');
const { INDICATORS } = require('./ai/duplicate-engine');
const { payloadFields } = require('./checks/payload-fields');
const {
  COMPARISONS, SEVERITIES, validateValidationRule, validateDerivationRule
} = require('./checks/rule-engine');
const qualityRules = require('./checks/rule-store');
const {
  ENTITY: FEATURES, SINGLETON_ID, forgetCachedSettings
} = require('./ai/availability');

const RULES = 'mdmlight.config.DuplicateRules';
const VALIDATIONS = 'mdmlight.config.ValidationRules';
const DERIVATIONS = 'mdmlight.config.DerivationRules';

const SEVERITY_TEXT = Object.freeze({
  error: 'Error — blocks the request',
  warning: 'Warning — reports, but allows',
  info: 'Information only'
});

// `raw_dice` is the unsmoothed scorer kept for comparison work; offering it to a steward would be
// a fourth choice nobody can tell apart from `fuzzy`. It still evaluates if a stored row uses it.
const OFFERED_COMPARISONS = Object.freeze(['exact', 'fuzzy', 'contains']);

const COMPARISON_TEXT = Object.freeze({
  exact: 'Exact — equal after normalisation',
  fuzzy: 'Fuzzy — similar name or value',
  contains: 'Contains — one value contains the other'
});

const INDICATOR_TEXT = Object.freeze({
  weak: 'Weak — only counts alongside another match',
  strong: 'Strong',
  definitive: 'Definitive — a match on its own',
  disqualifying: 'Rules out a match — different values mean different companies'
});

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

    /**
     * The validation and derivation tables get the same treatment, and for the same reason: a rule
     * the engine cannot evaluate is caught at the keyboard, because by check time the answer has
     * already been given. The two differ only in which validator they hand the row to.
     */
    const guard = (entity, table, validate) => {
      this.before(['CREATE', 'UPDATE'], entity, async (req) => {
        // A patch carries only what changed, so it is validated against the stored row it lands on.
        let stored = null;
        if (req.event === 'UPDATE' && req.data.ID) {
          try {
            stored = await cds.run(cds.ql.SELECT.one.from(table).where({ ID: req.data.ID }));
          } catch (error) {
            console.warn(`[quality-rules] Could not read the stored ${entity} row to validate against:`, error.message);
          }
        }
        const { errors, warnings } = validate({ ...(stored || {}), ...req.data });
        for (const warning of warnings) req.info(200, warning.message, warning.field);
        for (const error of errors) req.error(400, error.message, error.field);
      });
      this.after(['CREATE', 'UPDATE', 'DELETE'], entity, () => qualityRules.markStale());
    };

    guard('ValidationRules', VALIDATIONS, validateValidationRule);
    guard('DerivationRules', DERIVATIONS, validateDerivationRule);

    // Straight from the code-defined catalog, never a copy the UI keeps in step by hand. It also
    // re-reads the ruleset, so the page can report honestly whether the configured rules are the
    // ones actually running or whether it has fallen back to the defaults.
    this.on('ruleOptions', async () => {
      await refreshRules(async () => cds.run(cds.ql.SELECT.from(RULES)), { force: true });
      return {
        fields: catalogFields().map(({ field, indexed }) => ({
          code: field,
          text: indexed ? field : `${field} (not indexed)`,
          indexed
        })),
        comparisons: OFFERED_COMPARISONS.map((code) => ({ code, text: COMPARISON_TEXT[code] || code })),
        indicators: INDICATORS.map((code) => ({ code, text: INDICATOR_TEXT[code] || code })),
        source: ruleStore.source(),
        ruleCount: ruleStore.rules().length
      };
    });

    /**
     * The validation and derivation grids' choices. Fields come from the staging model via
     * `payloadFields`, comparisons and severities from the engine — so the dropdowns are the true
     * ones and there is no second copy to go stale.
     *
     * The counts are of rules that **would actually run**: active, and passing the same validator
     * the save uses. A steward who has saved eight rules and is told six are running has learned
     * something an empty banner would never have told them.
     */
    this.on('qualityRuleOptions', async () => {
      const runnable = async (table, validate) => {
        try {
          const stored = await cds.run(cds.ql.SELECT.from(table));
          return (stored || [])
            .filter((row) => row.isActive !== false)
            .filter((row) => !validate(row).errors.length).length;
        } catch (error) {
          // A count is a nicety; the page still has to load and let someone fix the table.
          console.warn(`[quality-rules] Could not count the runnable rules in ${table}:`, error.message);
          return null;
        }
      };
      return {
        fields: payloadFields().map(({ field, text, section, type }) => ({
          code: field, text, section, type
        })),
        comparisons: Object.entries(COMPARISONS).map(([code, comparison]) => ({
          code, text: comparison.text.trim(), needsValue: comparison.needsValue
        })),
        severities: SEVERITIES.map((code) => ({ code, text: SEVERITY_TEXT[code] || code })),
        validationCount: await runnable(VALIDATIONS, validateValidationRule),
        derivationCount: await runnable(DERIVATIONS, validateDerivationRule)
      };
    });

    /**
     * Delegated to BusinessPartnerService, which owns the S/4 connection and the one resident
     * name index. Standing up a second index here would be a second duplicate check by the back
     * door — exactly what the one-engine requirement forbids.
     */
    /**
     * Reports the effective switches, not the stored row. An installation that
     * has never saved a setting has no row at all, and the page must read that
     * as "on" rather than as a blank it has to guess about - the same default
     * srv/ai/availability.js applies on the enforcing side.
     */
    this.on('featureSettings', async () => {
      const row = await cds.run(cds.ql.SELECT.one.from(FEATURES).where({ ID: SINGLETON_ID }));
      return { aiAssistanceEnabled: row?.aiAssistanceEnabled !== false };
    });

    this.on('setAiAssistanceEnabled', async (req) => {
      const enabled = req.data.Enabled === true;
      // UPSERT rather than an UPDATE guarded by a SELECT: two stewards saving at
      // once would otherwise both find no row and both insert one.
      await cds.run(cds.ql.UPSERT.into(FEATURES).entries({
        ID: SINGLETON_ID,
        aiAssistanceEnabled: enabled
      }));
      // Otherwise the enforcing side keeps its cached answer for up to the TTL and
      // the steward's own next request still sees the old setting.
      forgetCachedSettings();
      console.log(`[features] AI assistance switched ${enabled ? 'on' : 'off'}.`);
      return { aiAssistanceEnabled: enabled };
    });

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
