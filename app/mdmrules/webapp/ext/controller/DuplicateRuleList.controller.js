sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, UIComponent, JSONModel, MessageBox, MessageToast) {
  "use strict";

  var UPDATE_GROUP = "ruleChanges";

  // Mirrors CONDITION_PAIRS in srv/ai/duplicate-engine.js. The column names are part of the OData
  // contract, so this is the one thing the page may hold a copy of.
  var CONDITION_PAIRS = [
    { field: "conditionField", value: "conditionValue" },
    { field: "conditionField2", value: "conditionValue2" }
  ];

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
