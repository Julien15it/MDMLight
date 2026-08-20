namespace mdmlight.config;

using { managed } from '@sap/cds/common';

/**
 * BRF+ decision tables, the same shape as `DuplicateRules`: rows not columns, because adding a
 * criterion must be an INSERT - cds-deploy refuses to drop elements. Fields are qualified PAYLOAD
 * fields (`General.Language`), not duplicate-catalog names; see srv/checks/payload-fields.js.
 */

/** Both rule kinds carry the same conditions, so they are described once. */
aspect ruleConditions {
      /** Grid order only. Rules are independent, except two derivations on one field: first wins. */
      sequence        : Integer default 10;

      /** Two independent pairs; null means "any", both filled means AND. A condition on the rule's
       *  own section is evaluated per row, so it narrows to the matching rows. */
      conditionField  : String(60);
      conditionValue  : String(120);
      conditionField2 : String(60);
      conditionValue2 : String(120);

      isActive        : Boolean default true;
}

/**
 * One row is one assertion: "where Country is BE, Language must be NL". An empty field does not fire -
 * `notEmpty` says required - because validations run before the derivation that would have filled it.
 */
entity ValidationRules : managed, ruleConditions {
  key ID         : UUID;

      /** Qualified payload field being validated, e.g. General.Language. */
      field      : String(60) not null;

      /** eq, ne, lt, le, gt, ge, contains, empty, notEmpty - see
       *  srv/checks/rule-engine.js, which is the one place they are defined. */
      comparison : String(12) not null;

      /** Compared against. A value resolving to a payload field compares the two fields instead. */
      value      : String(120);

      /** 'error' blocks, 'warning' and 'info' report. Not optional: without it everything blocks. */
      severity   : String(10) default 'error';
}

/**
 * One row is one gap-filler: "where Country is BE, fill Language with NL". A derivation never
 * overwrites (pipeline.js enforces that, not this table) and never auto-applies - the requester ticks it.
 */
entity DerivationRules : managed, ruleConditions {
  key ID    : UUID;

      /** Qualified payload field being filled, e.g. General.Language. */
      field : String(60) not null;

      /** A value resolving to a payload field copies that field; catalog names are always dotted,
       *  so a literal can never be mistaken for one. */
      value : String(120) not null;

      /**
       * Adds the row instead of only filling one that is already there.
       *
       * Off, a derivation is a gap-filler: it needs a row to write into, and a purchasing
       * organisation nobody added yet is a value with nowhere to go. On, the rule proposes
       * the row itself - "role FLVN01 in BE means purchasing organisation 1710" - so the
       * requester no longer has to add the line before the rule can say anything about it.
       *
       * Idempotent: a section that already holds a row with this value is left alone, so
       * checking twice does not add the row twice, and a requester who added it by hand
       * keeps their own.
       *
       * To fill more fields on that row, add ordinary derivations on the same section. The
       * row-adding rules run as their own stage, before the gap-fillers, so a filler always
       * finds the row this rule proposed. `sequence` therefore orders rules within each
       * kind, not across them - adding cannot be made to follow filling, because that would
       * only ever fill rows nobody added.
       */
      createsRow : Boolean default false;
}
