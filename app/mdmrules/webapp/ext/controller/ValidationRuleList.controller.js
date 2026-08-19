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

  // Mirrors CONDITION_PAIRS in srv/checks/rule-engine.js. The column names are part of the OData
  // contract, so this is the one thing the page may hold a copy of.
  var CONDITION_PAIRS = [
    { field: "conditionField", value: "conditionValue" },
    { field: "conditionField2", value: "conditionValue2" }
  ];

  /**
   * The Validation Rules decision table. Rows are real: they live in
   * `mdmlight.config.ValidationRules` and the pipeline runs them on Check and on Submit.
   *
   * Deliberately the same page shape as DuplicateRuleList - one update group, batch on Save,
   * `resetChanges` on Discard - because they are the same kind of table and a steward should not
   * have to learn two.
   */
  return Controller.extend("mdm.md.mdmrules.manage.ext.controller.ValidationRuleList", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        busy: false,
        dirty: false,
        // code -> false for the comparisons that compare against nothing, so the Value cell can
        // disable itself rather than accept a value the engine will ignore.
        needsValue: {},
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

    /**
     * The component's model, not only the view's. Component models reach a view when it is placed
     * in the control tree, which for a routed view has not happened yet in onInit - the trap that
     * left the duplicate page's dropdowns empty the first time round.
     */
    _model: function () {
      var component = this.getOwnerComponent();
      return this.getView().getModel("dc") || (component && component.getModel("dc"));
    },

    _table: function () {
      return this.byId("ruleTable");
    },

    /** Fields from the staging model, comparisons and severities from the engine. */
    _loadOptions: async function () {
      var view = this.getView().getModel("view");
      try {
        var options = await this._callAction("qualityRuleOptions", {});
        this.getView().setModel(new JSONModel(options || {}), "opt");
        var needsValue = {};
        (options && options.comparisons ? options.comparisons : []).forEach(function (entry) {
          needsValue[entry.code] = entry.needsValue !== false;
        });
        view.setProperty("/needsValue", needsValue);
        this._reportSkipped(options);
        if (!options || !options.fields || !options.fields.length) {
          MessageBox.error("The field catalog came back empty, so no rule can be written. "
            + "The staging model could not be read.");
        }
      } catch (error) {
        MessageBox.error("The rule options could not be loaded: " + this._errorText(error));
      }
    },

    /**
     * A saved rule that would not run is the failure worth naming: it looks configured and does
     * nothing. The service counts the runnable ones, so this compares that against what is stored.
     */
    _reportSkipped: function (options) {
      var view = this.getView().getModel("view");
      var runnable = options && options.validationCount;
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
      // No field and no value: there is no sensible default field, and a row that arrived
      // pre-pointed at one would be a rule nobody wrote. Comparison and severity have honest
      // defaults - the commonest rule is an equality that blocks.
      binding.create({
        sequence: 10,
        comparison: "eq",
        severity: "error",
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

    onCellChange: function () {
      this._markDirty();
    },

    _markDirty: function () {
      this.getView().getModel("view").setProperty("/dirty", true);
    },

    // -----------------------------------------------------------------------
    // The field value help
    // -----------------------------------------------------------------------

    /**
     * Opened from any cell that can name a field: both conditions, the Field column, and the Value
     * column (where a field means "compare against that field"). The cell is identified by its own
     * binding rather than by custom data - `getBinding("value").getPath()` already knows which
     * property it writes, so there is nothing to keep in step.
     */
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

    onFieldChosen: function (event) {
      var selected = event.getParameter("selectedItem");
      this.onFieldSearchClosed(event);
      if (!selected || !this._target) return;
      // The qualified code is what is stored - the label is for reading, and storing it would make
      // a rule that no longer resolves the moment a label is reworded.
      this._target.context.setProperty(this._target.path, selected.getDescription());
      this._markDirty();
    },

    /** The filter is on the shared fragment, so leaving it set would carry into the next cell. */
    onFieldSearchClosed: function (event) {
      var items = event.getSource().getBinding("items");
      if (items) items.filter([]);
    },

    // -----------------------------------------------------------------------
    // Save
    // -----------------------------------------------------------------------

    /**
     * The same checks `validateValidationRule` makes server-side, so a steward is told at the
     * keyboard rather than by a rejected batch. The service still validates - this is a courtesy,
     * not the guard.
     */
    _localProblems: function (rows) {
      var needsValue = this.getView().getModel("view").getProperty("/needsValue");
      var problems = [];
      rows.forEach(function (rule, index) {
        var label = "Row " + (index + 1) + ": ";
        if (!rule.field) problems.push(label + "choose the field to validate.");
        if (!rule.comparison) problems.push(label + "choose a comparison.");
        if (rule.comparison && needsValue[rule.comparison] !== false && !rule.value) {
          problems.push(label + "this comparison needs a value.");
        }
        // Half a condition is the dangerous half: a field with no value would match everything.
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
        view.setProperty("/dirty", false);
        // Re-read: what is running has changed, and the banner has to stop claiming otherwise.
        await this._loadOptions();
        MessageToast.show("Validation rules saved.");
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
