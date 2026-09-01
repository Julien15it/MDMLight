namespace mdmlight.config;

using { managed } from '@sap/cds/common';

/**
 * One row is one duplicate-check criterion, BRF+ decision-table style. Empty
 * condition columns mean "any". See docs/duplicate-check-config.md - the design
 * lives there, this file is only its shape.
 *
 * Config lives in rows, not columns, so adding a criterion is an INSERT. A
 * column-per-criterion model would make every removed criterion a failed
 * deployment, because cds-deploy refuses to drop elements.
 */
entity DuplicateRules : managed {
  key ID          : UUID;

      /** Orders the admin grid for reading. Carries no semantics: rows are
       *  additive and the strongest indicator wins, so re-sorting can never
       *  change a verdict. */
      sequence    : Integer default 10;

      /** Two conditions, each a field from the same catalog the rule targets:
       *  conditionField = Country, conditionValue = BE. Null means "any", and
       *  the pairs are independent - neither, either or both may be filled.
       *  Both filled means AND: "Role = Vendor and Country = BE". Every filled
       *  condition must hold on both records of the pair before the rule
       *  participates. */
      conditionField : String(40);
      conditionValue : String(60);
      conditionLogic : String(3) default 'AND';
      conditionField2 : String(40);
      conditionValue2 : String(60);

      /**
       * **Three more fixed slots (2026-09-01)**, the same rollout `WorkflowRules` got the same day:
       * an "Add Condition" button reveals the next Logic/Condition column pair, and the page draws
       * only as many as a rule uses. Columns rather than a composition - `cds-deploy` can add an
       * element and can neither drop nor retype one, which this table has already paid for once
       * with the four `cond*` columns below.
       *
       * `conditionLogicN` joins slot N to slot N+1, so `conditionLogic` (unnumbered, above) stays
       * the 1-to-2 join. The conditions fold LEFT TO RIGHT - see `foldConditions` in
       * srv/checks/value-lists.js.
       */
      conditionLogic2 : String(3) default 'AND';
      conditionField3 : String(40);
      conditionValue3 : String(60);
      conditionLogic3 : String(3) default 'AND';
      conditionField4 : String(40);
      conditionValue4 : String(60);
      conditionLogic4 : String(3) default 'AND';
      conditionField5 : String(40);
      conditionValue5 : String(60);

      // Superseded 2026-08-12 by the generic pair above, and unused. They stay
      // because cds-deploy refuses to drop elements: removing them would fail
      // every deployment from here on. Do not write to them.
      condCountry  : String(3);
      condCategory : String(1);
      condGrouping : String(4);
      condRole     : String(6);

      /** Field-catalog name, e.g. Name, TaxNumber, TaxNumber.BE0, PostalCode.
       *  Validated on save against the code-defined catalog. */
      field       : String(40) not null;

      comparison  : String(20) not null;

      /** Required for fuzzy comparisons, meaningless for exact ones. */
      threshold   : Decimal(3, 2);

      indicator   : String(12) not null;

      isActive    : Boolean default true;
}
