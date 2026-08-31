sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "mdm/md/mdmrules/manage/ext/util/XlsxCodec"
], function (Controller, UIComponent, Fragment, JSONModel, Filter, FilterOperator, MessageBox, MessageToast, XlsxCodec) {
  "use strict";

  var UPDATE_GROUP = "ruleChanges";

  // Identity/managed columns that must never travel back on a create - `binding.create` is a POST,
  // and sending an existing key or a server-assigned timestamp is either ignored or rejected
  // depending on the column, never something worth relying on either way. Shared by Duplicate and
  // by the Excel import, since both build a fresh row from data that already carries these.
  var STRIP_ON_COPY = ["ID", "@odata.etag", "createdAt", "createdBy", "modifiedAt", "modifiedBy"];

  /**
   * The rule's own fields, one column per fixed condition slot - "de structuur die ook zichtbaar is
   * in de app" (asked for): this mirrors the table on screen exactly. The ZIP/OOXML mechanics behind
   * export/import are shared with the other three rule pages via `XlsxCodec` (extracted 2026-08-31,
   * the same day this table's own conditions reverted to two fixed slots) - only this column list,
   * and the required-field check in `_applyImportedXlsx` below, are specific to WorkflowRules.
   */
  function xlsxColumns() {
    return [
      { key: "ID", label: "ID" },
      { key: "requestType", label: "CR Type" },
      { key: "step", label: "Step" },
      { key: "conditionField", label: "Condition 1 Field" },
      { key: "conditionOperator", label: "Condition 1 Operator" },
      { key: "conditionValues", label: "Condition 1 Value" },
      { key: "conditionLogic", label: "Logic" },
      { key: "conditionField2", label: "Condition 2 Field" },
      { key: "conditionOperator2", label: "Condition 2 Operator" },
      { key: "conditionValues2", label: "Condition 2 Value" },
      { key: "approvers", label: "Approvers" },
      { key: "isActive", label: "Active" }
    ];
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
     * rather than blank. Simpler again since the revert to two fixed condition slots (2026-08-31) -
     * every field, condition slots included, is a plain scalar on the rule itself now, so one
     * `binding.create(copy)` is the whole job; there is no child composition left to copy row by row.
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
      STRIP_ON_COPY.forEach(function (key) { delete copy[key]; });
      binding.create(copy);
      this._markDirty();
    },

    onCellChange: function () {
      this._markDirty();
    },

    _markDirty: function () {
      this.getView().getModel("view").setProperty("/dirty", true);
    },

    // --- Excel import / export - a real .xlsx (2026-08-31) -----------------------------------------
    //
    // Reverted from CSV the same day conditions reverted to two fixed slots: "op basis van al die
    // fixed velden ... de .xlsx file" (based on those fixed fields, make it a real .xlsx), modelled on
    // how BRF+'s own decision-table Excel up/download works - a plain header-row-driven worksheet, one
    // row per rule, no packed cells. See the zip/OOXML helpers above this controller for how the file
    // itself is built and read without a third-party spreadsheet library.

    /** Every row on the page, in the same shape Save already reads them in. */
    onExportExcel: function () {
      var rows = this._draftRules();
      if (!rows.length) {
        MessageToast.show("There is nothing to export yet.");
        return;
      }
      var bytes = XlsxCodec.buildWorkbook("WorkflowRules", xlsxColumns(), rows);
      var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "workflow-agent-determination.xlsx";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    },

    /** A hidden native file input, reused across presses rather than rebuilt each time. */
    onImportExcel: function () {
      if (!this._importInput) {
        this._importInput = document.createElement("input");
        this._importInput.type = "file";
        this._importInput.accept = ".xlsx";
        this._importInput.style.display = "none";
        this._importInput.addEventListener("change", this._onImportFileChosen.bind(this));
        document.body.appendChild(this._importInput);
      }
      // Cleared before opening, so re-importing the very same file still fires "change".
      this._importInput.value = "";
      this._importInput.click();
    },

    /** Reading a real workbook is async (DEFLATE decompression is a stream), unlike the plain-text
     *  CSV reader this replaced - `FileReader` is swapped for `File.arrayBuffer()` accordingly. */
    _onImportFileChosen: function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      var that = this;
      file.arrayBuffer().then(function (buffer) {
        return XlsxCodec.readWorkbook(new Uint8Array(buffer));
      }).then(function (table) {
        that._applyImportedXlsx(table);
      }).catch(function (error) {
        MessageBox.error("This file could not be read as an Excel workbook: " + (error && error.message ? error.message : error));
      });
    },

    /**
     * The imported file is treated as the FULL desired state of the table, the same wholesale-
     * replace reasoning `saveFieldProperties` already uses for a profile's settings: every row
     * becomes either an update to an already-loaded rule (its ID column matches one on screen) or a
     * new one (blank or unrecognised ID), and any currently-loaded rule whose ID does NOT appear
     * anywhere in the file is REMOVED (2026-08-31, fixed after a live report: "als ik een lijn
     * verwijder... wordt dit niet effectief verwijderd" - deleting a row in Excel and re-importing
     * did nothing, because nothing ever looked at what was missing). So a steward can export, delete
     * a row, edit others, append new ones, and re-import the whole thing in one go. Nothing is saved
     * here: like Add Rule, this only populates the (now dirty) table, so the existing Save/Discard
     * flow - and its validation - still has the last word; a removal that looks wrong is a Discard
     * away, same as every other change this makes.
     *
     * Matched by HEADER LABEL, not by fixed column position - the same BRF+-style tolerance for a
     * reordered or trimmed copy that the frozen header row exists to make possible. A file missing
     * the "CR Type" column is refused outright: it does not look like this table's own export, and
     * nothing is removed on a refused import.
     */
    _applyImportedXlsx: function (table) {
      if (!table.length) {
        MessageBox.error("The file has no rows.");
        return;
      }
      var header = table[0].map(function (label) { return String(label === undefined ? "" : label).trim(); });
      var columns = xlsxColumns();
      var indexOfKey = {};
      columns.forEach(function (column) {
        var index = header.indexOf(column.label);
        if (index !== -1) indexOfKey[column.key] = index;
      });
      if (indexOfKey.requestType === undefined || indexOfKey.approvers === undefined) {
        MessageBox.error("This file's header row does not match the Workflow Agent Determination "
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
      var seenIds = {};

      var created = 0;
      var updated = 0;
      var skipped = 0;
      table.slice(1).forEach(function (row) {
        var isBlank = !row || row.every(function (cell) { return cell === undefined || cell === ""; });
        if (isBlank) return;
        var record = {};
        columns.forEach(function (column) {
          if (column.key === "ID") return;
          var index = indexOfKey[column.key];
          if (index === undefined) return;
          var value = row[index];
          record[column.key] = column.key === "isActive" ? XlsxCodec.isTruthyCell(value) : (value === undefined ? "" : value);
        });
        var idIndex = indexOfKey.ID;
        var id = idIndex !== undefined ? row[idIndex] : undefined;
        var existing = id && byId[id];
        if (existing) {
          seenIds[id] = true;
          Object.keys(record).forEach(function (key) { existing.setProperty(key, record[key]); });
          updated += 1;
        } else if (record.requestType || record.approvers) {
          binding.create(record);
          created += 1;
        } else {
          skipped += 1;
        }
      });

      var removed = 0;
      Object.keys(byId).forEach(function (id) {
        if (seenIds[id]) return;
        byId[id].delete(UPDATE_GROUP);
        removed += 1;
      });

      this._markDirty();
      MessageToast.show(
        created + " rule(s) added, " + updated + " updated"
        + (removed ? ", " + removed + " removed" : "")
        + (skipped ? ", " + skipped + " blank row(s) skipped" : "")
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
        // empty"). The two fixed slots also validate server-side (validateCondition, through
        // validateWorkflowRule); this is the same check done at the keyboard.
        [
          { field: "conditionField", operator: "conditionOperator", values: "conditionValues", name: "condition 1" },
          { field: "conditionField2", operator: "conditionOperator2", values: "conditionValues2", name: "condition 2" }
        ].forEach(function (slot) {
          var field = rule[slot.field];
          var values = rule[slot.values];
          var needsValue = rule[slot.operator] !== "empty" && rule[slot.operator] !== "notEmpty";
          if (field && needsValue && !values) problems.push(label + slot.name + " needs a value.");
          if (!field && values) problems.push(label + slot.name + " needs a field.");
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
        // Captured before the submit: a row already fully created earlier this session has already
        // settled its own .created() and is not worth waiting on again.
        var creating = this._transientRows();
        await this._model().submitBatch(UPDATE_GROUP);
        // A rejected row leaves its change pending rather than silently vanishing.
        if (this._model().hasPendingChanges(UPDATE_GROUP)) {
          MessageBox.error("The service rejected at least one rule. Check the messages and correct the row.");
          return;
        }
        // submitBatch's own promise can settle before a freshly created context has actually
        // flipped out of "transient" - context.created() is the promise that genuinely completes
        // that, and it never settles LATER than submitBatch's own does, only sometimes slightly
        // after. Without this wait, the FIRST Save after Add Rule could report "not saved" for a
        // row the batch had, in fact, just finished creating - reported live 2026-08-31: pressing
        // Save again, with nothing left transient by then, made the second press look like the one
        // that actually worked. A create the service genuinely rejected is already reported above
        // via hasPendingChanges, so a rejection here is not a second error to surface.
        await Promise.all(creating.map(function (context) {
          return context.created().catch(function () {});
        }));
        // `hasPendingChanges` answers for ONE update group, so it cannot see a create that never
        // travelled - a row added outside this group would leave it false and the toast would claim
        // a save that never happened, which is indistinguishable from a rule clearing itself. So the
        // rows are asked directly: a context still transient after the wait above was never written.
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
