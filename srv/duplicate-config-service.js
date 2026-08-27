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
const { CONDITION_LOGIC } = require('./checks/value-lists');
const {
  ENTITY: FEATURES, SINGLETON_ID, forgetCachedSettings
} = require('./ai/availability');
const {
  PROPERTIES, PROPERTY_TEXT, REQUEST_TYPES, REQUEST_TYPE_TEXT, ROLES, ROLE_TEXT, LEGACY_ROLES,
  fieldPropertyTree, normaliseSettings
} = require('./checks/field-properties');
const fieldPropertyStore = require('./checks/field-property-store');
const {
  REQUEST_TYPES: WORKFLOW_REQUEST_TYPES, REQUEST_TYPE_TEXT: WORKFLOW_REQUEST_TYPE_TEXT,
  STEPS, STEP_TEXT, validateWorkflowRule, runnableWorkflowRules
} = require('./checks/workflow-rules');
const workflowRuleStore = require('./checks/workflow-rule-store');
const { workflowAgents } = require('./wf/btp-agents');

const RULES = 'mdmlight.config.DuplicateRules';
const VALIDATIONS = 'mdmlight.config.ValidationRules';
const DERIVATIONS = 'mdmlight.config.DerivationRules';
const PROFILES = 'mdmlight.config.FieldPropertyProfiles';
const SETTINGS = 'mdmlight.config.FieldPropertySettings';
const WORKFLOW_RULES = 'mdmlight.config.WorkflowRules';

const SEVERITY_TEXT = Object.freeze({
  error: 'Error — blocks the request',
  warning: 'Warning — reports, but allows',
  info: 'Information only'
});

