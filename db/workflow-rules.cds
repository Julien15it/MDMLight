namespace mdmlight.config;

using { managed } from '@sap/cds/common';

/**
 * Who approves what, BRF+ decision-table style like every other table here: rows not columns, so
 * adding a step or an approver is an INSERT. Read a row left to right as one sentence -
 * "a create request whose Country is BE, NL, FR or DE is approved by these three people".
 *
 * The table decides nothing about approval itself. It resolves to the `approvers` list in the
 * workflow context, and SBPA routes on it - how many approvers a request needs and what a role
 * resolves to stays entirely on that side, the same way `decideRequest` knows nothing about it.
 *
 * The step column carries only `Approve` today. It exists because the next version of this table is
 * meant to describe whole request types (Supplier creation, Customer creation) with several steps
 * each, and a step added later must not be a column added later.
 *
 * There is deliberately no order column. Rows are additive - every matching row contributes its
 * approvers - so nothing here needs ranking, and the approvers reach SBPA in table order.
 */
entity WorkflowRules : managed {
  key ID              : UUID;

      /** create / change / block / delete. No `*`: an approver list is not something to default. */
      requestType     : String(10) not null;

      /** `Approve` for now - see the note above on why this is a column at all. */
      step            : String(20) not null;

      /**
       * **Reverted to two fixed condition slots (2026-08-31)**, on direct feedback: the dynamic,
       * genuinely-unbounded "Add Condition" composition below was built and deployed-toward the same
       * week, and turned out not to be what was wanted after all - "ik wil dit naast elkaar zoals het
       * ervoor was ... niet hoe het nu is" (bring it back to how Condition 1 and Condition 2 originally
       * were). `conditionRows` and `WorkflowRuleConditions` stay in the model - this codebase's own
       * standing rule, since `cds-deploy` cannot drop an element any more than it can retype one, and
       * this table has already paid for that lesson once this same week (see the "lossy type change"
       * incident on the abandoned `conditions` column below). Nothing reads or writes `conditionRows`
       * any more; `readConditions` (srv/checks/workflow-rules.js) goes straight to the two scalar pairs
       * below, unconditionally.
       */
      conditionRows   : Composition of many WorkflowRuleConditions on conditionRows.rule = $self;

      /**
       * The two fixed condition slots - "Condition 1" and "Condition 2" - each field/operator/value,
       * joined by `conditionLogic` (AND/OR/NOR). This is what the page actually reads and writes again.
       * The PLURAL names on the value columns are stuck: `cds-deploy` cannot rename an element, and
       * multiple values were built here first and withdrawn on 2026-08-21 (see "Multiple values per
       * condition" in CLAUDE.md) - these two columns have read like several values and held one ever
       * since. `conditionOperator`/`conditionOperator2` are new (2026-08-31, pure additions, no deploy
       * risk): the ORIGINAL two-slot layout this reverts to already had an operator per slot ("dan je
       * = of != en dan andere") - it was never a bare field/value pair, so bringing the layout back
       * needed these two columns brought back with it, not dropped along with the composition.
       */
      conditionField     : String(60);
      conditionOperator  : String(10) default 'eq';
      conditionValues    : String(400);
      conditionLogic     : String(3) default 'AND';
      conditionField2    : String(60);
      conditionOperator2 : String(10) default 'eq';
      conditionValues2   : String(400);

      /**
       * The dynamic-conditions column's own FIRST cut (2026-08-28) - a line-per-condition
       * `field = value1|value2` text blob, shipped to production, then reworked into `conditionRows`
       * above the same week once it turned out the ask was "side by side, like the original two
       * slots", not "stacked lines of text". Dead on arrival for the same reason the two pairs above
       * are: `cds-deploy` cannot change a deployed column's kind, so this had to stay a String
       * forever once a live environment had it, and the real mechanism needed a new name instead.
       * Nothing reads or writes this column any more - and, as of 2026-08-31, neither does
       * `conditionRows` above: the whole dynamic-conditions detour is abandoned, not only its first
       * cut.
       */
      conditions      : LargeString;

      /**
       * ONE approver: an e-mail address or a role name. An entry carrying an `@` is passed on as a
       * user, anything else as a role - SBPA resolves both, and CAP deliberately does not check
       * that a role exists. **Several approvers means several rows**, which is what the table is
       * for and what `resolveApprovers` merges. Wide enough for the list it used to hold, and the
       * read path still parses one.
       */
      approvers       : String(1000) not null;

      isActive        : Boolean default true;
}

/**
 * **Abandoned (2026-08-31), same day it was built** - see "Reverted to two fixed condition slots"
 * on `WorkflowRules.conditionRows` above. Stays in the model, permanently unused, because
 * `cds-deploy` cannot drop an entity any more than it can drop a column. Nothing reads or writes it.
 *
 * What it was for, kept for the record: one condition of a `WorkflowRules` row - field, operator,
 * value(s) - as many as a rule needed, added/removed one row at a time from a wrapping FlexBox on
 * the page. `operator` reused the exact vocabulary `srv/checks/rule-engine.js` already offers
 * ValidationRules/DerivationRules for their own comparison column (`eq`/`ne`/`lt`/`le`/`gt`/`ge`/
 * `contains`/`empty`/`notEmpty`) - that part of the ask ("volgens mij alle mogelijke operatoren")
 * survived the revert and lives on as `conditionOperator`/`conditionOperator2` above.
 */
entity WorkflowRuleConditions : managed {
  key ID       : UUID;
      rule     : Association to WorkflowRules not null;
      field    : String(60);
      operator : String(10) default 'eq';
      values   : String(400);
}
