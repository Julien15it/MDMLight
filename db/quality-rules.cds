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

      /** Two independent pairs; null means "any". A condition on the rule's own section is
       *  evaluated per row, so it narrows to the matching rows. `conditionLogic` joins them when
       *  both are filled - AND, OR or NOR - and a null reads as AND, which is what every row
       *  stored before 2026-08-27 means. A value may carry `*` as a wildcard. */
      conditionField  : String(60);
      conditionValue  : String(120);
      conditionLogic  : String(3) default 'AND';
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
       * Superseded, and kept only because `cds-deploy` refuses to drop an element - the same reason
       * `DuplicateRules` still carries its four `cond*` columns. **Nothing reads it. Do not write
       * to it.**
       *
       * It was the opt-in for a rule that adds its row instead of filling one (2026-08-20). The
       * merged design takes the trigger from the payload instead: a rule whose target section holds
       * no rows proposes the row, one whose section has rows fills its gaps. Dropping the column
       * failed the database deployer, because it had already reached the deployed model.
       */
      createsRow : Boolean default false;
}
