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

  // Mirrors CONDITION_PAIRS in srv/checks/rule-engine.js - see ValidationRuleList.controller.js.
  var CONDITION_PAIRS = [
    { field: "conditionField", value: "conditionValue" },
    { field: "conditionField2", value: "conditionValue2" }
  ];

  // Identity/managed columns that must never travel back on a create - see WorkflowRuleList's own
  // copy of this for the reasoning.
  var STRIP_ON_COPY = ["ID", "@odata.etag", "createdAt", "createdBy", "modifiedAt", "modifiedBy"];

  /** The rule's own fields, mirroring the table on screen exactly - see ValidationRuleList.controller.js. */
  function xlsxColumns() {
    return [
      { key: "ID", label: "ID" },
      { key: "conditionField", label: "Condition 1 Field" },
      { key: "conditionValue", label: "Condition 1 Value" },
      { key: "conditionLogic", label: "Logic" },
      { key: "conditionField2", label: "Condition 2 Field" },
      { key: "conditionValue2", label: "Condition 2 Value" },
      { key: "field", label: "Field" },
      { key: "value", label: "Value" },
      { key: "isActive", label: "Active" }
    ];
  }

  // Rows are real and run on Check, where they are offered as proposals. Deliberately NOT run on
  // Submit: a derivation changes the data, so the requester has to have seen and ticked it.
  return Controller.extend("mdm.md.mdmrules.manage.ext.controller.DerivationRuleList", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        busy: false,
        dirty: false,
        // Qualified name -> label, so a Value that names a field can say so under the cell. This is
        // the one place the page tells a steward which of the Value column's two meanings it read.
        fieldText: {},
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

    /** See ValidationRuleList.controller.js - the component's model, not only the view's. */
    _model: function () {
      var component = this.getOwnerComponent();
      return this.getView().getModel("dc") || (component && component.getModel("dc"));
    },

    _table: function () {
      return this.byId("ruleTable");
    },

    _loadOptions: async function () {
      var view = this.getView().getModel("view");
      try {
        var options = await this._callAction("qualityRuleOptions", {});
        this.getView().setModel(new JSONModel(options || {}), "opt");
        var fieldText = {};
        (options && options.fields ? options.fields : []).forEach(function (entry) {
          fieldText[entry.code] = entry.text;
        });
        view.setProperty("/fieldText", fieldText);
        this._reportSkipped(options);
        if (!options || !options.fields || !options.fields.length) {
          MessageBox.error("The field catalog came back empty, so no rule can be written. "
            + "The staging model could not be read.");
        }
      } catch (error) {
        MessageBox.error("The rule options could not be loaded: " + this._errorText(error));
      }
    },

    /** A saved rule that would not run looks configured and does nothing - so it is named. */
    _reportSkipped: function (options) {
      var view = this.getView().getModel("view");
      var runnable = options && options.derivationCount;
      var binding = this._table() && this._table().getBinding("items");
      var stored = binding ? binding.getLength() : 0;
      var skipped = (typeof runnable === "number" && stored > runnable) ? stored - runnable : 0;
      view.setProperty("/skipped", skipped);
      view.setProperty("/skippedText", skipped
        ? skipped + " of the " + stored + " saved rules are not running, because they are inactive or "
          + "incomplete. Fix the row or deactivate it, so the table says what it does."
        : "");
    },

    onAddRule: function () {
      var binding = this._table().getBinding("items");
      if (!binding) return;
      // No field and no value on purpose: a row that arrived pointing at a field would be a rule
      // nobody wrote, and a derivation with a default value would fill data nobody asked for.
      // A rule carries no "adds the row" answer either: the payload decides. A rule whose section
      // holds no rows proposes the row, one whose section has rows fills its gaps.
      binding.create({ sequence: 10, conditionLogic: "AND", isActive: true });
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
     * The Value column means two things and this hint is the only thing that says which one was
     * read. A literal gets no hint at all - a free-form `BE` used to render "Copied from undefined",
     * because the text was concatenated whether or not the catalog lookup found anything.
     */
    formatValueHint: function (value, fieldText) {
      var label = (fieldText || {})[value];
      return label ? "Copied from " + label : "";
    },

    /** Same lookup, as the visibility: no hint at all for a literal. */
    isFieldReference: function (value, fieldText) {
      return Boolean((fieldText || {})[value]);
    },

    onCellChange: function () {
      this._markDirty();
    },

    _markDirty: function () {
      this.getView().getModel("view").setProperty("/dirty", true);
    },

    /** "Copy and paste" for a rule - see WorkflowRuleList.controller.js's own copy for the reasoning. */
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

    // --- Excel import / export - a real .xlsx (2026-08-31) -----------------------------------------
    //
    // See WorkflowRuleList.controller.js for the full reasoning - the ZIP/OOXML mechanics live in
    // XlsxCodec, shared by all four rule pages.

    onExportExcel: function () {
      var rows = this._draftRules();
      if (!rows.length) {
        MessageToast.show("There is nothing to export yet.");
        return;
      }
      var bytes = XlsxCodec.buildWorkbook("DerivationRules", xlsxColumns(), rows);
      var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "derivation-rules.xlsx";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    },

    onImportExcel: function () {
      if (!this._importInput) {
        this._importInput = document.createElement("input");
        this._importInput.type = "file";
        this._importInput.accept = ".xlsx";
        this._importInput.style.display = "none";
        this._importInput.addEventListener("change", this._onImportFileChosen.bind(this));
        document.body.appendChild(this._importInput);
      }
      this._importInput.value = "";
      this._importInput.click();
    },

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

    /** The imported file is the full desired state of the table - see WorkflowRuleList.controller.js
     *  for the full reasoning (wholesale replace, matched by header label, nothing saved
     *  automatically, a rule missing from the file is removed). */
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
      if (indexOfKey.field === undefined || indexOfKey.value === undefined) {
        MessageBox.error("This file's header row does not match the Derivation Rules export format. "
          + "Export the current rules first and edit that file.");
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
        } else if (record.field || record.value) {
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

    // --- The field value help ----------------------------------------------

    // Opened from the conditions, Field and Value. On Value it is the point: "same value as field B"
    // should be a pick, not a name a steward has to spell exactly right.
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
      // Cleared on the way IN, never on the way out - see ValidationRuleList.controller.js.
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

    // Read off the binding context before anything touches the list - clearing the filter first wrote
    // the wrong field. See ValidationRuleList.controller.js.
    onFieldChosen: function (event) {
      var selected = event.getParameter("selectedItem");
      var context = selected && selected.getBindingContext("opt");
      var code = context && context.getProperty("code");
      if (!code || !this._target) return;
      this._target.context.setProperty(this._target.path, code);
      this._markDirty();
    },

    // --- Save --------------------------------------------------------------

    /** The same checks `validateDerivationRule` makes server-side, at the keyboard. */
    _localProblems: function (rows) {
      var fieldText = this.getView().getModel("view").getProperty("/fieldText");
      var problems = [];
      rows.forEach(function (rule, index) {
        var label = "Row " + (index + 1) + ": ";
        if (!rule.field) problems.push(label + "choose the field to fill in.");
        if (!rule.value) problems.push(label + "enter a value, or choose a field to copy it from.");
        // Copying a field onto itself never fills anything: the target is empty exactly when the
        // source is.
        if (rule.field && rule.value && rule.field === rule.value) {
          problems.push(label + "a derivation cannot copy a field onto itself.");
        }
        CONDITION_PAIRS.forEach(function (pair, position) {
          var name = "condition " + (position + 1);
          if (rule[pair.field] && !rule[pair.value]) {
            problems.push(label + name + " needs a value, or clear its field.");
          }
          if (rule[pair.value] && !rule[pair.field]) {
            problems.push(label + name + " needs a field.");
          }
        });
      });
      return problems;
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

    // Rows the page is still holding on its own. `isTransient` is guarded because a persisted
    // context does not always carry it, depending on how the row got here. See WorkflowRuleList's
    // own copy of this for the submitBatch/created() race it exists to close.
    _transientRows: function () {
      var binding = this._table() && this._table().getBinding("items");
      if (!binding) return [];
      return (binding.getCurrentContexts() || []).filter(function (context) {
        return context && context.isTransient && context.isTransient();
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
        if (this._model().hasPendingChanges(UPDATE_GROUP)) {
          MessageBox.error("The service rejected at least one rule. Check the messages and correct the row.");
          return;
        }
        // submitBatch's own promise can settle before a freshly created context has actually
        // flipped out of "transient" - see WorkflowRuleList's onSave for the full reasoning and the
        // live report that found it. A create the service genuinely rejected is already reported
        // above via hasPendingChanges, so a rejection here is not a second error to surface.
        await Promise.all(creating.map(function (context) {
          return context.created().catch(function () {});
        }));
        var unsaved = this._transientRows();
        if (unsaved.length) {
          MessageBox.error(unsaved.length + " derivation rule(s) were not saved: the service accepted "
            + "nothing for them and they are still local to this page. Reload before trying again — "
            + "leaving now loses them.");
          return;
        }
        view.setProperty("/dirty", false);
        await this._loadOptions();
        MessageToast.show("Derivation rules saved.");
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
      return result && result.value !== undefined ? result.value : result;
    },

    _errorText: function (error) {
      return (error && (error.message || error.toString())) || "unknown error";
    }
  });
});
