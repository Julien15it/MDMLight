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
       * Two independent pairs, same meaning as the other tables: an empty pair is "any", both
       * filled is AND. **One value each**, like every other rule table.
       *
       * The PLURAL names are stuck: multiple values were built here first and withdrawn on
       * 2026-08-21, and `cds-deploy` cannot rename an element any more than it can drop one. So
       * these two columns read like several values and hold one. The read path still tolerates a
       * delimited list, for the rows written while the feature was live - see
       * srv/checks/value-lists.js.
       *
       * A condition here is always a statement about the partner - this row targets no section of
       * its own - so any row of the named section satisfying it is enough.
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
