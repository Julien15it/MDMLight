using { mdmlight.config as config } from '../db/duplicate-rules';
using { mdmlight.config as quality } from '../db/quality-rules';
using { mdmlight.config as features } from '../db/feature-settings';
using { mdmlight.config as fieldprops } from '../db/field-properties';
using { mdmlight.config as workflow } from '../db/workflow-rules';

/**
 * Data-steward configuration for the quality controls and for approval routing. Separate from
 * BusinessPartnerService
 * because it is a control over local tables, maintained by different people. The path keeps its
 * original name: it is in xs-app.json and the deployed approuter config, so renaming it costs a
 * route change to gain nothing - and one service means one `@requires` and no second destination.
 */
@path: '/service/duplicateconfig'
@requires: 'Steward'
service DuplicateConfigService {

  entity DuplicateRules  as projection on config.DuplicateRules;
  entity ValidationRules as projection on quality.ValidationRules;
  entity DerivationRules as projection on quality.DerivationRules;

  /** Who approves what. Read on every submit to build the `approvers` list in the workflow context. */
  entity WorkflowRules   as projection on workflow.WorkflowRules;

  /** One condition of a WorkflowRules row - as many as that rule needs, added/removed one at a time
   *  from the page rather than replaced wholesale, so this is plain CRUD like WorkflowRules itself,
   *  not an action like saveFieldProperties. */
  entity WorkflowRuleConditions as projection on workflow.WorkflowRuleConditions;

  /** The profile header. Its settings are written through `saveFieldProperties`, not by binding the
   *  composition: the dialog replaces the whole set in one call. */
  entity FieldPropertyProfiles as projection on fieldprops.FieldPropertyProfiles;

  /** Read-mostly here - the list reads it to say how many properties a profile carries. */
  entity FieldPropertySettings as projection on fieldprops.FieldPropertySettings;

  /** Key/text, not bare strings: those do not bind reliably in a cell, which emptied the dropdowns. */
  // `code`/`text`, not `key`/`text`: `key` is a CDS keyword and prefixes a key
  // element, so `key : String(40)` does not compile.
  type CatalogField {
    code        : String(40);
    text        : String(60);
    /** False means the duplicate index does not carry it, so a rule over this
     *  field cannot match an existing partner. The UI has to say so. */
    indexed     : Boolean;
  }

  type Option {
    code        : String(20);
    text        : String(60);
  }

  type RuleOptions {
    fields      : array of CatalogField;
    comparisons : array of Option;
    indicators  : array of Option;
    /** AND / OR / NOR - how the two condition pairs are joined. One list for all four rule tables;
     *  see CONDITION_LOGIC in srv/checks/value-lists.js. */
    conditionLogics : array of Option;
    /** 'configured' or 'defaults'. The page must say which: an empty grid reads as "check is off". */
    source      : String(12);
    ruleCount   : Integer;
  }

  /** Everything the admin grid needs to offer valid choices, straight from the
   *  code-defined catalog - never a hand-kept copy in the UI. */
  function ruleOptions() returns RuleOptions;

  /** Counts per verdict plus sample pairs, without saving. `RulesJson` takes unsaved grid state. */
  action testRuleset(
    RulesJson  : LargeString,
    SampleSize : Integer
  ) returns LargeString;

  /** A qualified payload field. Wider than `CatalogField.code` (it carries the section) and separate
   *  from it, because `indexed` is a duplicate-index concern that means nothing here. */
  type PayloadField {
    code    : String(60);
    text    : String(120);
    /** Section id, so the grid can group or filter the list without re-splitting
     *  the code on the client. */
    section : String(40);
    /** CDS type of the element, e.g. String, Boolean, Date. What lets the grid
     *  say a comparison like `<` is being asked of a Boolean. */
    type    : String(20);
  }

  /** False lets the grid disable the Value cell rather than accept a value it will ignore. */
  type ComparisonOption {
    code       : String(20);
    text       : String(60);
    needsValue : Boolean;
  }

  type QualityRuleOptions {
    fields          : array of PayloadField;
    comparisons     : array of ComparisonOption;
    conditionLogics : array of Option;
    severities      : array of Option;
    validationCount : Integer;
    derivationCount : Integer;
  }

  /** Generated from the staging model and the engine, never a hand-kept UI copy. The counts are of
   *  rules that would actually run, so a page can say when a saved row is being skipped. */
  function qualityRuleOptions() returns QualityRuleOptions;

  /** One entry in the approver picker - a BTP role collection or a BTP user, told apart by `type`
   *  because the value alone does not say which (a role collection name and a user name are both
   *  free text). See srv/wf/btp-agents.js. */
  type Agent {
    type  : String enum { Role; User; };
    value : String;
  }

  type WorkflowRuleOptions {
    /** The same qualified payload catalog the quality rules use - a condition names a payload field. */
    fields       : array of PayloadField;
    /** The BTP subaccount's role collections (Description starting with `MDMLIGHT` only) and users,
     *  for the approver picker. An approver may also be typed as a free-text e-mail address, which
     *  needs no list either way. Best-effort: an unreachable subaccount API leaves this empty rather
     *  than failing the page. */
    agents       : array of Agent;
    /** All four CR types. No `*`: an approver list is not something to default. */
    requestTypes : array of Option;
    /** `Approve` today. A column rather than an assumption - see db/workflow-rules.cds. */
    steps        : array of Option;
    conditionLogics : array of Option;
    /** The same operator vocabulary ValidationRules/DerivationRules already offer for their own
     *  comparison column (`eq`/`ne`/`lt`/`le`/`gt`/`ge`/`contains`/`empty`/`notEmpty`) - asked for
     *  directly rather than a smaller, WorkflowRules-only set. `needsValue: false` for the two that
     *  take no value at all ("is empty"/"is not empty"), so the page can hide that cell. */
    comparisons  : array of ComparisonOption;
    /** Rules that would actually run, so the page can say when a saved row is being skipped. */
    ruleCount    : Integer;
  }

  /** Everything the workflow rule page needs to offer valid choices, generated, never hand-kept. */
  function workflowRuleOptions() returns WorkflowRuleOptions;

  /** One field of an entity, as the property dialog lists it under its parent. */
  type FieldPropertyField {
    /** Qualified, e.g. `Addresses.Country` - what a setting is stored against. */
    field   : String(60);
    element : String(60);
    text    : String(120);
  }

  /** An entity and the fields the dialog opens up underneath it. */
  type FieldPropertyEntity {
    section : String(40);
    text    : String(120);
    fields  : array of FieldPropertyField;
  }

  type FieldPropertyOptions {
    /** The whole payload model, entity by entity - the dialog renders this and nothing else. */
    entities     : array of FieldPropertyEntity;
    /** mandatory / readOnly / hidden / optional, in the order the columns are drawn. */
    properties   : array of Option;
    /** Both condition dropdowns, `*` included as the first entry. */
    requestTypes : array of Option;
    roles        : array of Option;
  }

  /** Everything the field property page needs: the entity/field tree from the staging model, and
   *  the closed lists behind the two condition dropdowns. Never a hand-kept copy in the UI. */
  function fieldPropertyOptions() returns FieldPropertyOptions;

  /** A profile's settings as `[{ section, element, property, critical }]`. `element` is null for a
   *  setting that applies to the whole entity - which is the only level `critical` may be true on.
   *  One call, because the dialog needs them all at once. */
  function fieldPropertiesOf(
    Profile : UUID not null
  ) returns LargeString;

  /**
   * Replaces a profile's settings wholesale with `SettingsJson` - the dialog always sends the
   * complete state, so rewriting beats diffing and no stale row can survive. An unknown entity,
   * field or property is refused rather than stored: a setting that resolves to nothing looks
   * configured and does nothing.
   */
  action saveFieldProperties(
    Profile      : UUID not null,
    SettingsJson : LargeString not null
  ) returns {
    Profile : UUID;
    /** How many rows the profile now carries. */
    Saved   : Integer;
  };

  type FeatureSwitches {
    /** False means no call reaches a language model anywhere in the app. */
    aiAssistanceEnabled : Boolean;
  }

  /** The installation's feature switches. Reports the effective values, so an
   *  installation that has never saved a setting reads as everything on rather
   *  than as an empty response the page would have to interpret. */
  function featureSettings() returns FeatureSwitches;

  /** Turns AI assistance on or off for the whole installation. An action rather
   *  than a writable entity because the settings row is a singleton: a PATCH
   *  needs it to exist already, and nothing should have to create it first. */
  action setAiAssistanceEnabled(
    Enabled : Boolean not null
  ) returns FeatureSwitches;
}
