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

  /** Every list is key/text so the grid binds them all the same way. Arrays of
   *  bare strings do not bind reliably in a table cell, which is what left the
   *  first version of this page with three empty dropdowns. */
  type CatalogField {
    key         : String(40);
    text        : String(60);
    /** False means the duplicate index does not carry it, so a rule over this
     *  field cannot match an existing partner. The UI has to say so. */
    indexed     : Boolean;
  }

  type Option {
    key         : String(20);
    text        : String(60);
  }

  type RuleOptions {
    fields      : array of CatalogField;
    comparisons : array of Option;
    indicators  : array of Option;
    /** 'configured' or 'defaults'. An empty or unusable table falls back to the
     *  built-in rules, and the page has to say so - an empty grid otherwise
     *  reads as "the check is off", which it never is. */
    source      : String(12);
    ruleCount   : Integer;
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
