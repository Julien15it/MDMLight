'use strict';

const cds = require('@sap/cds');
const { catalogFields, validateRule } = require('./ai/rule-config');
const { ruleStore, refreshRules } = require('./ai/duplicate-check');
const { INDICATORS } = require('./ai/duplicate-engine');

const RULES = 'mdmlight.config.DuplicateRules';

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
