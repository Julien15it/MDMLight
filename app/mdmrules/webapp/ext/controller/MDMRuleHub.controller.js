sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, UIComponent, MessageBox, MessageToast) {
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
    },

    /**
     * The switch is bound two-way to the perm model, so it has already moved by the time
     * this runs. On failure it is put back, because leaving it where the user dragged it
     * would claim a setting the server never accepted.
     */
    onToggleAiAssistance: async function (event) {
      var enabled = event.getParameter("state");
      var permissions = this.getOwnerComponent().getModel("perm");
      var control = event.getSource();
      control.setBusy(true);
      try {
        // The switch lives on the config service, not the main one: the main service only
        // reports the flag, and writing it needs the Steward scope this service requires.
        var model = this.getOwnerComponent().getModel("dc");
        if (!model) throw new Error("The rule configuration service is not bound to this page.");
        var binding = model.bindContext("/setAiAssistanceEnabled(...)");
        binding.setParameter("Enabled", enabled);
        try {
          await binding.execute("$direct");
          var context = binding.getBoundContext();
          var result = context ? context.getObject() : null;
          // Trust what came back rather than what was clicked.
          var saved = !result || result.aiAssistanceEnabled !== false;
          permissions.setProperty("/aiAssistanceEnabled", saved);
        } finally {
          binding.destroy();
        }
        MessageToast.show("AI assistance switched " + (enabled ? "on" : "off") + ".");
      } catch (error) {
        permissions.setProperty("/aiAssistanceEnabled", !enabled);
        MessageBox.error(
          (error && (error.message || error.error && error.error.message))
          || "The setting could not be saved."
        );
      } finally {
        control.setBusy(false);
      }
    }

  });
});
