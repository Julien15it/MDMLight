namespace mdmlight.config;

using { managed } from '@sap/cds/common';

/**
 * Validation and derivation rules, BRF+ decision-table style and deliberately
 * the same shape as `DuplicateRules` in db/duplicate-rules.cds: two optional
 * condition pairs, then the columns that make this kind of rule what it is.
 *
 * Config lives in rows, not columns, for the same reason it does there: adding
 * a criterion is an INSERT, and cds-deploy refuses to drop elements, so a
 * column-per-criterion model turns every removed criterion into a failed
 * deployment.
 *
 * Fields are **qualified payload fields** (`General.Language`,
 * `Addresses.Country`), not duplicate-catalog names. The duplicate catalog is a
 * comparison catalog of normalised value bags; these rules read and write the
 * request payload the maintenance screen posts, so they need its field names.
 * See srv/checks/payload-fields.js.
 */

/** Both rule kinds carry the same conditions, so they are described once. */
aspect ruleConditions {
      /** Orders the admin grid for reading. Rules are independent, so ordering
       *  cannot change an outcome - except where two derivations target the
       *  same field, and there the first one to fill it wins. */
      sequence        : Integer default 10;

      /** Two independent condition pairs: conditionField = General.BusinessPartnerCategory,
       *  conditionValue = 2. Null means "any"; both filled means AND. A condition
       *  on the same section as the rule's own field is evaluated **per row**, so
       *  "Addresses.Country = BE" narrows the rule to the Belgian address rows
       *  rather than to every row of a partner that has one. */
      conditionField  : String(60);
      conditionValue  : String(120);
      conditionField2 : String(60);
      conditionValue2 : String(120);

      isActive        : Boolean default true;
}

/**
 * One row is one assertion: "where Country is BE, Language must be NL".
 *
 * A rule whose field is **empty does not fire** - `notEmpty` is how you say a
 * field is required. That is not laziness: validations run before derivations
 * (see srv/checks/pipeline.js), so a rule that failed on an empty field would
 * block the very derivation that was about to fill it.
 */
entity ValidationRules : managed, ruleConditions {
  key ID         : UUID;

      /** Qualified payload field being validated, e.g. General.Language. */
      field      : String(60) not null;

      /** eq, ne, lt, le, gt, ge, contains, empty, notEmpty - see
       *  srv/checks/rule-engine.js, which is the one place they are defined. */
      comparison : String(12) not null;

      /** The value the field is compared against. A value that resolves to a
       *  qualified payload field compares the two fields instead. Ignored by
       *  `empty` and `notEmpty`. */
      value      : String(120);

      /** 'error' blocks the request, 'warning' and 'info' only report. Not in
       *  the original sketch of this table, and not optional either: without it
       *  every validation would block, and a naming convention that stops a
       *  submit is how people learn to ignore findings. */
      severity   : String(10) default 'error';
}

/**
 * One row is one gap-filler: "where Country is BE, fill Language with NL".
 *
 * A derivation never overwrites - the pipeline enforces that, not this table -
 * and since 2026-08-17 it never auto-applies either: it is proposed to the
 * requester, who ticks it.
 */
entity DerivationRules : managed, ruleConditions {
  key ID    : UUID;

      /** Qualified payload field being filled, e.g. General.Language. */
      field : String(60) not null;

      /** The value to fill in. A value that resolves to a qualified payload
       *  field **copies that field** instead of writing the text - which is why
       *  catalog names are always dotted and a literal never can be one. */
      value : String(120) not null;
}
