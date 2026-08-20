using { mdmlight.config as config } from '../db/duplicate-rules';
using { mdmlight.config as quality } from '../db/quality-rules';
using { mdmlight.config as features } from '../db/feature-settings';

/**
 * Data-steward configuration for the data quality controls - the duplicate check
 * and, since 2026-08-19, the validation and derivation tables. Separate from
 * BusinessPartnerService because it is a control, maintained by different people
 * with a different scope, over local tables rather than the S/4 facade.
 *
 * The three tables share this service, and the path keeps its original name on
 * purpose: `/service/duplicateconfig` is in `app/mdmrules/xs-app.json` and in the
 * deployed approuter config, so renaming it would cost a route change and a
 * redeploy to gain nothing. One service also means one `@requires: 'Steward'`
 * and no second destination.
 */
@path: '/service/duplicateconfig'
@requires: 'Steward'
service DuplicateConfigService {

  entity DuplicateRules  as projection on config.DuplicateRules;
  entity ValidationRules as projection on quality.ValidationRules;
  entity DerivationRules as projection on quality.DerivationRules;

  /** Every list is key/text so the grid binds them all the same way. Arrays of
   *  bare strings do not bind reliably in a table cell, which is what left the
   *  first version of this page with three empty dropdowns. */
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

  /** A qualified payload field: `General.Language`, `Addresses.Country`. Wider
   *  than `CatalogField.code` because it carries the section, and separate from it
   *  because `indexed` is a duplicate-index concern that means nothing here. */
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

  /** `needsValue` false means the Value cell is meaningless for that comparison,
   *  which is what lets the grid disable it rather than accept a value it will
   *  silently ignore. */
  type ComparisonOption {
    code       : String(20);
    text       : String(60);
    needsValue : Boolean;
  }

  type QualityRuleOptions {
    fields          : array of PayloadField;
    comparisons     : array of ComparisonOption;
    severities      : array of Option;
    validationCount : Integer;
    derivationCount : Integer;
  }

  /** Everything the validation and derivation grids need, generated from the
   *  staging model and the engine - never a hand-kept copy in the UI. The counts
   *  are of rules that would actually run, so a page can say when a saved row is
   *  being skipped. */
  function qualityRuleOptions() returns QualityRuleOptions;

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
