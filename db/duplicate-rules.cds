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

      /** One condition, expressed as a field from the same catalog the rule
       *  targets: conditionField = Country, conditionValue = BE. Null means
       *  "any". It must hold on both records of the pair before the rule
       *  participates. */
      conditionField : String(40);
      conditionValue : String(60);

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
