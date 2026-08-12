using { mdmlight.config as config } from '../db/duplicate-rules';

/**
 * Data-steward configuration for the duplicate check. Separate from
 * BusinessPartnerService because it is a control, maintained by different people
 * with a different scope, over a local table rather than the S/4 facade.
 */
@path: '/service/duplicateconfig'
@requires: 'Steward'
service DuplicateConfigService {

  entity DuplicateRules as projection on config.DuplicateRules;

  type CatalogField {
    field       : String(40);
    /** False means the duplicate index does not carry it, so a rule over this
     *  field cannot match an existing partner. The UI has to say so. */
    indexed     : Boolean;
  }

  type RuleOptions {
    fields      : array of CatalogField;
    comparisons : array of String;
    indicators  : array of String;
    conditions  : array of String;
  }

  /** Everything the admin grid needs to offer valid choices, straight from the
   *  code-defined catalog - never a hand-kept copy in the UI. */
  function ruleOptions() returns RuleOptions;

  /** Runs a ruleset over the whole partner index and reports counts per verdict
   *  plus sample pairs, without saving. `RulesJson` is optional: pass the
   *  unsaved grid state to see a change before committing it. */
  action testRuleset(
    RulesJson  : LargeString,
    SampleSize : Integer
  ) returns LargeString;
}
