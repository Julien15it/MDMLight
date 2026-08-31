sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, UIComponent, Fragment, JSONModel, Filter, FilterOperator, MessageBox, MessageToast) {
  "use strict";

  var UPDATE_GROUP = "ruleChanges";

  // Identity/managed columns that must never travel back on a create - `binding.create` is a POST,
  // and sending an existing key or a server-assigned timestamp is either ignored or rejected
  // depending on the column, never something worth relying on either way. Shared by Duplicate and
  // by the Excel import, since both build a fresh row from data that already carries these.
  var STRIP_ON_COPY = ["ID", "@odata.etag", "createdAt", "createdBy", "modifiedAt", "modifiedBy"];

  /**
   * A fixed number of condition SLOTS for the Excel round trip only - not a limit on the page, where
   * "Add Condition" is genuinely unbounded (see WorkflowRuleConditions in db/workflow-rules.cds). A
   * spreadsheet needs some concrete column count, and this is deliberately generous rather than
   * matched to what is in use today; a rule with more conditions than this is exported with a
   * warning naming which ones were left off, never silently.
   */
  var MAX_EXCEL_CONDITIONS = 6;

  function csvColumns() {
    var columns = [
      { key: "ID", label: "ID (leave blank for a new rule)" },
      { key: "requestType", label: "CR Type" },
      { key: "step", label: "Step" }
    ];
    for (var i = 1; i <= MAX_EXCEL_CONDITIONS; i += 1) {
      columns.push({ key: "field" + i, label: "Condition " + i + " Field" });
      columns.push({ key: "operator" + i, label: "Condition " + i + " Operator" });
      columns.push({ key: "values" + i, label: "Condition " + i + " Value" });
    }
    columns.push({ key: "conditionLogic", label: "Logic" });
    columns.push({ key: "approvers", label: "Approvers" });
    columns.push({ key: "isActive", label: "Active" });
    return columns;
  }

  /** A rule's own fields plus one column per condition slot - the same shape the page itself shows,
   *  asked for directly rather than the DSL-in-one-cell shape this replaced. */
  function flattenForExport(rule) {
    var flat = Object.assign({}, rule);
    var conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    for (var i = 0; i < MAX_EXCEL_CONDITIONS; i += 1) {
      var condition = conditions[i] || {};
      flat["field" + (i + 1)] = condition.field || "";
      flat["operator" + (i + 1)] = condition.operator || "";
      flat["values" + (i + 1)] = condition.values || "";
    }
    delete flat.conditions;
    return flat;
  }

  /** Quotes a field only when it needs it - a bare value stays readable in a plain text editor too. */
  function csvEscape(value) {
    var text = value === null || value === undefined ? "" : String(value);
    if (/["\n\r,]/u.test(text)) return '"' + text.replace(/"/gu, '""') + '"';
    return text;
  }

  /** `\r\n` is what Excel itself writes and expects between rows; inside a quoted field (Conditions,
   *  which is multi-line by design) a bare `\n` still reads as one cell. */
  function toCsv(rows, columns) {
    var lines = [columns.map(function (column) { return csvEscape(column.label); }).join(",")];
    rows.forEach(function (row) {
      lines.push(columns.map(function (column) { return csvEscape(row[column.key]); }).join(","));
    });
    return lines.join("\r\n");
  }

  /**
   * A small state machine rather than a split on "\n": a quoted field can itself hold a literal
   * newline - the Conditions column always will once a rule has more than one condition - and
   * splitting on every "\n" first would cut such a row in two before the quoting is even read.
   */
  function fromCsv(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i += 1; continue;
        }
        field += ch; i += 1; continue;
      }
      if (ch === '"') { inQuotes = true; i += 1; continue; }
      if (ch === ",") { row.push(field); field = ""; i += 1; continue; }
      if (ch === "\r") { i += 1; continue; }
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 1; continue; }
      field += ch; i += 1;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (parsedRow) { return parsedRow.length > 1 || parsedRow[0] !== ""; });
  }

  // Who approves what. Same page shape as the other three rule tables, because a steward should not
  // have to learn two: one value per cell, a field value help on the conditions and a role value
  // help on the approver. Several approvers means several rows.
  return Controller.extend("mdm.md.mdmrules.manage.ext.controller.WorkflowRuleList", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        busy: false,
        dirty: false,
        skipped: 0,
        skippedText: ""
      }), "view");
      this._router = UIComponent.getRouterFor(this);
      this._loadOptions();
    },

    onBackToHub: function () {
      if (this._model() && this._model().hasPendingChanges(UPDATE_GROUP)) {
        MessageBox.confirm("Leave without saving? Unsaved rule changes are discarded.", {
          onClose: function (action) {
            if (action === MessageBox.Action.OK) {
              this._model().resetChanges(UPDATE_GROUP);
              this._router.navTo("MDMRuleHub", {}, true);
            }
          }.bind(this)
        });
        return;
      }
      this._router.navTo("MDMRuleHub", {}, true);
    },

    // The component's model, not only the view's: a routed view is not in the control tree yet during
    // onInit, which is what left the duplicate page's dropdowns empty the first time round.
    _model: function () {
      var component = this.getOwnerComponent();
      return this.getView().getModel("dc") || (component && component.getModel("dc"));
    },

    _table: function () {
      return this.byId("ruleTable");
    },

    /** Payload fields from the staging model, the CR types and the steps from the engine. */
    _loadOptions: async function () {
      try {
        var options = await this._callAction("workflowRuleOptions", {});
        this.getView().setModel(new JSONModel(options || {}), "opt");
        this._reportSkipped(options);
        if (!options || !options.fields || !options.fields.length) {
          MessageBox.error("The field catalog came back empty, so no condition can be written. "
            + "The staging model could not be read.");
        }
      } catch (error) {
        MessageBox.error("The rule options could not be loaded: " + this._errorText(error));
      }
    },

    // A saved rule that would not run looks configured and does nothing, so the runnable count from
    // the service is compared against what is stored.
    _reportSkipped: function (options) {
      var view = this.getView().getModel("view");
      var runnable = options && options.ruleCount;
      var binding = this._table() && this._table().getBinding("items");
      var stored = binding ? binding.getLength() : 0;
      var skipped = (typeof runnable === "number" && stored > runnable) ? stored - runnable : 0;
      view.setProperty("/skipped", skipped);
      view.setProperty("/skippedText", skipped
        ? skipped + " of the " + stored + " saved rules are not running, because they are inactive or "
          + "incomplete. Those requests are routed as if the table said nothing about them."
        : "");
    },

    onAddRule: function () {
      var binding = this._table().getBinding("items");
      if (!binding) return;
      // The step is the only honest default: there is one, and it is what every row is for today.
      // Request type and approvers are left empty - a row arriving pre-pointed at a CR type would be
      // a routing rule nobody wrote.
      binding.create({
        step: "Approve",
        approvers: "",
        conditionLogic: "AND",
        isActive: true
      });
      this._markDirty();
    },

    onDeleteRule: function () {
      var item = this._table().getSelectedItem();
      if (!item) {
        MessageToast.show("Select the rule to delete.");
        return;
      }
      var context = item.getBindingContext("dc");
      if (!context) return;
      MessageBox.confirm("Delete this rule?", {
        onClose: function (action) {
          if (action !== MessageBox.Action.OK) return;
          context.delete(UPDATE_GROUP);
          this._markDirty();
        }.bind(this)
      });
    },

    /**
     * "Copy and paste" for a rule: the same fields as Add Rule, pre-filled from the selected row
     * rather than blank - conditions included, each of them its own new row of
     * WorkflowRuleConditions rather than a deep-insert payload, so this cannot depend on whether the
     * OData v4 model's create() supports a nested composition array in one call. The rule is created
     * first; its conditions are added against the fresh (still transient) context exactly the way
     * "Add Condition" adds one, just once per condition the original had.
     */
    onDuplicateRule: function () {
      var item = this._table().getSelectedItem();
      if (!item) {
        MessageToast.show("Select the rule to duplicate.");
        return;
      }
      var context = item.getBindingContext("dc");
      var binding = this._table().getBinding("items");
      if (!context || !binding) return;
      var copy = Object.assign({}, context.getObject());
      var conditions = Array.isArray(copy.conditions) ? copy.conditions : [];
      STRIP_ON_COPY.concat(["conditions"]).forEach(function (key) { delete copy[key]; });
      var newContext = binding.create(copy);
      conditions.forEach(function (row) {
        var conditionCopy = Object.assign({}, row);
        STRIP_ON_COPY.concat(["rule_ID", "rule"]).forEach(function (key) { delete conditionCopy[key]; });
        this._conditionsBinding(newContext).create(conditionCopy);
      }, this);
      this._markDirty();
    },

    /** A fresh list binding for one rule's `conditions` navigation - the mechanism Add Condition,
     *  Duplicate and Excel import all share for adding a condition row under a given rule context. */
    _conditionsBinding: function (ruleContext) {
      return ruleContext.getModel().bindList(
        "conditions", ruleContext, [], [], { $$updateGroupId: UPDATE_GROUP }
      );
    },

    onCellChange: function () {
      this._markDirty();
    },

    _markDirty: function () {
      this.getView().getModel("view").setProperty("/dirty", true);
    },

    // --- Conditions: as many as a rule needs, side by side (2026-08-28) ---------------------
    //
    // Each condition is its own row of WorkflowRuleConditions (db/workflow-rules.cds), so "Add
    // Condition" on one rule never touches any other rule's own count - genuinely dynamic per row,
    // not a fixed number of always-visible slots.

    /** The button sits inside the per-rule FlexBox cell, so its own binding context IS the rule. */
    onAddCondition: function (event) {
      var ruleContext = event.getSource().getBindingContext("dc");
      if (!ruleContext) return;
      this._conditionsBinding(ruleContext).create({ operator: "eq", values: "" });
      this._markDirty();
    },

    /** The remove button sits inside the per-condition template, so its own binding context IS the
     *  condition being removed - unlike Delete Rule, this needs no confirmation: it is exactly as
     *  reversible as clearing an Input was in the old fixed-column layout. */
    onRemoveCondition: function (event) {
      var context = event.getSource().getBindingContext("dc");
      if (!context) return;
      context.delete(UPDATE_GROUP);
      this._markDirty();
    },

    // --- Excel (CSV) import / export ----------------------------------------
    //
    // Real .xlsx would need a third-party reader/writer library this repo has never taken a
    // dependency on anywhere, front or back end - CSV needs none: Excel opens and saves it natively,
    // and a small RFC-4180-shaped encoder/decoder (top of this file) is standard, low-risk code with
    // nothing to vendor or keep patched. "Export to Excel" / "Import from Excel" in the UI names the
    // destination the steward actually cares about; the file on disk is `.csv`.

    /** Every row on the page, in the same shape Save already reads them in - one column per
     *  condition slot, exactly the structure visible in the table itself. */
    onExportExcel: function () {
      var rows = this._draftRules();
      if (!rows.length) {
        MessageToast.show("There is nothing to export yet.");
        return;
      }
      var overflowing = rows.filter(function (rule) {
        return Array.isArray(rule.conditions) && rule.conditions.length > MAX_EXCEL_CONDITIONS;
      });
      var csv = toCsv(rows.map(flattenForExport), csvColumns());
      // A UTF-8 BOM, because Excel on Windows otherwise guesses the system codepage for a plain
      // .csv and can mangle anything outside ASCII - an approver's name, say.
      var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "workflow-agent-determination.csv";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      // Told rather than silently truncated: a spreadsheet needs a fixed number of condition
      // columns, but a rule is never limited to it on the page itself.
      if (overflowing.length) {
        MessageBox.warning(
          overflowing.length + " rule(s) have more than " + MAX_EXCEL_CONDITIONS + " conditions; "
          + "only the first " + MAX_EXCEL_CONDITIONS + " of each were exported. Editing and "
          + "re-importing such a rule would drop the rest - add or edit its later conditions on "
          + "the page instead."
        );
      }
    },

    /** A hidden native file input, reused across presses rather than rebuilt each time. */
    onImportExcel: function () {
      if (!this._importInput) {
        this._importInput = document.createElement("input");
        this._importInput.type = "file";
        this._importInput.accept = ".csv,text/csv";
        this._importInput.style.display = "none";
        this._importInput.addEventListener("change", this._onImportFileChosen.bind(this));
        document.body.appendChild(this._importInput);
      }
      // Cleared before opening, so re-importing the very same file still fires "change".
      this._importInput.value = "";
      this._importInput.click();
    },

    _onImportFileChosen: function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        this._applyImportedCsv(String(reader.result || ""));
      }.bind(this);
      reader.onerror = function () {
        MessageBox.error("The file could not be read.");
      };
      reader.readAsText(file, "utf-8");
    },

    /**
     * Every row becomes either an update to an already-loaded rule (its ID column matches one on
     * screen) or a new one (blank or unrecognised ID) - so a steward can export, append new rows in
     * the same spreadsheet, and re-import the whole thing in one go. Nothing is saved here: like Add
     * Rule, this only populates the (now dirty) table, so the existing Save/Discard flow - and its
     * validation - still has the last word.
     *
     * Conditions are only ever taken from a NEW row's slot columns - an EXISTING rule keeps whatever
     * conditions it already has on the page. Replacing them would mean deleting contexts this
     * function never touched (the page's own nested list bindings hold them, not this method), and
     * a silent partial replace is worse than a clearly communicated no-op: the toast says so, and a
     * row whose condition columns were filled in anyway is named, so nothing is dropped unnoticed.
     */
    _applyImportedCsv: function (text) {
      var table = fromCsv(text);
      if (!table.length) {
        MessageBox.error("The file is empty.");
        return;
      }
      var columns = csvColumns();
      var keyForLabel = {};
      columns.forEach(function (column) { keyForLabel[column.label.trim()] = column.key; });
      var header = table[0].map(function (label) { return keyForLabel[label.trim()]; });
      if (header.indexOf("requestType") === -1 || header.indexOf("approvers") === -1) {
        MessageBox.error("This file's header does not match the Workflow Agent Determination "
          + "export format. Export the current rules first and edit that file.");
        return;
      }

      var binding = this._table().getBinding("items");
      if (!binding) return;
      var byId = {};
      binding.getCurrentContexts().forEach(function (context) {
        var object = context.getObject();
        if (object && object.ID) byId[object.ID] = context;
      });

      var created = 0;
      var updated = 0;
      var skipped = 0;
      var ignoredConditions = 0;
      table.slice(1).forEach(function (fields) {
        if (fields.length === 1 && fields[0] === "") return;
        var record = {};
        var conditionSlots = [];
        header.forEach(function (key, column) {
          if (!key || key === "ID") return;
          var value = fields[column] !== undefined ? fields[column] : "";
          if (/^field\d+$/u.test(key) || /^operator\d+$/u.test(key) || /^values\d+$/u.test(key)) {
            var slot = Number(key.replace(/\D+/gu, ""));
            conditionSlots[slot - 1] = conditionSlots[slot - 1] || {};
            conditionSlots[slot - 1][key.replace(/\d+$/u, "")] = value;
            return;
          }
          record[key] = value;
        });
        var conditions = conditionSlots.filter(function (slot) { return slot && slot.field; });
        // Tolerant on purpose: a business user typing quickly in Excel writes "yes"/"Yes"/"TRUE"/
        // "1"/"x" as often as the literal word, and a strict match would silently read every one of
        // those as inactive.
        record.isActive = /^(true|1|yes|x)$/iu.test(String(record.isActive || "").trim());
        var id = fields[header.indexOf("ID")];
        var existing = id && byId[id];
        if (existing) {
          Object.keys(record).forEach(function (key) { existing.setProperty(key, record[key]); });
          if (conditions.length) ignoredConditions += 1;
          updated += 1;
        } else if (record.requestType || record.approvers || conditions.length) {
          var newContext = binding.create(record);
          conditions.forEach(function (condition) {
            this._conditionsBinding(newContext).create({
              field: condition.field, operator: condition.operator || "eq", values: condition.values || ""
            });
          }, this);
          created += 1;
        } else {
          skipped += 1;
        }
      }, this);
      this._markDirty();
      MessageToast.show(
        created + " rule(s) added, " + updated + " updated"
        + (skipped ? ", " + skipped + " blank row(s) skipped" : "")
        + (ignoredConditions ? ", " + ignoredConditions + " existing rule(s) kept their own conditions"
          + " (edit those on the page)" : "")
        + ". Review and press Save."
      );
    },

    // --- The role value help -----------------------------------------------

    /**
     * The approver half of the cell. Typing an address is the other half and needs no dialog; a
     * role has to be spelled exactly as SBPA knows it, so it is picked rather than remembered - and
     * so is a user, since nobody should have to know how a colleague's e-mail is written.
     *
     * One entry, because the cell holds one approver: several approvers are several rows, which is
     * what the Add button is for and what the engine merges.
     */
    onRoleValueHelp: async function (event) {
      var input = event.getSource();
      var binding = input.getBinding("value");
      this._roleTarget = {
        context: input.getBindingContext("dc"),
        path: binding && binding.getPath()
      };
      if (!this._roleTarget.context || !this._roleTarget.path) return;
      if (!this._roleHelp) {
        this._roleFragmentId = this.getView().getId() + "-roles";
        this._roleHelp = await Fragment.load({
          id: this._roleFragmentId,
          name: "mdm.md.mdmrules.manage.ext.fragment.RoleValueHelp",
          controller: this
        });
        this.getView().addDependent(this._roleHelp);
      }
      // Cleared on the way IN, never on the way out - the same rule the field value help follows,
      // and for the same reason: resetting a filtered list re-templates its rows.
      var items = this._roleTable().getBinding("items");
      if (items) items.filter([]);
      this._roleHelp.open();
    },

    // A real Table, not a SelectDialog, so Type and Name/E-mail render as genuine columns - see the
    // fragment. Looked up by local id rather than kept as a field, the same way _table() looks up
    // the main table: the fragment owns its own control tree.
    _roleTable: function () {
      return Fragment.byId(this._roleFragmentId, "agentTable");
    },

    onRoleSearch: function (event) {
      // A plain sap.m.SearchField, unlike SelectDialog's own re-exposed search/liveChange, names its
      // parameter "newValue" on liveChange and "query" on search (Enter or the icon) - neither is
      // "value", which only ever existed on SelectDialog's own events.
      var query = event.getParameter("newValue") || event.getParameter("query") || "";
      var items = this._roleTable().getBinding("items");
      if (!items) return;
      items.filter(query ? new Filter({
        filters: [
          new Filter("value", FilterOperator.Contains, query),
          new Filter("type", FilterOperator.Contains, query)
        ],
        and: false
      }) : []);
    },

    // The value is read off its binding context before anything touches the list, for the reason
    // the field value help spells out - a reset re-binds the items to different rows.
    // (Written without naming that handler and a colon: these tests find a method by that exact
    // string, so a comment carrying it sends the slice to the wrong function.)
    onRolesChosen: function (event) {
      var listItem = event.getParameter("listItem");
      var context = listItem && listItem.getBindingContext("opt");
      var value = context && context.getProperty("value");
      if (value && this._roleTarget) {
        this._roleTarget.context.setProperty(this._roleTarget.path, value);
        this._markDirty();
      }
      this._roleHelp.close();
    },

    onRoleValueHelpCancel: function () {
      this._roleHelp.close();
    },

    // --- The field value help ----------------------------------------------

    // Opened from a condition's own Field cell. The cell is identified by its own binding rather than
    // custom data: `getBinding("value").getPath()` already knows what it writes - one bound Input per
    // condition again, the same as before conditions became a column of stacked text.
    onFieldValueHelp: async function (event) {
      var input = event.getSource();
      var binding = input.getBinding("value");
      this._target = {
        context: input.getBindingContext("dc"),
        path: binding && binding.getPath()
      };
      if (!this._target.context || !this._target.path) return;
      if (!this._valueHelp) {
        this._valueHelp = await Fragment.load({
          id: this.getView().getId(),
          name: "mdm.md.mdmrules.manage.ext.fragment.FieldValueHelp",
          controller: this
        });
        this.getView().addDependent(this._valueHelp);
      }
      // Cleared on the way IN, never on the way out: the dialog is shared, and clearing it while a
      // selection is still being read is what made the wrong field land (see onFieldChosen).
      var items = this._valueHelp.getBinding("items");
      if (items) items.filter([]);
      this._valueHelp.open("");
    },

    /** `contains` over both the label and the qualified name, so "Country" and "Addresses." work. */
    onFieldSearch: function (event) {
      var query = event.getParameter("value") || event.getParameter("newValue") || "";
      var items = event.getSource().getBinding("items");
      if (!items) return;
      items.filter(query ? new Filter({
        filters: [
          new Filter("text", FilterOperator.Contains, query),
          new Filter("code", FilterOperator.Contains, query)
        ],
        and: false
      }) : []);
    },

    // Read off the binding context, BEFORE anything touches the list. Clearing the filter first
    // re-templates the rows and re-binds the item to whatever now sits at its old position, which is
    // why searching "Country" used to write a General name field. The filter is reset on open instead.
    onFieldChosen: function (event) {
      var selected = event.getParameter("selectedItem");
      var context = selected && selected.getBindingContext("opt");
      // The qualified code is what is stored - the label is for reading, and storing it would make
      // a rule that no longer resolves the moment a label is reworded.
      var code = context && context.getProperty("code");
      if (!code || !this._target) return;
      this._target.context.setProperty(this._target.path, code);
      this._markDirty();
    },

    // --- Save --------------------------------------------------------------

    // The same checks the service makes, so a steward is told at the keyboard rather than by a
    // rejected batch. The service still validates: this is a courtesy, not the guard.
    _localProblems: function (rows) {
      var problems = [];
      rows.forEach(function (rule, index) {
        var label = "Row " + (index + 1) + ": ";
        if (!rule.requestType) problems.push(label + "choose the CR type this rule applies to.");
        if (!rule.step) problems.push(label + "choose the step.");
        // A step with nobody on it is the row that looks configured and stops a request dead.
        if (!rule.approvers) {
          problems.push(label + "name the approver — an e-mail address or a role.");
        }
        // Half a condition is the dangerous half: a field with no values would match everything -
        // unless the operator is one of the two that need no value at all ("is empty"/"is not
        // empty"). Each condition also validates on its own write server-side (validateCondition);
        // this is the same check done at the keyboard.
        (Array.isArray(rule.conditions) ? rule.conditions : []).forEach(function (condition, position) {
          var name = "condition " + (position + 1);
          var needsValue = condition.operator !== "empty" && condition.operator !== "notEmpty";
          if (condition.field && needsValue && !condition.values) {
            problems.push(label + name + " needs a value.");
          }
          if (!condition.field && condition.values) {
            problems.push(label + name + " needs a field.");
          }
        });
      });
      return problems;
    },

    // Rows the page is still holding on its own. `isTransient` is guarded because a persisted
    // context does not always carry it, depending on how the row got here.
    _transientRows: function () {
      var binding = this._table() && this._table().getBinding("items");
      if (!binding) return [];
      return (binding.getCurrentContexts() || []).filter(function (context) {
        return context && context.isTransient && context.isTransient();
      });
    },

    _draftRules: function () {
      var binding = this._table().getBinding("items");
      if (!binding) return [];
      return binding.getCurrentContexts().map(function (context) {
        var row = Object.assign({}, context.getObject());
        delete row["@odata.etag"];
        return row;
      });
    },

    onSave: async function () {
      var view = this.getView().getModel("view");
      var problems = this._localProblems(this._draftRules());
      if (problems.length) {
        MessageBox.error(problems.join("\n"));
        return;
      }
      view.setProperty("/busy", true);
      try {
        await this._model().submitBatch(UPDATE_GROUP);
        // A rejected row leaves its change pending rather than silently vanishing.
        if (this._model().hasPendingChanges(UPDATE_GROUP)) {
          MessageBox.error("The service rejected at least one rule. Check the messages and correct the row.");
          return;
        }
        // `hasPendingChanges` answers for ONE update group, so it cannot see a create that never
        // travelled - a row added outside this group would leave it false and the toast would claim
        // a save that never happened, which is indistinguishable from a rule clearing itself. So the
        // rows are asked directly: a context still transient after a submit was never written.
        var unsaved = this._transientRows();
        if (unsaved.length) {
          MessageBox.error(unsaved.length + " rule(s) were not saved: the service accepted nothing "
            + "for them and they are still local to this page. Reload before trying again — "
            + "leaving now loses them.");
          return;
        }
        view.setProperty("/dirty", false);
        // Re-read: what is running has changed, and the banner has to stop claiming otherwise.
        await this._loadOptions();
        MessageToast.show("Workflow rules saved.");
      } catch (error) {
        MessageBox.error("The rules could not be saved: " + this._errorText(error));
      } finally {
        view.setProperty("/busy", false);
      }
    },

    onDiscard: function () {
      this._model().resetChanges(UPDATE_GROUP);
      this.getView().getModel("view").setProperty("/dirty", false);
    },

    _callAction: async function (name, parameters) {
      var model = this._model();
      if (!model) throw new Error("The rule configuration service is not bound to this page.");
      var binding = model.bindContext("/" + name + "(...)");
      Object.keys(parameters).forEach(function (parameter) {
        binding.setParameter(parameter, parameters[parameter]);
      });
      await binding.execute("$direct");
      var context = binding.getBoundContext();
      var result = context ? context.getObject() : null;
      binding.destroy();
      // A function returning a primitive comes back wrapped in a `value` property.
      return result && result.value !== undefined ? result.value : result;
    },

    _errorText: function (error) {
      return (error && (error.message || error.toString())) || "unknown error";
    }
  });
});
