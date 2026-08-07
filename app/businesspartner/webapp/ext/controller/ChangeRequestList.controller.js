sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (Controller, UIComponent, JSONModel, Filter, FilterOperator) {
  "use strict";

  return Controller.extend("mdm.md.businesspartner.manage.ext.controller.ChangeRequestList", {

    onInit: function () {
      this.getView().setModel(new JSONModel({ busy: false }), "view");
      this._router = UIComponent.getRouterFor(this);
    },

    onBackToList: function () {
      this._router.navTo("BusinessPartnersList", {}, true);
    },

    onRefresh: function () {
      var binding = this.byId("changeRequestTable").getBinding("items");
      if (binding) binding.refresh();
    },

    onSearch: function (event) {
      var term = (event.getParameter("query") || "").trim();
      var binding = this.byId("changeRequestTable").getBinding("items");
      if (!binding) return;
      binding.filter(term ? new Filter({
        filters: [
          new Filter("businessPartner", FilterOperator.Contains, term),
          new Filter("status", FilterOperator.Contains, term),
          new Filter("requestType", FilterOperator.Contains, term)
        ],
        and: false
      }) : []);
    },

    /**
     * A draft is still the requester's to change; anything further along is
     * owned by the approval process, so it opens read-only in the approve view.
     */
    onOpenRequest: function (event) {
      var context = event.getParameter("listItem").getBindingContext("cr");
      if (!context) return;
      var changeRequest = context.getProperty("ID");
      var status = context.getProperty("status");
      this._router.navTo(
        status === "draft" ? "ChangeRequestEdit" : "ChangeRequestApprove",
        { changeRequest: encodeURIComponent(changeRequest) }
      );
    }
  });
});
