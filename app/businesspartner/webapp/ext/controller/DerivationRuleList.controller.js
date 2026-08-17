sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast"
], function (Controller, UIComponent, JSONModel, MessageToast) {
  "use strict";

  /** A preview of the screen, not of the feature — see ValidationRuleList.controller.js. */
  return Controller.extend("mdm.md.businesspartner.manage.ext.controller.DerivationRuleList", {

    onInit: function () {
      this._router = UIComponent.getRouterFor(this);
      this.getView().setModel(new JSONModel({ rules: [] }), "rules");
      this.getView().setModel(new JSONModel({
        fields: [],
        // The registries that already derive in code, so the preview names real sources.
        sources: [
          { code: "vies", text: "VIES (EU VAT register)" },
          { code: "gleif", text: "GLEIF (LEI register)" }
        ]
      }), "opt");
      this._loadFields();
    },

    onBackToHub: function () {
      this._router.navTo("MDMRuleHub", {}, true);
    },

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
        console.warn("[derivationrules] Field catalog unavailable:", error && error.message);
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
        source: "vies",
        sourceField: "",
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
