sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "mdm/md/mdmrules/manage/ext/util/XlsxCodec"
], function (Controller, UIComponent, JSONModel, MessageBox, MessageToast, XlsxCodec) {
  "use strict";

  var UPDATE_GROUP = "ruleChanges";

  // Mirrors CONDITION_PAIRS in srv/ai/duplicate-engine.js. The column names are part of the OData
  // contract, so this is the one thing the page may hold a copy of.
  var CONDITION_PAIRS = [
    { field: "conditionField", value: "conditionValue" },
    { field: "conditionField2", value: "conditionValue2" }
  ];

  // Identity/managed columns that must never travel back on a create - `binding.create` is a POST,
  // and sending an existing key or a server-assigned timestamp is either ignored or rejected
  // depending on the column, never something worth relying on either way. Shared by Duplicate and
  // by the Excel import, since both build a fresh row from data that already carries these.
  var STRIP_ON_COPY = ["ID", "@odata.etag", "createdAt", "createdBy", "modifiedAt", "modifiedBy"];

  /**
   * The rule's own fields, mirroring the table on screen exactly - "sequence" and "threshold" exist
   * on the entity (db/duplicate-rules.cds) but are not columns here (sequence carries no semantics,
   * threshold takes the tuned default for a fuzzy rule - see onAddRule), so neither is exported. No
   * `ID` column either (dropped 2026-08-31, see WorkflowRuleList.controller.js's own copy of this
   * comment - import replaces the table wholesale now, so nothing reads it on either side).
   * The ZIP/OOXML mechanics behind export/import are shared with the other three rule pages via
   * `XlsxCodec` (see WorkflowRuleList.controller.js, built there first, 2026-08-31).
   */
  function xlsxColumns() {
    return [
      { key: "conditionField", label: "Condition 1 Field" },
      { key: "conditionValue", label: "Condition 1 Value" },
      { key: "conditionLogic", label: "Logic" },
      { key: "conditionField2", label: "Condition 2 Field" },
      { key: "conditionValue2", label: "Condition 2 Value" },
      { key: "field", label: "Field" },
      { key: "comparison", label: "Comparison" },
      { key: "indicator", label: "Indicator" },
      { key: "isActive", label: "Active" }
    ];
  }

  return Controller.extend("mdm.md.mdmrules.manage.ext.controller.DuplicateRuleList", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        busy: false,
        dirty: false,
        source: "",
        unindexed: {}
      }), "view");
      this._router = UIComponent.getRouterFor(this);
      this._loadOptions();
    },

    onBackToList: function () {
      if (this._model().hasPendingChanges(UPDATE_GROUP)) {
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

    /**
     * The component's model, not only the view's. Component models reach a view when it is placed
     * in the control tree, which for a routed view has not happened yet in onInit — so the table's
     * declarative binding resolved later and filled, while the one-shot ruleOptions() call in
     * onInit found no model at all. That is what left every dropdown empty.
     */
    _model: function () {
      var component = this.getOwnerComponent();
      return this.getView().getModel("dc") || (component && component.getModel("dc"));
    },

    _table: function () {
      return this.byId("ruleTable");
    },

    /**
     * Fields, comparisons and indicators come from the service, which reads them off the
     * code-defined catalog. A hand-kept copy here would drift the moment the catalog grows.
     */
    _loadOptions: async function () {
      var view = this.getView().getModel("view");
      try {
        var options = await this._callAction("ruleOptions", {});
        this.getView().setModel(new JSONModel(options || {}), "opt");
        view.setProperty("/source", (options && options.source) || "");
        var unindexed = {};
        (options && options.fields ? options.fields : []).forEach(function (entry) {
          if (!entry.indexed) unindexed[entry.code] = true;
        });
        view.setProperty("/unindexed", unindexed);
        // Empty dropdowns are the failure that shipped last time, so say it out loud.
        if (!options || !options.fields || !options.fields.length) {
          MessageBox.error("The rule options came back empty, so the dropdowns cannot be filled.");
        }
      } catch (error) {
        MessageBox.error("The rule options could not be loaded: " + this._errorText(error));
      }
    },

    onAddRule: function () {
      var binding = this._table().getBinding("items");
      if (!binding) return;
      // No sequence and no threshold: sequence carries no semantics, and a fuzzy rule takes the
      // tuned default. Neither is worth a column the steward has to think about.
      binding.create({
        field: "Name",
        comparison: "fuzzy",
        indicator: "strong",
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

    /** "Copy and paste" for a rule: the same fields as Add Rule, pre-filled from the selected row
     *  rather than blank - see WorkflowRuleList.controller.js's own copy of this for the reasoning. */
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
    // See WorkflowRuleList.controller.js for the full reasoning (BRF+-style, no third-party
    // dependency) - the ZIP/OOXML mechanics live in XlsxCodec, shared by all four rule pages.

    onExportExcel: function () {
      var rows = this._draftRules();
      if (!rows.length) {
        MessageToast.show("There is nothing to export yet.");
        return;
      }
      var bytes = XlsxCodec.buildWorkbook("DuplicateRules", xlsxColumns(), rows);
      var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "duplicate-check-rules.xlsx";
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

    /**
     * The imported file REPLACES the table wholesale - see WorkflowRuleList.controller.js's own copy
     * of this for the full reasoning (changed 2026-08-31: matching by ID was dropped on direct
     * feedback, in favour of just overriding with whatever the file holds). Every row currently on
     * the page is deleted and every non-blank row in the file becomes a brand new one.
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
      if (indexOfKey.field === undefined || indexOfKey.comparison === undefined) {
        MessageBox.error("This file's header row does not match the Duplicate Check Rules export "
          + "format. Export the current rules first and edit that file.");
        return;
      }

      var binding = this._table().getBinding("items");
      if (!binding) return;
      var existingRows = binding.getCurrentContexts().slice();
      existingRows.forEach(function (context) { context.delete(UPDATE_GROUP); });

      var created = 0;
      var skipped = 0;
      table.slice(1).forEach(function (row) {
        var isBlank = !row || row.every(function (cell) { return cell === undefined || cell === ""; });
        if (isBlank) return;
        var record = {};
        columns.forEach(function (column) {
          var index = indexOfKey[column.key];
          if (index === undefined) return;
          var value = row[index];
          record[column.key] = column.key === "isActive" ? XlsxCodec.isTruthyCell(value) : (value === undefined ? "" : value);
        });
        if (record.field || record.comparison) {
          binding.create(record);
          created += 1;
        } else {
          skipped += 1;
        }
      });

      this._markDirty();
      MessageToast.show(
        existingRows.length + " existing rule(s) replaced by " + created + " from the file"
        + (skipped ? ", " + skipped + " blank row(s) skipped" : "")
        + ". Review and press Save."
      );
    },

    onFieldChange: function (event) {
      this.onCellChange(event);
    },

    onCellChange: function () {
      this._markDirty();
    },

    _markDirty: function () {
      this.getView().getModel("view").setProperty("/dirty", true);
    },

    _localProblems: function (rows) {
      var problems = [];
      rows.forEach(function (rule, index) {
        var label = "Row " + (index + 1) + ": ";
        if (!rule.field) problems.push(label + "choose a field.");
        if (!rule.comparison) problems.push(label + "choose a comparison.");
        if (!rule.indicator) problems.push(label + "choose an indicator.");
        // Half a condition is the dangerous half: a field with no value would match everything.
        // The two pairs are independent — any of them may be left empty, which means "any".
        CONDITION_PAIRS.forEach(function (pair, position) {
          var name = "condition " + (position + 1);
          if (rule[pair.field] && !rule[pair.value]) {
            problems.push(label + name + " needs a value, or clear its field.");
          }
          if (rule[pair.value] && !rule[pair.field]) {
            problems.push(label + name + " needs a field.");
          }
        });
        if (rule.threshold !== null && rule.threshold !== undefined && rule.threshold !== "") {
          var threshold = Number(rule.threshold);
          if (!isFinite(threshold) || threshold <= 0 || threshold > 1) {
            problems.push(label + "a threshold must be above 0 and at most 1.");
          }
        }
      });
      return problems;
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
        // A rejected row leaves its change pending rather than silently vanishing.
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
          MessageBox.error(unsaved.length + " rule(s) were not saved: the service accepted nothing "
            + "for them and they are still local to this page. Reload before trying again — "
            + "leaving now loses them.");
          return;
        }
        view.setProperty("/dirty", false);
        // Re-read: saving the first usable row is what moves the check off the defaults, and the
        // banner has to stop claiming otherwise.
        await this._loadOptions();
        MessageToast.show("Rules saved.");
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

    // Includes unsaved edits on purpose: a test that can only run the saved ruleset cannot show
    // anyone what a change does before they commit to it.
    _draftRules: function () {
      var binding = this._table().getBinding("items");
      if (!binding) return [];
      return binding.getCurrentContexts().map(function (context) {
        var row = Object.assign({}, context.getObject());
        delete row["@odata.etag"];
        return row;
      });
    },

    onTestRuleset: async function () {
      var view = this.getView().getModel("view");
      var rules = this._draftRules();
      var problems = this._localProblems(rules);
      if (problems.length) {
        MessageBox.error(problems.join("\n"));
        return;
      }
      view.setProperty("/busy", true);
      try {
        var answer = await this._callAction("testRuleset", {
          RulesJson: JSON.stringify(rules),
          SampleSize: 10
        });
        this._showReport(JSON.parse(answer || "{}"));
      } catch (error) {
        MessageBox.error("The test could not be run: " + this._errorText(error));
      } finally {
        view.setProperty("/busy", false);
      }
    },

    _showReport: function (report) {
      if (report.tooLarge) {
        MessageBox.warning(
          "There are " + report.partners + " business partners and the test compares every pair, "
          + "which is only practical up to " + report.limit + ". Nothing was tested."
        );
        return;
      }
      var counts = report.counts || {};
      var lines = [
        report.partners + " business partners compared, " + (report.pairs || 0) + " pairs flagged.",
        "",
        "Duplicate: " + (counts.duplicate || 0),
        "Strong chance: " + (counts.strong || 0),
        "Small chance: " + (counts.small || 0)
      ];
      if (report.samples && report.samples.length) {
        lines.push("", "Examples:");
        report.samples.forEach(function (sample) {
          lines.push(
            "  " + sample.verdict + " — " + sample.businessPartner + " vs " + sample.candidateBP
            + " on " + (sample.indicators || []).join(", ")
          );
        });
      }
      MessageBox.information(lines.join("\n"), { contentWidth: "34rem" });
    },

    _callAction: async function (name, parameters) {
      var model = this._model();
      // Without this the failure surfaced as "cannot read properties of undefined", which says
      // nothing about the model never having propagated.
      if (!model) throw new Error("The duplicate configuration service is not bound to this page.");
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
