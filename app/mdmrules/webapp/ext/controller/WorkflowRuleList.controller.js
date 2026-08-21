sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/Token",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, UIComponent, Fragment, JSONModel, Filter, FilterOperator, Token, MessageBox, MessageToast) {
  "use strict";

  var UPDATE_GROUP = "ruleChanges";

  // Mirrors CONDITION_PAIRS in srv/checks/workflow-rules.js. The column names are part of the OData
  // contract, so this is the one thing the page may hold a copy of. Values plural: they are lists.
  var CONDITION_PAIRS = [
    { field: "conditionField", values: "conditionValues" },
    { field: "conditionField2", values: "conditionValues2" }
  ];

  // Mirrors DELIMITER in srv/checks/value-lists.js, and `workflowRuleOptions` reports it so the two
  // can be checked against each other rather than drifting silently.
  var DELIMITER = "|";

  var parseList = function (raw) {
    return String(raw === null || raw === undefined ? "" : raw)
      .split(DELIMITER)
      .map(function (entry) { return entry.trim(); })
      .filter(function (entry, index, all) { return entry && all.indexOf(entry) === index; });
  };

  var formatList = function (values) {
    return parseList(Array.isArray(values) ? values.join(DELIMITER) : values).join(DELIMITER);
  };

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
        if (options && options.listDelimiter && options.listDelimiter !== DELIMITER) {
          MessageBox.error("This page and the service disagree about how a list is stored ("
            + options.listDelimiter + " against " + DELIMITER + "). Multi-value cells will be wrong.");
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

    // --- The list cells ----------------------------------------------------

    /**
     * A MultiInput's tokens are an aggregation and the column is one string, so the two are kept in
     * step by hand: rendered rows get their tokens from the stored value, and every edit writes the
     * whole list back. Binding `tokens` to a string is not possible, and a formatter cannot create
     * controls.
     *
     * Re-reading from the stored value after every write is what makes it self-correcting: if the
     * control has added a token of its own for the same text, the round trip through `formatList`
     * de-duplicates it and the cell ends up showing what is actually saved.
     */
    onRowsRendered: function () {
      this._syncTokens();
    },

    _listCells: function () {
      var table = this._table();
      if (!table) return [];
      var cells = [];
      table.getItems().forEach(function (item) {
        var context = item.getBindingContext("dc");
        if (!context) return;
        item.getCells().forEach(function (cell) {
          if (!cell.isA || !cell.isA("sap.m.MultiInput")) return;
          var path = cell.data("listPath");
          if (path) cells.push({ cell: cell, context: context, path: path });
        });
      });
      return cells;
    },

    _syncTokens: function () {
      this._listCells().forEach(function (entry) {
        this._fillTokens(entry.cell, entry.context, entry.path);
      }, this);
    },

    _fillTokens: function (cell, context, path) {
      var stored = formatList(context.getProperty(path));
      // Nothing to redraw when the cell already shows what is stored - and re-templating a row while
      // someone is typing in it would take their half-typed value away.
      if (cell.data("shownList") === stored) return;
      cell.removeAllTokens();
      parseList(stored).forEach(function (value) {
        cell.addToken(new Token({ key: value, text: value }));
      });
      cell.data("shownList", stored);
    },

    /** The cell's own binding context and stored column, from the control rather than custom state. */
    _listTarget: function (cell) {
      var context = cell.getBindingContext("dc");
      var path = cell.data("listPath");
      return context && path ? { context: context, path: path } : null;
    },

    _writeTokens: function (cell, tokens) {
      var target = this._listTarget(cell);
      if (!target) return;
      var stored = formatList((tokens || cell.getTokens()).map(function (token) {
        return token.getText();
      }));
      target.context.setProperty(target.path, stored);
      // Forces the redraw below: the cell may be showing a duplicate the round trip just dropped.
      cell.data("shownList", null);
      this._fillTokens(cell, target.context, target.path);
      this._markDirty();
    },

    // `tokenUpdate` fires BEFORE the aggregation is changed, so the new list is computed from the
    // added and removed tokens rather than read back off the control.
    onListTokenUpdate: function (event) {
      var cell = event.getSource();
      var removed = event.getParameter("removedTokens") || [];
      var added = event.getParameter("addedTokens") || [];
      var tokens = cell.getTokens()
        .filter(function (token) { return removed.indexOf(token) < 0; })
        .concat(added);
      this._writeTokens(cell, tokens);
    },

    /** Enter. The value becomes a token, so a list is typed rather than assembled from a dialog. */
    onListSubmit: function (event) {
      this._takeTypedValue(event.getSource(), event.getParameter("value"));
    },

    // Leaving the cell keeps what was typed, rather than making Enter the only way to commit a value
    // - a token silently dropped on the way out is a rule quietly missing an approver.
    onListChange: function (event) {
      this._takeTypedValue(event.getSource(), event.getParameter("value"));
    },

    _takeTypedValue: function (cell, raw) {
      var values = parseList(raw);
      if (!values.length) return;
      var tokens = cell.getTokens().concat(values.map(function (value) {
        return new Token({ key: value, text: value });
      }));
      cell.setValue("");
      this._writeTokens(cell, tokens);
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
        if (!parseList(rule.approvers).length) {
          problems.push(label + "add at least one approver — an e-mail address or a role.");
        }
        // Half a condition is the dangerous half: a field with no values would match everything.
        CONDITION_PAIRS.forEach(function (pair, position) {
          var name = "condition " + (position + 1);
          if (rule[pair.field] && !parseList(rule[pair.values]).length) {
            problems.push(label + name + " needs at least one value, or clear its field.");
          }
          if (parseList(rule[pair.values]).length && !rule[pair.field]) {
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
      // The cells are showing the discarded lists, and nothing else redraws them.
      this._listCells().forEach(function (entry) {
        entry.cell.data("shownList", null);
      });
      this._syncTokens();
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
