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
  PROPERTIES, PROPERTY_TEXT, REQUEST_TYPES, REQUEST_TYPE_TEXT, ROLES, ROLE_TEXT,
  fieldPropertyTree, normaliseSettings
} = require('./checks/field-properties');

const RULES = 'mdmlight.config.DuplicateRules';
const VALIDATIONS = 'mdmlight.config.ValidationRules';
const DERIVATIONS = 'mdmlight.config.DerivationRules';
const PROFILES = 'mdmlight.config.FieldPropertyProfiles';
const SETTINGS = 'mdmlight.config.FieldPropertySettings';

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

    // Same treatment for both tables: a rule the engine cannot evaluate is caught at the keyboard,
    // because by check time the answer has already been given. Only the validator differs.
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

    // Straight from the code-defined catalog, never a hand-kept UI copy. Re-reads the ruleset too, so
    // the page can say whether the configured rules are running or the defaults are.
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

    // Fields from the staging model, comparisons and severities from the engine, so nothing goes stale.
    // The counts are of rules that WOULD run - active and valid - so a skipped row can be named.
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

    // The condition pair is the whole of a profile's matching, so a value outside the closed list
    // makes a profile that can never fire - and looks configured while doing nothing.
    this.before(['CREATE', 'UPDATE'], 'FieldPropertyProfiles', (req) => {
      const { requestType, role } = req.data;
      if (requestType !== undefined && requestType !== null && !REQUEST_TYPES.includes(requestType)) {
        req.error(400, `“${requestType}” is not a request type. Use * for every type.`, 'requestType');
      }
      if (role !== undefined && role !== null && !ROLES.includes(role)) {
        req.error(400, `“${role}” is not a role. Use * for every role.`, 'role');
      }
    });

    // The entity/field tree and the two closed lists, generated from the staging model so a new node
    // shows up in the dialog without anyone editing the UI.
    this.on('fieldPropertyOptions', () => ({
      entities: fieldPropertyTree(),
      properties: PROPERTIES.map((code) => ({ code, text: PROPERTY_TEXT[code] || code })),
      requestTypes: REQUEST_TYPES.map((code) => ({ code, text: REQUEST_TYPE_TEXT[code] || code })),
      roles: ROLES.map((code) => ({ code, text: ROLE_TEXT[code] || code }))
    }));

    this.on('fieldPropertiesOf', async (req) => {
      const rows = await cds.run(
        cds.ql.SELECT.from(SETTINGS)
          .columns('section', 'element', 'property')
          .where({ profile_ID: req.data.Profile })
      );
      return JSON.stringify(rows || []);
    });

    // Wholesale replace: the dialog always sends the complete state of the profile, so rewriting
    // beats diffing and no stale row can survive a field being unticked.
    this.on('saveFieldProperties', async (req) => {
      const profile = req.data.Profile;
      const stored = await cds.run(cds.ql.SELECT.one.from(PROFILES).where({ ID: profile }));
      if (!stored) return req.reject(404, `Profile ${profile} was not found. Save it before setting its fields.`);

      let parsed;
      try {
        parsed = JSON.parse(req.data.SettingsJson || '[]');
      } catch (error) {
        return req.reject(400, `SettingsJson is not valid JSON: ${error.message}`);
      }
      if (!Array.isArray(parsed)) return req.reject(400, 'SettingsJson must be an array of settings.');

      const { settings, errors } = normaliseSettings(parsed);
      // Refused, not filtered: a dialog sending an unknown field is a bug, and storing the rest
      // would leave a profile that is quietly missing what someone thought they set.
      if (errors.length) return req.reject(400, errors.join(' '));

      await cds.run(cds.ql.DELETE.from(SETTINGS).where({ profile_ID: profile }));
      if (settings.length) {
        await cds.run(cds.ql.INSERT.into(SETTINGS).entries(
          settings.map((setting) => ({ ...setting, profile_ID: profile }))
        ));
      }
      return { Profile: profile, Saved: settings.length };
    });

    // Delegated to BusinessPartnerService, which owns the S/4 connection and the one name index: a
    // second index here would be a second duplicate check by the back door.
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