// `raw_dice` is the unsmoothed scorer kept for comparison work; offering it to a steward would be
// a fourth choice nobody can tell apart from `fuzzy`. It still evaluates if a stored row uses it.
// One list, three pages: the join is the same question wherever two conditions meet.
const CONDITION_LOGIC_OPTIONS = Object.entries(CONDITION_LOGIC)
  .map(([code, logic]) => ({ code, text: logic.text }));

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
    const guard = (entity, table, validate, markStale = qualityRules.markStale) => {
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
      this.after(['CREATE', 'UPDATE', 'DELETE'], entity, () => markStale());
    };

    guard('ValidationRules', VALIDATIONS, validateValidationRule);
    guard('DerivationRules', DERIVATIONS, validateDerivationRule);
    // Same treatment again, and for the same reason: by submit time the approvers have already gone
    // to SBPA, so a row that cannot resolve has to be caught at the keyboard. Its own store, though.
    guard('WorkflowRules', WORKFLOW_RULES, validateWorkflowRule, workflowRuleStore.markStale);

    // The payload catalog again - a condition names a payload field, so the two pages offer the same
    // list - plus the two closed lists and the count of rows that would actually run.
    this.on('workflowRuleOptions', async () => {
      let ruleCount = null;
      try {
        const stored = await cds.run(cds.ql.SELECT.from(WORKFLOW_RULES));
        ruleCount = runnableWorkflowRules(stored || []).length;
      } catch (error) {
        // A count is a nicety; the page still has to load and let someone fix the table.
        console.warn('[workflow-rules] Could not count the runnable workflow rules:', error.message);
      }
      return {
        fields: payloadFields().map(({ field, text, section, type }) => ({
          code: field, text, section, type
        })),
        requestTypes: WORKFLOW_REQUEST_TYPES.map((code) => ({
          code, text: WORKFLOW_REQUEST_TYPE_TEXT[code] || code
        })),
        steps: STEPS.map((code) => ({ code, text: STEP_TEXT[code] || code })),
        conditionLogics: CONDITION_LOGIC_OPTIONS,
        // The subaccount's own role collections (MDMLIGHT* only) and users - see srv/wf/btp-agents.js
        // and CLAUDE.md "Workflow Agent Determination". Not this app's own Requester/Approver/
        // DataSteward roles: those are what the Field Property Profiles page still conditions on
        // (ROLES/ROLE_TEXT, unchanged), a different concept entirely.
        agents: await workflowAgents(),
        ruleCount
      };
    });

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
        conditionLogics: CONDITION_LOGIC_OPTIONS,
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
        conditionLogics: CONDITION_LOGIC_OPTIONS,
        severities: SEVERITIES.map((code) => ({ code, text: SEVERITY_TEXT[code] || code })),
        validationCount: await runnable(VALIDATIONS, validateValidationRule),
        derivationCount: await runnable(DERIVATIONS, validateDerivationRule)
      };
    });

    // Any write drops the resident profiles, the same way a rule write drops the rule store.
    for (const entity of ['FieldPropertyProfiles', 'FieldPropertySettings']) {
      this.after(['CREATE', 'UPDATE', 'DELETE'], entity, () => fieldPropertyStore.markStale());
    }

    // The condition pair is the whole of a profile's matching, so a value outside the closed list
    // makes a profile that can never fire - and looks configured while doing nothing.
    this.before(['CREATE', 'UPDATE'], 'FieldPropertyProfiles', async (req) => {
      const { requestType, role } = req.data;
      if (requestType !== undefined && requestType !== null && !REQUEST_TYPES.includes(requestType)) {
        req.error(400, `“${requestType}” is not a request type. Use * for every type.`, 'requestType');
      }
      if (role !== undefined && role !== null && !ROLES.includes(role) && !LEGACY_ROLES.includes(role)) {
        // Not `*`/Requester and not a grandfathered legacy value - it may still be a BTP role
        // collection, the same source the approval role picker offers. Checked live rather than
        // trusted blindly: a role collection deleted or renamed in the subaccount must not leave a
        // typo silently stored as a profile that looks configured and never matches.
        const agents = await workflowAgents();
        const isKnownAgentRole = agents.some((agent) => (
          agent.type === 'Role' && agent.value === role && agent.value.toUpperCase() !== 'MDMLIGHT'
        ));
        if (!isKnownAgentRole) {
          req.error(400, `“${role}” is not a role. Use * for every role.`, 'role');
        }
      }
    });

    // The entity/field tree and the two closed lists, generated from the staging model so a new node
    // shows up in the dialog without anyone editing the UI.
    this.on('fieldPropertyOptions', async () => ({
      entities: fieldPropertyTree(),
      properties: PROPERTIES.map((code) => ({ code, text: PROPERTY_TEXT[code] || code })),
      requestTypes: REQUEST_TYPES.map((code) => ({ code, text: REQUEST_TYPE_TEXT[code] || code })),
      // `*` and `Requester` stay hard-coded (ROLES/ROLE_TEXT). `Approver` and `DataSteward` are no
      // longer fixed values (2026-08-27) - the subaccount's own MDMLIGHT-prefixed role collections
      // fill that slot instead, sourced exactly like the Workflow Agent Determination picker (see
      // srv/wf/btp-agents.js). A role whose name starts with "Approver"/"DataSteward"/"Requester" is
      // matched against that screen category by profileMatches (srv/checks/field-properties.js), so a
      // steward can eventually scope a profile to a specific approver function rather than the one
      // blanket Approver screen - see CLAUDE.md for the runtime gap this does not close on its own.
      //
      // The bare "MDMLIGHT" role collection itself is excluded here: it is the catalog-level role
      // covering this app as a whole, not a functional Requester/Approver/DataSteward-shaped one, and
      // offering it would let a profile be scoped to "everyone with any access to this app" while
      // looking like a deliberate, narrow choice.
      roles: [
        ...ROLES.map((code) => ({ code, text: ROLE_TEXT[code] || code })),
        ...(await workflowAgents())
          .filter((agent) => agent.type === 'Role' && agent.value.toUpperCase() !== 'MDMLIGHT')
          .map((agent) => ({ code: agent.value, text: agent.value }))
      ]
    }));

    this.on('fieldPropertiesOf', async (req) => {
      const rows = await cds.run(
        cds.ql.SELECT.from(SETTINGS)
          .columns('section', 'element', 'property', 'critical')
          .where({ profile_ID: req.data.Profile })
      );
      // Critical is only ever EDITABLE from a Requester-scoped profile (see resolveProfiles in
      // field-properties.js), but the Modify dialog for every OTHER role still shows the box, read-
      // only - and a box that always renders unticked there would not be "read-only", it would just
      // be wrong. This reflects what a matching Requester profile actually marked critical, by
      // reusing the exact same resolution the running app renders "!" from, so the config screen and
      // the app can never disagree about what critical means for the request type this profile is for.
      // Entity-level only, like critical itself (validateSetting refuses a field-level critical row),
      // so only criticalEntities is worth carrying over here - the field-level half of that resolved
      // shape is the same abandoned-column tolerance covered elsewhere and has no bearing on this
      // reflection.
      let requesterCritical = { entities: [] };
      try {
        const own = await cds.run(
          cds.ql.SELECT.one.from(PROFILES).columns('requestType').where({ ID: req.data.Profile })
        );
        const resolved = await fieldPropertyStore.resolvedProperties({
          requestType: own && own.requestType,
          role: 'Requester'
        });
        requesterCritical = { entities: resolved.criticalEntities || [] };
      } catch (error) {
        // Best-effort: the dialog still has to open and let a steward see/change the properties even
        // if this extra reflection could not be built.
        console.warn('[field-properties] Could not resolve the Requester-critical reflection:', error.message);
      }
      return JSON.stringify({ settings: rows || [], requesterCritical });
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
      fieldPropertyStore.markStale();
      return { Profile: profile, Saved: settings.length };
    });

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
