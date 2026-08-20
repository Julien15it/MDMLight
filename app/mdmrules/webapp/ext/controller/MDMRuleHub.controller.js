sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent"
], function (Controller, UIComponent) {
  "use strict";

  return Controller.extend("mdm.md.mdmrules.manage.ext.controller.MDMRuleHub", {

    onInit: function () {
      this._router = UIComponent.getRouterFor(this);
    },

    // Back leaves for the site itself, not for another tile: an empty shellHash is the launchpad
    // home. Outside a launchpad there is no shell service and the button does nothing.
    onBackToSite: function () {
      var shell = sap.ushell && sap.ushell.Container;
      if (!shell) return;
      shell.getServiceAsync("CrossApplicationNavigation").then(function (navigation) {
        navigation.toExternal({ target: { shellHash: "#" } });
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
    },

    onFieldProperties: function () {
      this._router.navTo("FieldPropertyProfileList");
    }

  });
});
