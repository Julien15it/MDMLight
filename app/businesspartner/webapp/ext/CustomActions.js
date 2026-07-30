sap.ui.define([
  "sap/m/Button",
  "sap/m/Dialog",
  "sap/m/Input",
  "sap/m/Label",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/m/Select",
  "sap/m/VBox",
  "sap/ui/core/Item"
], function (Button, Dialog, Input, Label, MessageBox, MessageToast, Select, VBox, Item) {
  "use strict";

  function field(sLabel, oControl) {
    oControl.addStyleClass("sapUiTinyMarginBottom");
    return [
      new Label({ text: sLabel, labelFor: oControl }),
      oControl
    ];
  }

  function requiredValue(oControl, sMessage) {
    var sValue = oControl.getValue().trim();
    oControl.setValueState(sValue ? "None" : "Error");
    oControl.setValueStateText(sMessage);
    return sValue;
  }

  function errorMessage(oError) {
    return oError && oError.message
      ? oError.message
      : "The business partner could not be created in S/4HANA.";
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
    var oOrganizationFields = new VBox({
      items: field("Organization Name *", oOrganizationName)
    });
    var oGroupFields = new VBox({
      items: field("Group Name *", oGroupName)
    });

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
            oPayload.OrganizationBPName1 = requiredValue(
              oOrganizationName,
              "Enter the organization name."
            );
            if (!oPayload.OrganizationBPName1) return;
          } else {
            oPayload.GroupBusinessPartnerName1 = requiredValue(oGroupName, "Enter the group name.");
            if (!oPayload.GroupBusinessPartnerName1) return;
          }

          if (!sGrouping) return;
          if (oSearchTerm.getValue().trim()) oPayload.SearchTerm1 = oSearchTerm.getValue().trim();

          oDialog.setBusy(true);
          try {
            var oListBinding = oModel.bindList("/BusinessPartners", null, null, null, {
              $$updateGroupId: "$direct"
            });
            var oCreatedContext = oListBinding.create(oPayload);

            await oCreatedContext.created();
            var sBusinessPartner = oCreatedContext.getProperty("BusinessPartner");

            oDialog.close();
            oModel.refresh();
            MessageToast.show(
              sBusinessPartner
                ? "Business partner " + sBusinessPartner + " was created in S/4HANA."
                : "Business partner was created in S/4HANA."
            );
          } catch (oError) {
            MessageBox.error(errorMessage(oError));
          } finally {
            oDialog.setBusy(false);
          }
        }
      }),
      endButton: new Button({
        text: "Cancel",
        press: function () {
          oDialog.close();
        }
      }),
      afterClose: function () {
        oDialog.destroy();
      }
    });

    if (oView) oView.addDependent(oDialog);
    updateCategoryFields();
    return oDialog;
  }

  return {
    openCreateDialog: function (oBindingContext, aSelectedContexts) {
      var oView = this && typeof this.getView === "function"
        ? this.getView()
        : this && this.base && typeof this.base.getView === "function"
          ? this.base.getView()
          : null;
      var oModel = oView && oView.getModel
        ? oView.getModel()
        : oBindingContext && oBindingContext.getModel
          ? oBindingContext.getModel()
          : aSelectedContexts && aSelectedContexts[0] && aSelectedContexts[0].getModel();

      if (!oModel) {
        MessageBox.error("The Business Partner service is not available.");
        return;
      }

      createDialog(oModel, oView).open();
    }
  };
});
