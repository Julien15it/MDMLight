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
       * As many conditions as the rule needs (2026-08-28), one per LINE: `field = value1|value2`.
       * Replaces the two fixed columns below, which could never be a third condition without a
       * schema change `cds-deploy` cannot walk back if it turns out to be one too many. A plain
       * multi-line text bound straight to this one column is deliberately the whole mechanism - see
       * "Multiple values per condition" in CLAUDE.md for the token-cell/MultiInput approach that was
       * tried and withdrawn for a DIFFERENT feature (several values in ONE field) and the lesson it
       * left behind: a hand-managed aggregation beside a bound column is the wrong shape, the
       * binding has to be the only writer. This is that lesson applied to "several conditions"
       * instead of "several values": one string column, one plain two-way binding, unlimited lines.
       *
       * A condition here is always a statement about the partner - this row targets no section of
       * its own - so any row of the named section satisfying it is enough. `conditionLogic` below
       * now joins however many lines are filled in, not just two.
       */
      conditions      : LargeString;

      /**
       * Two independent pairs, same meaning as above - an empty pair is "any", both filled is AND -
       * superseded by `conditions` and never written by anything any more. Kept because `cds-deploy`
       * cannot drop a column, the same reason `createsRow` and the four `cond*` columns on the other
       * rule tables are still in the model. `readConditions` (srv/checks/workflow-rules.js) still
       * reads them, but ONLY for a rule saved before this date and never re-opened since - the
       * moment such a rule is edited under the new format, `conditions` is what has the current
       * truth. The PLURAL names are stuck for the same cds-deploy reason: multiple values were
       * built here first and withdrawn on 2026-08-21 (see "Multiple values per condition" in
       * CLAUDE.md), and these two columns have read like several values and held one ever since.
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
