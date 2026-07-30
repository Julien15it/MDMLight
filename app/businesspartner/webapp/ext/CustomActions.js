sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/m/MessageBox"
], function (UIComponent, MessageBox) {
  "use strict";

  var applicationView = null;

  function selectedContexts(bindingContext, contexts) {
    if (Array.isArray(contexts)) return contexts;
    if (Array.isArray(bindingContext)) return bindingContext;
    return [];
  }

  function router() {
    var controller = applicationView && applicationView.getController
      ? applicationView.getController()
      : null;
    return controller ? UIComponent.getRouterFor(controller) : null;
  }

  return {
    setEnvironment: function (_model, view) {
      applicationView = view;
    },

    clearEnvironment: function () {
      applicationView = null;
    },

    isSingleSelection: function (bindingContext, contexts) {
      return selectedContexts(bindingContext, contexts).length === 1;
    },

    openCreatePage: function () {
      var appRouter = router();
      if (!appRouter) {
        MessageBox.error("The Business Partner maintenance page is not available.");
        return;
      }
      appRouter.navTo("BusinessPartnerCreate");
    },

    openEditPage: function (bindingContext, contexts) {
      var selected = selectedContexts(bindingContext, contexts);
      var appRouter = router();
      if (!appRouter || selected.length !== 1) {
        MessageBox.error("Select exactly one Business Partner to edit.");
        return;
      }

      appRouter.navTo("BusinessPartnerMaintain", {
        businessPartner: selected[0].getProperty("BusinessPartner")
      });
    }
  };
});
