sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast"
], function (Controller, UIComponent, JSONModel, MessageToast) {
  "use strict";

  /**
   * A preview of the screen, not of the feature. Rows live in a local JSON model and go away with
   * the page: nothing is stored, nothing is executed, and the table says so. Binding this to the
   * DuplicateRules entity set to "make it work" would be the one genuinely wrong move here — it
   * would show duplicate rules under a Validation Rules heading and let someone edit them by
   * accident.
   *
   * The field catalog is the real one (`ruleOptions`), because the shape of a rule is what we are
   * agreeing on and empty dropdowns would make it unreadable.
   */
  return Controller.extend("mdm.md.businesspartner.manage.ext.controller.ValidationRuleList", {

    onInit: function () {
      this._router = UIComponent.getRouterFor(this);
      this.getView().setModel(new JSONModel({ rules: [] }), "rules");
      this.getView().setModel(new JSONModel({
        fields: [],
        checks: [
          { code: "required", text: "Must have a value" },
          { code: "format", text: "Must match a format" },
          { code: "registry", text: "Must exist in an official register" }
        ],
        severities: [
          { code: "error", text: "Block the request" },
          { code: "warning", text: "Warn, but allow" }
        ]
      }), "opt");
      this._loadFields();
    },

    onBackToHub: function () {
      this._router.navTo("MDMRuleHub", {}, true);
    },

    /** The same catalog the duplicate rules use — one source, so it cannot go stale separately. */
    _loadFields: async function () {
      var model = this.getView().getModel("dc") || this.getOwnerComponent().getModel("dc");
      if (!model || !model.bindContext) return;
      var binding = model.bindContext("/ruleOptions(...)");
      try {
        await binding.execute("$direct");
        var context = binding.getBoundContext();
        var options = context ? context.getObject() : null;
        if (options && options.fields) {
          this.getView().getModel("opt").setProperty("/fields", options.fields);
        }
      } catch (error) {
        // A preview with empty dropdowns is still a readable preview, so this never interrupts.
        console.warn("[validationrules] Field catalog unavailable:", error && error.message);
      } finally {
        binding.destroy();
      }
    },

    onAddRule: function () {
      var rules = this.getView().getModel("rules");
      rules.setProperty("/rules", rules.getProperty("/rules").concat({
        conditionField: "",
        conditionValue: "",
        conditionField2: "",
        conditionValue2: "",
        field: "",
        check: "required",
        severity: "error",
        isActive: true
      }));
    },

    onDeleteRule: function () {
      var table = this.byId("ruleTable");
      var item = table && table.getSelectedItem();
      if (!item) {
        MessageToast.show("Select the rule to delete.");
        return;
      }
      var rules = this.getView().getModel("rules");
      var index = Number(item.getBindingContext("rules").getPath().split("/").pop());
      rules.setProperty("/rules", rules.getProperty("/rules").filter(function (rule, at) {
        return at !== index;
      }));
    }

  });
});
