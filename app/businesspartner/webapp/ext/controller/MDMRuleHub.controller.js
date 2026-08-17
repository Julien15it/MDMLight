sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent"
], function (Controller, UIComponent) {
  "use strict";

  return Controller.extend("mdm.md.businesspartner.manage.ext.controller.MDMRuleHub", {

    onInit: function () {
      this._router = UIComponent.getRouterFor(this);
    },

    onBackToList: function () {
      this._router.navTo("BusinessPartnersList", {}, true);
    },

    onDuplicateRules: function () {
      this._router.navTo("DuplicateRuleList");
    },

    onValidationRules: function () {
      this._router.navTo("ValidationRuleList");
    },

    onDerivationRules: function () {
      this._router.navTo("DerivationRuleList");
    }

  });
});
