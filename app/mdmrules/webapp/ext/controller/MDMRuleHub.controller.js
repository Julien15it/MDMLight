sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent"
], function (Controller, UIComponent) {
  "use strict";

  return Controller.extend("mdm.md.mdmrules.manage.ext.controller.MDMRuleHub", {

    onInit: function () {
      this._router = UIComponent.getRouterFor(this);
    },

    // The hub is this app's root, so back means the Business Partner app - a cross-app intent,
    // not a route. Outside a launchpad there is no shell service and the button does nothing.
    onBackToList: function () {
      var shell = sap.ushell && sap.ushell.Container;
      if (!shell) return;
      shell.getServiceAsync("CrossApplicationNavigation").then(function (navigation) {
        navigation.toExternal({ target: { semanticObject: "BusinessPartner", action: "manage" } });
      });
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
