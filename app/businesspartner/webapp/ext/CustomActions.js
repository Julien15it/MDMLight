sap.ui.define([
  "sap/m/Button",
  "sap/m/CheckBox",
  "sap/m/Dialog",
  "sap/m/Input",
  "sap/m/Label",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/m/Select",
  "sap/m/VBox",
  "sap/ui/core/Item"
], function (Button, CheckBox, Dialog, Input, Label, MessageBox, MessageToast, Select, VBox, Item) {
  "use strict";

  function field(sLabel, oControl) {
    oControl.addStyleClass("sapUiTinyMarginBottom");
    return [new Label({ text: sLabel, labelFor: oControl }), oControl];
  }

  function requiredValue(oControl, sMessage) {
    var sValue = oControl.getValue().trim();
    oControl.setValueState(sValue ? "None" : "Error");
    oControl.setValueStateText(sMessage);
    return sValue;
  }

  function errorMessage(oError, sFallback) {
    return oError && oError.message ? oError.message : sFallback;
  }

  function selectedContexts(oBindingContext, aSelectedContexts) {
    if (Array.isArray(aSelectedContexts)) return aSelectedContexts;
    if (Array.isArray(oBindingContext)) return oBindingContext;
    return [];
  }

  function addChanged(oPayload, sProperty, vValue, vOriginalValue) {
    var vOriginal = vOriginalValue === null || vOriginalValue === undefined ? "" : vOriginalValue;
    if (vValue !== vOriginal) oPayload[sProperty] = vValue;
  }

  function environment(oHandler, oBindingContext, aSelectedContexts) {
    var aContexts = selectedContexts(oBindingContext, aSelectedContexts);
    var oView = oHandler && typeof oHandler.getView === "function"
      ? oHandler.getView()
      : oHandler && oHandler.base && typeof oHandler.base.getView === "function"
        ? oHandler.base.getView()
        : null;
    var oModel = oView && oView.getModel
      ? oView.getModel()
      : oBindingContext && oBindingContext.getModel
        ? oBindingContext.getModel()
        : aContexts[0] && aContexts[0].getModel();

    return { model: oModel, view: oView, selectedContexts: aContexts };
  }

  async function executeAction(oModel, sAction, oPayload) {
    var oActionBinding = oModel.bindContext("/" + sAction + "(...)");
    Object.keys(oPayload).forEach(function (sParameter) {
      oActionBinding.setParameter(sParameter, oPayload[sParameter]);
    });
    await oActionBinding.execute("$direct");
    var oResultContext = oActionBinding.getBoundContext();
    return oResultContext ? oResultContext.getObject() : null;
  }

  async function requestEditContext(oModel, oSelectedContext) {
    var sSelect = [
      "BusinessPartner",
      "BusinessPartnerCategory",
      "BusinessPartnerGrouping",
      "FirstName",
      "LastName",
      "OrganizationBPName1",
      "OrganizationBPName2",
      "GroupBusinessPartnerName1",
      "GroupBusinessPartnerName2",
      "SearchTerm1",
      "SearchTerm2",
      "CorrespondenceLanguage",
      "BusinessPartnerIsBlocked"
    ].join(",");
    var oBinding = oModel.bindContext(oSelectedContext.getPath(), null, { $select: sSelect });
    var oContext = oBinding.getBoundContext();
    await oContext.requestObject();
    return { binding: oBinding, context: oContext };
  }

  function attachDialog(oDialog, oView) {
    if (oView) oView.addDependent(oDialog);
    return oDialog;
  }

  function createDialog(oModel, oView) {
    var oCategory = new Select({
      width: "100%",
      selectedKey: "2",
      items: [
        new Item({ key: "1", text: "Person" }),
        new Item({ key: "2", text: "Organization" }),
        new Item({ key: "3", text: "Group" })
      ]
    });
    var oGrouping = new Input({ width: "100%", placeholder: "For example 0001", maxLength: 4 });
    var oFirstName = new Input({ width: "100%", maxLength: 40 });
    var oLastName = new Input({ width: "100%", maxLength: 40 });
    var oOrganizationName = new Input({ width: "100%", maxLength: 40 });
    var oGroupName = new Input({ width: "100%", maxLength: 40 });
    var oSearchTerm = new Input({ width: "100%", maxLength: 20 });

    var oPersonFields = new VBox({
      items: field("First Name", oFirstName).concat(field("Last Name *", oLastName))
    });
    var oOrganizationFields = new VBox({ items: field("Organization Name *", oOrganizationName) });
    var oGroupFields = new VBox({ items: field("Group Name *", oGroupName) });

    function updateCategoryFields() {
      var sCategory = oCategory.getSelectedKey();
      oPersonFields.setVisible(sCategory === "1");
      oOrganizationFields.setVisible(sCategory === "2");
      oGroupFields.setVisible(sCategory === "3");
    }

    oCategory.attachChange(updateCategoryFields);

    var oDialog = new Dialog({
      title: "Create Business Partner",
      contentWidth: "32rem",
      stretchOnPhone: true,
      content: new VBox({
        width: "100%",
        items: field("Category *", oCategory)
          .concat(field("Grouping *", oGrouping))
          .concat([oPersonFields, oOrganizationFields, oGroupFields])
          .concat(field("Search Term", oSearchTerm))
      }).addStyleClass("sapUiSmallMargin"),
      beginButton: new Button({
        text: "Create",
        type: "Emphasized",
        press: async function () {
          var sCategory = oCategory.getSelectedKey();
          var sGrouping = requiredValue(oGrouping, "Enter a business partner grouping.");
          var oPayload = {
            BusinessPartnerCategory: sCategory,
            BusinessPartnerGrouping: sGrouping
          };

          if (sCategory === "1") {
            oPayload.FirstName = oFirstName.getValue().trim();
            oPayload.LastName = requiredValue(oLastName, "Enter the last name.");
            if (!oPayload.LastName) return;
          } else if (sCategory === "2") {
            oPayload.OrganizationBPName1 = requiredValue(oOrganizationName, "Enter the organization name.");
            if (!oPayload.OrganizationBPName1) return;
          } else {
            oPayload.GroupBusinessPartnerName1 = requiredValue(oGroupName, "Enter the group name.");
            if (!oPayload.GroupBusinessPartnerName1) return;
          }

          if (!sGrouping) return;
          if (oSearchTerm.getValue().trim()) oPayload.SearchTerm1 = oSearchTerm.getValue().trim();

          oDialog.setBusy(true);
          try {
            var oCreated = await executeAction(oModel, "createBusinessPartner", oPayload);
            var sBusinessPartner = oCreated && oCreated.BusinessPartner;
            oDialog.close();
            oModel.refresh();
            MessageToast.show(
              sBusinessPartner
                ? "Business partner " + sBusinessPartner + " was created in S/4HANA."
                : "Business partner was created in S/4HANA."
            );
          } catch (oError) {
            MessageBox.error(errorMessage(oError, "The business partner could not be created in S/4HANA."));
          } finally {
            oDialog.setBusy(false);
          }
        }
      }),
      endButton: new Button({ text: "Cancel", press: function () { oDialog.close(); } }),
      afterClose: function () { oDialog.destroy(); }
    });

    updateCategoryFields();
    return attachDialog(oDialog, oView);
  }

  function editDialog(oModel, oView, oContext, oDetailBinding) {
    var sBusinessPartner = oContext.getProperty("BusinessPartner");
    var sCategory = oContext.getProperty("BusinessPartnerCategory");
    var oFirstName = new Input({ value: oContext.getProperty("FirstName") || "", maxLength: 40 });
    var oLastName = new Input({ value: oContext.getProperty("LastName") || "", maxLength: 40 });
    var oOrganizationName1 = new Input({ value: oContext.getProperty("OrganizationBPName1") || "", maxLength: 40 });
    var oOrganizationName2 = new Input({ value: oContext.getProperty("OrganizationBPName2") || "", maxLength: 40 });
    var oGroupName1 = new Input({ value: oContext.getProperty("GroupBusinessPartnerName1") || "", maxLength: 40 });
    var oGroupName2 = new Input({ value: oContext.getProperty("GroupBusinessPartnerName2") || "", maxLength: 40 });
    var oSearchTerm1 = new Input({ value: oContext.getProperty("SearchTerm1") || "", maxLength: 20 });
    var oSearchTerm2 = new Input({ value: oContext.getProperty("SearchTerm2") || "", maxLength: 20 });
    var oLanguage = new Input({ value: oContext.getProperty("CorrespondenceLanguage") || "", maxLength: 2 });
    var oBlocked = new CheckBox({ selected: Boolean(oContext.getProperty("BusinessPartnerIsBlocked")) });

    var aNameFields = [];
    if (sCategory === "1") {
      aNameFields = field("First Name", oFirstName).concat(field("Last Name *", oLastName));
    } else if (sCategory === "2") {
      aNameFields = field("Organization Name 1 *", oOrganizationName1)
        .concat(field("Organization Name 2", oOrganizationName2));
    } else {
      aNameFields = field("Group Name 1 *", oGroupName1).concat(field("Group Name 2", oGroupName2));
    }

    var oDialog = new Dialog({
      title: "Edit Business Partner " + sBusinessPartner,
      contentWidth: "32rem",
      stretchOnPhone: true,
      content: new VBox({
        width: "100%",
        items: field("Business Partner", new Input({ value: sBusinessPartner, editable: false }))
          .concat(field("Category", new Input({ value: sCategory, editable: false })))
          .concat(field("Grouping", new Input({
            value: oContext.getProperty("BusinessPartnerGrouping") || "",
            editable: false
          })))
          .concat(aNameFields)
          .concat(field("Search Term 1", oSearchTerm1))
          .concat(field("Search Term 2", oSearchTerm2))
          .concat(field("Correspondence Language", oLanguage))
          .concat(field("Blocked", oBlocked))
      }).addStyleClass("sapUiSmallMargin"),
      beginButton: new Button({
        text: "Save",
        type: "Emphasized",
        press: async function () {
          var oPayload = {
            BusinessPartner: sBusinessPartner
          };

          addChanged(oPayload, "SearchTerm1", oSearchTerm1.getValue().trim(), oContext.getProperty("SearchTerm1"));
          addChanged(oPayload, "SearchTerm2", oSearchTerm2.getValue().trim(), oContext.getProperty("SearchTerm2"));
          addChanged(
            oPayload,
            "CorrespondenceLanguage",
            oLanguage.getValue().trim(),
            oContext.getProperty("CorrespondenceLanguage")
          );
          addChanged(
            oPayload,
            "BusinessPartnerIsBlocked",
            oBlocked.getSelected(),
            Boolean(oContext.getProperty("BusinessPartnerIsBlocked"))
          );

          if (sCategory === "1") {
            var sFirstName = oFirstName.getValue().trim();
            var sLastName = requiredValue(oLastName, "Enter the last name.");
            if (!sLastName) return;
            addChanged(oPayload, "FirstName", sFirstName, oContext.getProperty("FirstName"));
            addChanged(oPayload, "LastName", sLastName, oContext.getProperty("LastName"));
          } else if (sCategory === "2") {
            var sOrganizationName1 = requiredValue(oOrganizationName1, "Enter the organization name.");
            var sOrganizationName2 = oOrganizationName2.getValue().trim();
            if (!sOrganizationName1) return;
            addChanged(
              oPayload,
              "OrganizationBPName1",
              sOrganizationName1,
              oContext.getProperty("OrganizationBPName1")
            );
            addChanged(
              oPayload,
              "OrganizationBPName2",
              sOrganizationName2,
              oContext.getProperty("OrganizationBPName2")
            );
          } else {
            var sGroupName1 = requiredValue(oGroupName1, "Enter the group name.");
            var sGroupName2 = oGroupName2.getValue().trim();
            if (!sGroupName1) return;
            addChanged(
              oPayload,
              "GroupBusinessPartnerName1",
              sGroupName1,
              oContext.getProperty("GroupBusinessPartnerName1")
            );
            addChanged(
              oPayload,
              "GroupBusinessPartnerName2",
              sGroupName2,
              oContext.getProperty("GroupBusinessPartnerName2")
            );
          }

          if (Object.keys(oPayload).length === 1) {
            MessageToast.show("No changes to save.");
            return;
          }

          oDialog.setBusy(true);
          try {
            await executeAction(oModel, "updateBusinessPartner", oPayload);
            oDialog.close();
            oModel.refresh();
            MessageToast.show("Business partner " + sBusinessPartner + " was updated in S/4HANA.");
          } catch (oError) {
            MessageBox.error(errorMessage(oError, "The business partner could not be updated in S/4HANA."));
          } finally {
            oDialog.setBusy(false);
          }
        }
      }),
      endButton: new Button({ text: "Cancel", press: function () { oDialog.close(); } }),
      afterClose: function () {
        oDialog.destroy();
        oDetailBinding.destroy();
      }
    });

    return attachDialog(oDialog, oView);
  }

  return {
    isSingleSelection: function (oBindingContext, aSelectedContexts) {
      return selectedContexts(oBindingContext, aSelectedContexts).length === 1;
    },

    openCreateDialog: function (oBindingContext, aSelectedContexts) {
      var oEnvironment = environment(this, oBindingContext, aSelectedContexts);
      if (!oEnvironment.model) {
        MessageBox.error("The Business Partner service is not available.");
        return;
      }
      createDialog(oEnvironment.model, oEnvironment.view).open();
    },

    openEditDialog: async function (oBindingContext, aSelectedContexts) {
      var oEnvironment = environment(this, oBindingContext, aSelectedContexts);
      if (!oEnvironment.model || oEnvironment.selectedContexts.length !== 1) {
        MessageBox.error("Select exactly one business partner to edit.");
        return;
      }
      try {
        var oDetail = await requestEditContext(
          oEnvironment.model,
          oEnvironment.selectedContexts[0]
        );
        editDialog(
          oEnvironment.model,
          oEnvironment.view,
          oDetail.context,
          oDetail.binding
        ).open();
      } catch (oError) {
        MessageBox.error(errorMessage(oError, "The business partner could not be loaded."));
      }
    }
  };
});
