sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "mdm/md/businesspartner/manage/ext/CustomActions"
], function (ControllerExtension, CustomActions) {
  "use strict";

  return ControllerExtension.extend(
    "mdm.md.businesspartner.manage.ext.controller.ListReportExtension",
    {
      override: {
        onInit: function () {
          var oView = this.base.getView();
          var oExtensionAPI = this.base.getExtensionAPI();
          var oModel = oExtensionAPI && typeof oExtensionAPI.getModel === "function"
            ? oExtensionAPI.getModel()
            : null;

          oModel = oModel || oView.getModel();

          CustomActions.setEnvironment(oModel, oView);
        },

        onExit: function () {
          CustomActions.clearEnvironment();
        },

        routing: {
          onBeforeNavigation: function (contextInfo) {
            CustomActions.openDisplayPage(contextInfo && contextInfo.bindingContext);
            return true;
          }
        }
      }
    }
  );
});
