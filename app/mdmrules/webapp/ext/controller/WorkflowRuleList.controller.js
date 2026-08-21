sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "mdm/md/mdmrules/manage/ext/ListCell"
], function (Controller, UIComponent, Fragment, JSONModel, Filter, FilterOperator, MessageBox, MessageToast, ListCell) {
  "use strict";

  var UPDATE_GROUP = "ruleChanges";

  // Mirrors CONDITION_PAIRS in srv/checks/workflow-rules.js. The column names are part of the OData
  // contract, so this is the one thing the page may hold a copy of. Values plural: they are lists.
  var CONDITION_PAIRS = [
    { field: "conditionField", values: "conditionValues" },
    { field: "conditionField2", values: "conditionValues2" }
  ];

  // Who approves what. Same page shape as the other three rule tables, because a steward should not
  // have to learn two - the only new idea is a cell that holds a list.
  return Controller.extend("mdm.md.mdmrules.manage.ext.controller.WorkflowRuleList", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        busy: false,
        dirty: false,
        skipped: 0,
        skippedText: ""
      }), "view");
      this._router = UIComponent.getRouterFor(this);
      // The condition value cells hold a LIST. The handlers behind them are shared rather than
      // copied into every rule page - see app/mdmrules/webapp/ext/ListCell.js.
      ListCell.mixin(this, {
        getTable: this._table.bind(this),
        onChanged: this._markDirty.bind(this)
      });
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
        // A page splitting on a different character from the one the service stores would show one
        // token where three are saved, so it is worth saying out loud rather than debugging twice.
        if (options && options.listDelimiter && options.listDelimiter !== ListCell.DELIMITER) {
          MessageBox.error("This page and the service disagree about how a list is stored ("
            + options.listDelimiter + " against " + ListCell.DELIMITER
            + "). Multi-value cells will be wrong.");
        }
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

    // --- The role value help -----------------------------------------------

    /**
     * The roles half of the approver cell. Typing an address is the other half and needs no dialog;
     * a role has to be spelled exactly as SBPA knows it, so it is picked rather than remembered.
     *
     * `multiSelect`, so naming three roles is one trip through the dialog. The chosen codes are
     * ADDED to whatever the cell already holds - an approver list is built up, not replaced, and a
     * dialog that wiped the two addresses already in the cell would be a trap.
     */
    onRoleValueHelp: async function (event) {
      this._roleCell = event.getSource();
      if (!this._roleHelp) {
        this._roleHelp = await Fragment.load({
          id: this.getView().getId() + "-roles",
          name: "mdm.md.mdmrules.manage.ext.fragment.RoleValueHelp",
          controller: this
        });
        this.getView().addDependent(this._roleHelp);
      }
      // Cleared on the way IN, never on the way out - the same rule the field value help follows,
      // and for the same reason: resetting a filtered list re-templates its rows.
      var items = this._roleHelp.getBinding("items");
      if (items) items.filter([]);
      this._roleHelp.open("");
    },

    onRoleSearch: function (event) {
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

    // The codes are read off their binding contexts before anything touches the list, for the
    // reason spelled out on onFieldChosen: a reset re-binds the items to different rows.
    onRolesChosen: function (event) {
      var selected = event.getParameter("selectedItems")
        || (event.getParameter("selectedItem") ? [event.getParameter("selectedItem")] : []);
      var codes = selected.map(function (item) {
        var context = item.getBindingContext("opt");
        return context && context.getProperty("code");
      }).filter(Boolean);
      if (!codes.length || !this._roleCell) return;
      this.addListValues(this._roleCell, codes);
    },

    // --- The field value help ----------------------------------------------

    // Opened from either condition field cell. The cell is identified by its own binding rather than
    // custom data: `getBinding("value").getPath()` already knows what it writes.
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
        if (!ListCell.parseList(rule.approvers).length) {
          problems.push(label + "add at least one approver — an e-mail address or a role.");
        }
        // Half a condition is the dangerous half: a field with no values would match everything.
        CONDITION_PAIRS.forEach(function (pair, position) {
          var name = "condition " + (position + 1);
          if (rule[pair.field] && !ListCell.parseList(rule[pair.values]).length) {
            problems.push(label + name + " needs at least one value, or clear its field.");
          }
          if (ListCell.parseList(rule[pair.values]).length && !rule[pair.field]) {
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
      // The token cells are showing the abandoned lists, and nothing else redraws them.
      this.resetListCells();
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
