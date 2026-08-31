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
       * As many conditions as the rule needs (2026-08-28), each its own row of `WorkflowRuleConditions`
       * below - "Add Condition" on the page adds one, side by side with whatever the rule already
       * has, exactly the shape asked for: a 3rd, 4th, etc. rendered the same way the first two always
       * were, not stacked as lines of text. A real composition, not more scalar columns
       * (`conditionField3`, ...), because a fixed number of columns is the trap `createsRow` and the
       * four `cond*` columns on the other rule tables are already stuck in: `cds-deploy` cannot drop
       * one if the chosen number turns out to be one too few, or too many.
       *
       * A condition here is always a statement about the partner - this row targets no section of
       * its own - so any row of the named section satisfying it is enough. `conditionLogic` below
       * joins however many condition rows exist, not just two.
       */
      conditions      : Composition of many WorkflowRuleConditions on conditions.rule = $self;

      /**
       * Two independent pairs, same meaning as above - an empty pair is "any", both filled is AND -
       * superseded by the `conditions` composition and never written by anything any more. Kept
       * because `cds-deploy` cannot drop a column, the same reason `createsRow` and the four `cond*`
       * columns on the other rule tables are still in the model. `readConditions`
       * (srv/checks/workflow-rules.js) still reads them, but ONLY for a rule saved before this date
       * and never re-opened since - the moment such a rule is edited under the new format, its
       * `conditions` rows are what have the current truth. The PLURAL names are stuck for the same
       * cds-deploy reason: multiple values were built here first and withdrawn on 2026-08-21 (see
       * "Multiple values per condition" in CLAUDE.md), and these two columns have read like several
       * values and held one ever since.
       */
      conditionField  : String(60);
      conditionValues : String(400);
      conditionLogic : String(3) default 'AND';
      conditionField2 : String(60);
      conditionValues2 : String(400);

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
 * One condition of a `WorkflowRules` row - field, operator, value(s) - as many as that rule needs.
 * `operator` reuses the exact vocabulary `srv/checks/rule-engine.js` already offers ValidationRules/
 * DerivationRules for their own comparison column (`eq`/`ne`/`lt`/`le`/`gt`/`ge`/`contains`/`empty`/
 * `notEmpty`), asked for directly ("volgens mij alle mogelijke operatoren") rather than a smaller,
 * WorkflowRules-only set. `values` keeps the plural name and the `|`-delimited multi-value/wildcard
 * encoding every other condition column in this app already uses (`eq`/`ne` only - see
 * conditionHolds), so "Country is one of BE, NL, FR, DE" is still one row, now of this table instead
 * of one packed cell.
 *
 * No order column, on purpose, like `WorkflowRules` itself: AND/OR/NOR fold over these rows without
 * caring which order they were added in (see `joinConditions` in value-lists.js), so there is
 * nothing here for a `sequence` column to mean.
 */
entity WorkflowRuleConditions : managed {
  key ID       : UUID;
      rule     : Association to WorkflowRules not null;
      field    : String(60);
      operator : String(10) default 'eq';
      values   : String(400);
}
