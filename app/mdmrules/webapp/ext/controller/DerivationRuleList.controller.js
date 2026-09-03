sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "mdm/md/mdmrules/manage/ext/util/XlsxCodec",
  "mdm/md/mdmrules/manage/ext/util/ColumnResizer"
], function (Controller, UIComponent, Fragment, JSONModel, Filter, FilterOperator, MessageBox, MessageToast, XlsxCodec, ColumnResizer) {
  "use strict";

  var UPDATE_GROUP = "ruleChanges";

  // Mirrors CONDITION_PAIRS in srv/checks/rule-engine.js - see ValidationRuleList.controller.js.
  var CONDITION_PAIRS = [
    { field: "conditionField", operator: "conditionOperator", value: "conditionValue", logic: null },
    { field: "conditionField2", operator: "conditionOperator2", value: "conditionValue2", logic: "conditionLogic" },
    { field: "conditionField3", operator: "conditionOperator3", value: "conditionValue3", logic: "conditionLogic2" },
    { field: "conditionField4", operator: "conditionOperator4", value: "conditionValue4", logic: "conditionLogic3" },
    { field: "conditionField5", operator: "conditionOperator5", value: "conditionValue5", logic: "conditionLogic4" }
  ];

  /**
   * The two comparators that compare against NOTHING - EMPTINESS_COMPARISONS in
   * srv/checks/rule-engine.js. A condition under either of them is COMPLETE with no value, so the
   * "half a condition is the dangerous half" check below must not refuse it.
   */
  var EMPTINESS_COMPARISONS = ["empty", "notEmpty"];

  /** What a condition slot means with no comparator chosen, and what every condition on this table
   *  meant before there was one - see DEFAULT_CONDITION_OPERATOR in srv/checks/rule-engine.js. */
  var DEFAULT_CONDITION_OPERATOR = "eq";

  // Condition 1 is not removable: a rule with no condition at all is written by leaving it blank,
  // not by taking the column away.
  var MIN_CONDITIONS = 1;

  // Two columns are the shape this table has always had; nothing is revealed until asked for.
  var DEFAULT_CONDITIONS = 2;

  /**
   * The table's own width, in rem, for the horizontal ScrollContainer to overflow. A fixed-layout
   * table at `width="100%"` redistributes its columns into whatever space it has - which is the
   * squashing this exists to stop - so it needs a real width instead. FIXED_REM is the columns that
   * are always there; a condition is 24rem (field, comparator and value side by side, the shape
   * the Workflow page uses) and a Logic column 6rem, of which
   * there is one fewer than there are conditions. Kept here rather than as an expression binding in
   * the view so the arithmetic and the column widths it mirrors can be read in one place.
   */
  var FIXED_REM = 42;

  /**
   * The MultiSelect checkbox column (2026-09-02) is drawn by the table itself and carries no
   * `<Column>` to declare a width on, so the arithmetic has to allow for it - otherwise a
   * fixed-layout table makes room for it by squeezing every real column, which is the squashing
   * the width above exists to stop.
   */
  var SELECT_REM = 3;

  function tableWidthFor(conditions) {
    return (SELECT_REM + FIXED_REM + (24 * conditions) + (6 * (conditions - 1))) + "rem";
  }

  // Identity/managed columns that must never travel back on a create - see WorkflowRuleList's own
  // copy of this for the reasoning.
  var STRIP_ON_COPY = ["ID", "@odata.etag", "createdAt", "createdBy", "modifiedAt", "modifiedBy"];

  /** The rule's own fields, mirroring the table on screen exactly - see ValidationRuleList.controller.js.
   *  No `ID` column (dropped 2026-08-31 - see WorkflowRuleList.controller.js's own copy of this comment). */
  function xlsxColumns() {
    return [
      { key: "conditionField", label: "Condition 1 Field" },
      { key: "conditionOperator", label: "Condition 1 Operator" },
      { key: "conditionValue", label: "Condition 1 Value" },
      { key: "conditionLogic", label: "Logic" },
      { key: "conditionField2", label: "Condition 2 Field" },
      { key: "conditionOperator2", label: "Condition 2 Operator" },
      { key: "conditionValue2", label: "Condition 2 Value" },
      { key: "conditionLogic2", label: "Logic 2" },
      { key: "conditionField3", label: "Condition 3 Field" },
      { key: "conditionOperator3", label: "Condition 3 Operator" },
      { key: "conditionValue3", label: "Condition 3 Value" },
      { key: "conditionLogic3", label: "Logic 3" },
      { key: "conditionField4", label: "Condition 4 Field" },
      { key: "conditionOperator4", label: "Condition 4 Operator" },
      { key: "conditionValue4", label: "Condition 4 Value" },
      { key: "conditionLogic4", label: "Logic 4" },
      { key: "conditionField5", label: "Condition 5 Field" },
      { key: "conditionOperator5", label: "Condition 5 Operator" },
      { key: "conditionValue5", label: "Condition 5 Value" },
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
        // How many condition columns are drawn, and the ceiling the schema imposes. The ceiling is
        // replaced by the service's own `conditionSlots` once the options load, so the button and
        // the table cannot disagree with the columns that actually exist.
        conditions: DEFAULT_CONDITIONS,
        maxConditions: CONDITION_PAIRS.length,
        tableWidth: tableWidthFor(DEFAULT_CONDITIONS),
        // Pixels the header drags have added to, or taken off, the table's own width.
        widthAdjust: 0,
        // Qualified name -> label, so a Value that names a field can say so under the cell. This is
        // the one place the page tells a steward which of the Value column's two meanings it read.
        fieldText: {},
        skipped: 0,
        skippedText: ""
      }), "view");
      this._router = UIComponent.getRouterFor(this);
      // A saved rule that already uses more than two conditions has to show them without anyone
      // pressing Add Condition first, and rows arrive after this runs - so the count is recomputed
      // every time the table finishes rendering its items.
      if (this._table()) this._table().attachUpdateFinished(this._syncConditionColumns, this);
      // Resize a column by dragging the BORDER between two header cells (2026-09-02, asked for).
      // Nothing is reordered; sap.m.Table has no resizing of its own, so the grips are real DOM -
      // see ext/util/ColumnResizer.js.
      ColumnResizer.enable(this._table(), { onResize: this._onColumnResized.bind(this) });
      this._loadOptions();
    },

    /**
     * Reveals one more Logic/Condition column pair, for every row at once - "an extra Logic and an
     * extra Condition column into our table", the same mechanism the Workflow Agent Determination
     * table uses. Nothing is written: the columns are already on every row, so this only decides how
     * many of them are drawn.
     */
    onAddCondition: function () {
      var max = this._maxConditions();
      var shown = this._shownConditions();
      if (shown >= max) {
        MessageToast.show("A rule can hold " + max + " conditions.");
        return;
      }
      this._setConditionColumns(shown + 1);
    },

    /**
     * Removes the LAST shown condition and CLEARS that slot on every row. Hiding the column alone is
     * not enough: the values stay on the row and the engine keeps evaluating them, so a rule would
     * go on matching on a condition nobody can see. Confirmed first when any row actually holds
     * something - it is a real edit, undoable only by Discard until Save. Condition 1 is never
     * removable (the button is disabled, and this refuses anyway).
     */
    onDeleteCondition: function () {
      var shown = this._shownConditions();
      if (shown <= MIN_CONDITIONS) return;
      var slot = CONDITION_PAIRS[shown - 1];
      var filled = this._rowsUsingSlot(slot);
      if (!filled.length) {
        this._setConditionColumns(shown - 1);
        return;
      }
      var that = this;
      MessageBox.confirm(
        "Condition " + shown + " is filled in on " + filled.length + " rule(s). Removing the column "
          + "clears it on those rules, so nothing is left matching on a condition nobody can see.",
        {
          onClose: function (action) {
            if (action !== MessageBox.Action.OK) return;
            that._clearConditionSlot(slot, filled);
            that._markDirty();
            that._setConditionColumns(shown - 1);
          }
        }
      );
    },

    // The rows carrying anything in this slot - the ones a removal would actually change. The Logic
    // column is not asked about: it is not a condition on its own.
    _rowsUsingSlot: function (slot) {
      var binding = this._table() && this._table().getBinding("items");
      if (!binding) return [];
      return (binding.getCurrentContexts() || []).filter(function (context) {
        var row = context && context.getObject();
        return Boolean(row && (row[slot.field] || row[slot.value]));
      });
    },

    // Only the rows that hold something are written to, so removing an empty column costs no PATCH
    // and does not mark the page dirty. The Logic column goes back to AND rather than to blank: it
    // is the value a fresh row carries, so re-adding the column later renders a chosen join.
    _clearConditionSlot: function (slot, contexts) {
      contexts.forEach(function (context) {
        context.setProperty(slot.field, null);
        // The comparator goes back to `eq` rather than to blank, for the same reason the Logic
        // column goes back to AND: it is what a fresh row carries, so re-adding the column later
        // renders a chosen comparator instead of an empty cell the engine reads as `eq` anyway.
        context.setProperty(slot.operator, DEFAULT_CONDITION_OPERATOR);
        context.setProperty(slot.value, null);
        if (slot.logic) context.setProperty(slot.logic, "AND");
      });
    },

    _shownConditions: function () {
      return this.getView().getModel("view").getProperty("/conditions") || DEFAULT_CONDITIONS;
    },

    _maxConditions: function () {
      return this.getView().getModel("view").getProperty("/maxConditions") || CONDITION_PAIRS.length;
    },

    // The one place the count changes, so the table's own width can never drift from the number of
    // columns actually drawn.
    _setConditionColumns: function (count) {
      var view = this.getView().getModel("view");
      var bounded = Math.min(Math.max(count, MIN_CONDITIONS), this._maxConditions());
      view.setProperty("/conditions", bounded);
      this._applyTableWidth();
    },

    /**
     * The table's width: the columns it draws, plus whatever the header drags have added or taken
     * away. One setter, so revealing a condition can never silently undo a resize; written as
     * `calc()` rather than resolved to pixels, because the rem half still has to follow the page's
     * own font size.
     */
    _applyTableWidth: function () {
      var view = this.getView().getModel("view");
      var rem = tableWidthFor(view.getProperty("/conditions") || DEFAULT_CONDITIONS);
      var adjust = Math.round(view.getProperty("/widthAdjust") || 0);
      view.setProperty("/tableWidth", adjust
        ? "calc(" + rem + (adjust > 0 ? " + " : " - ") + Math.abs(adjust) + "px)"
        : rem);
    },

    // A header drag resized ONE column, so the table grows (or shrinks) by exactly that much - which
    // is what stops a widened column taking its space from the column beside it.
    _onColumnResized: function (delta) {
      var view = this.getView().getModel("view");
      view.setProperty("/widthAdjust", (view.getProperty("/widthAdjust") || 0) + delta);
      this._applyTableWidth();
    },

    // The highest slot any row actually fills, never fewer than what is already on screen: a steward
    // who revealed a column and left it empty should not have it taken away on the next render.
    // Deleting a condition clears the slot first, which is what stops this putting it straight back.
    _syncConditionColumns: function () {
      var shown = this._shownConditions();
      this._draftRules().forEach(function (rule) {
        CONDITION_PAIRS.forEach(function (slot, index) {
          if (rule[slot.field] && index + 1 > shown) shown = index + 1;
        });
      });
      this._setConditionColumns(shown);
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
        if (options && options.conditionSlots) {
          view.setProperty("/maxConditions", options.conditionSlots);
        }
        this._syncConditionColumns();
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
      // Every Logic column defaults to AND, not only the first: a revealed column with nothing
      // chosen would otherwise render blank while the engine reads it as AND anyway.
      binding.create({
        sequence: 10,
        conditionLogic: "AND",
        conditionLogic2: "AND",
        conditionLogic3: "AND",
        conditionLogic4: "AND",
        // Every comparator defaults to `eq` for the same reason: a blank cell the engine reads as
        // equality anyway is a cell that does not say what the rule does.
        conditionOperator: DEFAULT_CONDITION_OPERATOR,
        conditionOperator2: DEFAULT_CONDITION_OPERATOR,
        conditionOperator3: DEFAULT_CONDITION_OPERATOR,
        conditionOperator4: DEFAULT_CONDITION_OPERATOR,
        conditionOperator5: DEFAULT_CONDITION_OPERATOR,
        isActive: true
      });
      this._markDirty();
    },

    onDeleteRule: function () {
      // Every selected row since 2026-09-02: the table is MultiSelect, and Delete acting on one of
      // several ticked rules would be the wrong half of what was asked for.
      var items = this._table().getSelectedItems();
      if (!items.length) {
        MessageToast.show("Select the rule(s) to delete.");
        return;
      }
      var contexts = items
        .map(function (item) { return item.getBindingContext("dc"); })
        .filter(Boolean);
      if (!contexts.length) return;
      MessageBox.confirm(
        contexts.length === 1 ? "Delete this rule?" : "Delete these " + contexts.length + " rules?",
        {
          onClose: function (action) {
            if (action !== MessageBox.Action.OK) return;
            contexts.forEach(function (context) { context.delete(UPDATE_GROUP); });
            // The rows are gone; a selection pointing at them is not a selection any more.
            this._table().removeSelections(true);
            this._markDirty();
          }.bind(this)
        }
      );
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
      var items = this._table().getSelectedItems();
      if (!items.length) {
        MessageToast.show("Select the rule(s) to duplicate.");
        return;
      }
      var binding = this._table().getBinding("items");
      if (!binding) return;
      items.forEach(function (item) {
        var context = item.getBindingContext("dc");
        if (!context) return;
        var copy = Object.assign({}, context.getObject());
        STRIP_ON_COPY.forEach(function (key) { delete copy[key]; });
        binding.create(copy);
      });
      this._table().removeSelections(true);
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
      if (indexOfKey.field === undefined || indexOfKey.value === undefined) {
        MessageBox.error("This file's header row does not match the Derivation Rules export format. "
          + "Export the current rules first and edit that file.");
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
        if (record.field || record.value) {
          binding.create(record);
          created += 1;
        } else {
          skipped += 1;
        }
      });

      this._markDirty();
      // An imported row may fill in a condition the page was not drawing yet.
      this._syncConditionColumns();
      MessageToast.show(
        existingRows.length + " existing rule(s) replaced by " + created + " from the file"
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
          // Except under `is empty` / `is not empty`, which are a whole condition with no value.
          var wantsValue = EMPTINESS_COMPARISONS.indexOf(rule[pair.operator] || DEFAULT_CONDITION_OPERATOR) === -1;
          if (rule[pair.field] && wantsValue && !rule[pair.value]) {
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
      var binding = this._table() && this._table().getBinding("items");
      if (!binding) return [];
      // `getCurrentContexts()` may hold UNDEFINED entries for rows the model has not delivered yet:
      // `_loadOptions` runs its `_syncConditionColumns` while the row $batch is still in flight, and
      // reading `.getObject()` off one of those threw "Cannot read properties of undefined" - the
      // error that took every rule tile down (2026-09-03). `_rowsUsingSlot` already guarded this
      // way; a row that has not arrived is not a draft, and the next call sees it.
      return (binding.getCurrentContexts() || []).map(function (context) {
        return context && context.getObject();
      }).filter(Boolean).map(function (data) {
        var row = Object.assign({}, data);
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
      // Discarding a Delete Condition puts the values back, but nothing redraws the column they
      // came back into: `resetChanges` restores properties on the contexts that are already there,
      // so no row is added or removed and `updateFinished` never fires - the hook `_syncConditionColumns`
      // normally rides on. The slot was left filled and invisible, and only Add Condition brought it
      // back (with its values intact, which is what gave the bug away). Synced by hand here, which is
      // safe precisely because the sync only ever RAISES the count to the highest filled slot.
      this._syncConditionColumns();
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
