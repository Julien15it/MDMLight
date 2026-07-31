sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/core/UIComponent",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/Input",
  "sap/m/CheckBox",
  "sap/ui/layout/form/SimpleForm",
  "sap/m/Table",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/Text",
  "sap/m/Toolbar",
  "sap/m/ToolbarSpacer",
  "sap/m/Title",
  "sap/m/ObjectStatus",
  "sap/m/VBox",
  "mdm/md/businesspartner/manage/ext/BusinessPartnerMetadata"
], function (
  Controller,
  JSONModel,
  Filter,
  FilterOperator,
  UIComponent,
  MessageBox,
  MessageToast,
  Dialog,
  Button,
  Label,
  Input,
  CheckBox,
  SimpleForm,
  Table,
  Column,
  ColumnListItem,
  Text,
  Toolbar,
  ToolbarSpacer,
  Title,
  ObjectStatus,
  VBox,
  Metadata
) {
  "use strict";

  function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function escapeODataKey(value) {
    return String(value).replaceAll("'", "''");
  }

  function errorMessage(error, fallback) {
    var responseText = error && error.cause && error.cause.responseText;
    if (responseText) {
      try {
        var response = JSON.parse(responseText);
        var remoteMessage = response.error && response.error.message;
        if (typeof remoteMessage === "object") remoteMessage = remoteMessage.value;
        if (remoteMessage) return remoteMessage;
      } catch (_ignored) {
        // Fall through to the regular UI5 error message.
      }
    }
    return error && error.cause && error.cause.message
      || error && error.message
      || fallback;
  }

  function isBoolean(field) {
    return field.type === "cds.Boolean";
  }

  function isNumber(field) {
    return ["cds.Decimal", "cds.Double", "cds.Integer", "cds.Integer64"].includes(field.type);
  }

  function displayValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value);
  }

  function categoryText(category) {
    return ({ "1": "Person (1)", "2": "Organization (2)", "3": "Group (3)" })[category]
      || category
      || "";
  }

  function previewName(root) {
    if (root.BusinessPartnerCategory === "1") {
      return [root.FirstName, root.MiddleName, root.LastName].filter(Boolean).join(" ");
    }
    if (root.BusinessPartnerCategory === "3") {
      return [root.GroupBusinessPartnerName1, root.GroupBusinessPartnerName2].filter(Boolean).join(" ");
    }
    return [root.OrganizationBPName1, root.OrganizationBPName2].filter(Boolean).join(" ")
      || root.BusinessPartnerFullName
      || root.BusinessPartnerName
      || "";
  }

  return Controller.extend(
    "mdm.md.businesspartner.manage.ext.controller.BusinessPartnerMaintenance",
    {
      onInit: function () {
        this._metadata = Metadata.sections;
        this._rootSection = this._metadata.find(function (section) {
          return section.kind === "root";
        });
        this._router = UIComponent.getRouterFor(this);
        this._router.getRoute("BusinessPartnerCreate").attachPatternMatched(this._onCreateRoute, this);
        this._router.getRoute("BusinessPartnerDisplay").attachPatternMatched(this._onDisplayRoute, this);
        this._router.getRoute("BusinessPartnerMaintain").attachPatternMatched(this._onEditRoute, this);

        this.getView().setModel(new JSONModel(this._emptyState()), "maintenance");
      },

      _emptyState: function () {
        return {
          busy: false,
          mode: "create",
          modeText: "Create",
          title: "Create Business Partner",
          headerTitle: "New Business Partner",
          businessPartner: "",
          editing: true,
          showEditButton: false,
          showPreviewButton: true,
          showSaveButton: false,
          showFooter: true,
          saveButtonText: "Create in S/4HANA",
          cancelButtonText: "Cancel",
          previewCategory: "Organization (2)",
          previewGrouping: "",
          previewSearchTerm: "",
          previewLanguage: "",
          root: {
            BusinessPartnerCategory: "2",
            BusinessPartnerGrouping: ""
          },
          sections: {}
        };
      },

      _onCreateRoute: function () {
        var state = this._emptyState();
        this.getView().getModel("maintenance").setData(state);
        this._metadata.forEach(function (section) {
          if (section.kind !== "root") state.sections[section.id] = [];
        });
        this.getView().getModel("maintenance").refresh(true);
        this._updatePreview(state);
        this._renderAll();
      },

      _onDisplayRoute: function (event) {
        return this._loadBusinessPartner(event, false);
      },

      _onEditRoute: function (event) {
        return this._loadBusinessPartner(event, true);
      },

      _loadBusinessPartner: async function (event, editing) {
        var businessPartner = decodeURIComponent(event.getParameter("arguments").businessPartner);
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = this._emptyState();
        state.busy = true;
        state.mode = editing ? "edit" : "display";
        state.modeText = editing ? "Edit" : "Display";
        state.title = (editing ? "Edit" : "Business Partner") + " " + businessPartner;
        state.headerTitle = "Business Partner";
        state.businessPartner = businessPartner;
        state.editing = editing;
        state.showEditButton = !editing;
        state.showPreviewButton = false;
        state.showSaveButton = editing;
        state.showFooter = true;
        state.saveButtonText = "Save Changes";
        state.cancelButtonText = editing ? "Cancel" : "Back";
        maintenanceModel.setData(state);

        try {
          var model = this.getView().getModel();
          var rootBinding = model.bindContext(
            "/BusinessPartners('" + escapeODataKey(businessPartner) + "')"
          );
          var rootContext = rootBinding.getBoundContext();
          state.root = clone(await rootContext.requestObject());
          rootBinding.destroy();

          var sections = await Promise.all(
            this._metadata
              .filter(function (section) { return section.kind !== "root"; })
              .map(this._loadSection.bind(this, businessPartner))
          );
          sections.forEach(function (result) {
            state.sections[result.id] = result.records;
          });
        } catch (error) {
          MessageBox.error(errorMessage(error, "The Business Partner could not be loaded."));
        } finally {
          state.busy = false;
          this._updatePreview(state);
          maintenanceModel.refresh(true);
          this._renderAll();
        }
      },

      _loadSection: async function (businessPartner, section) {
        var model = this.getView().getModel();
        var listBinding = model.bindList(
          "/" + section.entitySet,
          null,
          null,
          [new Filter(section.relationField, FilterOperator.EQ, businessPartner)]
        );
        var contexts = await listBinding.requestContexts(0, 1000);
        var records = contexts.map(function (context) {
          var record = clone(context.getObject());
          record.__keys = Object.fromEntries(
            section.fields.filter(function (field) { return field.key; }).map(function (field) {
              return [field.name, record[field.name]];
            })
          );
          return record;
        });
        listBinding.destroy();
        return { id: section.id, records: records };
      },

      _renderAll: function () {
        this._renderRootForm();
        this._metadata
          .filter(function (section) { return section.kind !== "root"; })
          .forEach(this._renderSection.bind(this));
      },

      _renderRootForm: function () {
        var container = this.byId("BusinessPartnersContent");
        if (!container) return;
        container.removeAllItems();

        var state = this.getView().getModel("maintenance").getData();
        var form = this._createForm(
          this._rootSection,
          state.root,
          state.mode === "create",
          state.editing
        );
        container.addItem(form);
      },

      _createForm: function (section, record, isCreate, editing) {
        var content = [];
        section.fields.forEach(function (field) {
          var control = this._createFieldControl(section, field, record, isCreate, editing);
          content.push(new Label({
            text: field.label + (this._isRequired(section, field, isCreate, editing) ? " *" : ""),
            labelFor: control
          }));
          content.push(control);
        }, this);

        return new SimpleForm({
          editable: true,
          layout: "ResponsiveGridLayout",
          columnsXL: 3,
          columnsL: 3,
          columnsM: 2,
          labelSpanXL: 4,
          labelSpanL: 4,
          labelSpanM: 4,
          emptySpanXL: 0,
          emptySpanL: 0,
          emptySpanM: 0,
          content: content
        }).addStyleClass("sapUiSmallMarginBottom");
      },

      _isEditable: function (section, field, isCreate, editing) {
        if (!editing) return false;
        if (section.kind !== "root" && field.name === section.relationField) return false;
        if (isCreate) return field.creatable !== false;
        return field.updatable !== false && !field.key;
      },

      _isRequired: function (section, field, isCreate, editing) {
        if (!this._isEditable(section, field, isCreate, editing)) return false;
        if (section.kind === "root" && isCreate) {
          return ["BusinessPartnerCategory", "BusinessPartnerGrouping"].includes(field.name);
        }
        return !field.nullable;
      },

      _createFieldControl: function (section, field, record, isCreate, editing) {
        var editable = this._isEditable(section, field, isCreate, editing);
        var control;

        if (isBoolean(field)) {
          control = new CheckBox({ selected: Boolean(record[field.name]), enabled: editable });
          control.attachSelect(function (event) {
            record[field.name] = event.getParameter("selected");
            if (section.kind === "root") this._updatePreview();
          }.bind(this));
        } else {
          control = new Input({
            value: displayValue(record[field.name]),
            editable: editable,
            maxLength: field.maxLength || 0,
            type: isNumber(field) ? "Number" : "Text",
            width: "100%"
          });
          control.attachLiveChange(function (event) {
            var value = event.getParameter("value");
            record[field.name] = isNumber(field) && value !== "" ? Number(value) : value;
            if (section.kind === "root") this._updatePreview();
          }.bind(this));
        }

        return control;
      },

      _updatePreview: function (state) {
        var maintenanceModel = this.getView().getModel("maintenance");
        state = state || maintenanceModel.getData();
        var root = state.root || {};
        state.headerTitle = previewName(root)
          || root.BusinessPartnerFullName
          || (state.businessPartner ? "Business Partner " + state.businessPartner : "New Business Partner");
        state.previewCategory = categoryText(root.BusinessPartnerCategory);
        state.previewGrouping = root.BusinessPartnerGrouping || "";
        state.previewSearchTerm = root.SearchTerm1 || root.SearchTerm2 || "";
        state.previewLanguage = root.CorrespondenceLanguage || root.Language || "";
        maintenanceModel.refresh(true);
      },

      _summaryFields: function (section) {
        var relationField = section.relationField;
        var keys = section.fields.filter(function (field) {
          return field.key && field.name !== relationField;
        });
        var details = section.fields.filter(function (field) {
          return !field.key && field.updatable !== false;
        });
        return keys.concat(details).slice(0, 6);
      },

      _renderSection: function (section) {
        var container = this.byId(section.id + "Content");
        if (!container) return;
        container.removeAllItems();

        var state = this.getView().getModel("maintenance").getData();
        var records = state.sections[section.id] || [];
        var summaryFields = this._summaryFields(section);
        var table = new Table({
          inset: false,
          growing: true,
          growingThreshold: 20,
          noDataText: section.creatable === false
            ? "No " + section.title.toLowerCase() + " exists for this Business Partner. Add the corresponding role first."
            : "No records yet. Choose Add to create one.",
          headerToolbar: new Toolbar({
            content: [
              new Title({ text: section.title, level: "H3" }),
              new ToolbarSpacer(),
              new ObjectStatus({ text: records.length + " record(s)", state: "Information" }),
              new Button({
                text: "Add",
                icon: "sap-icon://add",
                visible: state.editing && section.creatable !== false,
                press: this._openNewRecord.bind(this, section)
              })
            ]
          })
        });

        summaryFields.forEach(function (field) {
          table.addColumn(new Column({ header: new Text({ text: field.label }) }));
        });

        records.forEach(function (record, index) {
          var item = new ColumnListItem({
            type: "Active",
            cells: summaryFields.map(function (field) {
              return new Text({ text: displayValue(record[field.name]), wrapping: false });
            })
          });
          item.attachPress(this._openExistingRecord.bind(this, section, index));
          table.addItem(item);
        }, this);

        container.addItem(table);
        container.addItem(new Text({
          text: "Open a row to maintain every available field for this entity.",
          wrapping: true
        }).addStyleClass("sapUiTinyMarginTop"));
      },

      _openNewRecord: function (section) {
        var state = this.getView().getModel("maintenance").getData();
        var record = {};
        if (state.businessPartner) record[section.relationField] = state.businessPartner;
        this._openRecordDialog(section, record, true, -1);
      },

      _openExistingRecord: function (section, index) {
        var records = this.getView().getModel("maintenance").getData().sections[section.id] || [];
        this._openRecordDialog(section, clone(records[index]), false, index);
      },

      _openRecordDialog: function (section, record, isCreate, index) {
        var state = this.getView().getModel("maintenance").getData();
        var editing = Boolean(state.editing);
        var form = this._createForm(section, record, isCreate, editing);
        var dialog = new Dialog({
          title: (isCreate ? "Add " : editing ? "Edit " : "View ") + section.title,
          contentWidth: "70rem",
          contentHeight: "70%",
          resizable: true,
          draggable: true,
          stretchOnPhone: true,
          content: new VBox({ items: [form] }).addStyleClass("sapUiSmallMargin"),
          beginButton: new Button({
            text: "Apply",
            type: "Emphasized",
            visible: editing,
            press: function () {
              var state = this.getView().getModel("maintenance").getData();
              var records = state.sections[section.id] || [];
              if (isCreate) {
                record.__state = "new";
                records.push(record);
              } else {
                record.__state = record.__state === "new" ? "new" : "modified";
                records[index] = record;
              }
              state.sections[section.id] = records;
              this.getView().getModel("maintenance").refresh(true);
              this._renderSection(section);
              dialog.close();
            }.bind(this)
          }),
          endButton: new Button({
            text: editing ? "Cancel" : "Close",
            press: function () { dialog.close(); }
          }),
          afterClose: function () { dialog.destroy(); }
        });
        this.getView().addDependent(dialog);
        dialog.open();
      },

      _writablePayload: function (section, record, isCreate) {
        return Object.fromEntries(
          section.fields
            .filter(function (field) {
              if (record[field.name] === undefined || record[field.name] === null) return false;
              if (isCreate) return field.creatable !== false;
              return field.updatable !== false && !field.key;
            })
            .map(function (field) { return [field.name, record[field.name]]; })
        );
      },

      _executeAction: async function (name, parameters) {
        var binding = this.getView().getModel().bindContext("/" + name + "(...)");
        Object.keys(parameters).forEach(function (parameter) {
          binding.setParameter(parameter, parameters[parameter]);
        });
        await binding.execute("$direct");
        var resultContext = binding.getBoundContext();
        var result = resultContext ? resultContext.getObject() : null;
        binding.destroy();
        return result;
      },

      _validationErrors: function (root) {
        var errors = [];
        if (!root.BusinessPartnerCategory) errors.push("Enter a Business Partner category.");
        if (!["1", "2", "3"].includes(root.BusinessPartnerCategory)) {
          errors.push("Category must be 1 (Person), 2 (Organization), or 3 (Group).");
        }
        if (!root.BusinessPartnerGrouping) errors.push("Enter a Business Partner grouping.");
        if (root.BusinessPartnerCategory === "1" && !root.LastName) {
          errors.push("Enter the last name for the person.");
        }
        if (root.BusinessPartnerCategory === "2" && !root.OrganizationBPName1) {
          errors.push("Enter the organization name.");
        }
        if (root.BusinessPartnerCategory === "3" && !root.GroupBusinessPartnerName1) {
          errors.push("Enter the group name.");
        }
        return errors;
      },

      onPreview: function () {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        var errors = this._validationErrors(state.root);
        if (errors.length) {
          MessageBox.error(errors.join("\n"));
          return;
        }

        state.editing = false;
        state.modeText = "Preview";
        state.title = "Preview New Business Partner";
        state.showEditButton = true;
        state.showPreviewButton = false;
        state.showSaveButton = true;
        state.cancelButtonText = "Cancel";
        this._updatePreview(state);
        this._renderAll();
      },

      onEdit: function () {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        state.editing = true;
        state.showEditButton = false;
        state.showPreviewButton = state.mode === "create";
        state.showSaveButton = state.mode !== "create";
        state.modeText = state.mode === "create" ? "Create" : "Edit";
        state.title = state.mode === "create"
          ? "Create Business Partner"
          : "Edit Business Partner " + state.businessPartner;
        state.cancelButtonText = "Cancel";
        maintenanceModel.refresh(true);
        this._renderAll();
      },

      onSave: async function () {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        var isCreate = state.mode === "create";
        var validationErrors = isCreate ? this._validationErrors(state.root) : [];
        if (validationErrors.length) {
          MessageBox.error(validationErrors.join("\n"));
          return;
        }
        state.busy = true;
        maintenanceModel.refresh(true);

        try {
          var result = await this._executeAction("saveBusinessPartner", {
            BusinessPartner: state.businessPartner || state.root.BusinessPartner || null,
            IsCreate: isCreate,
            DataJson: JSON.stringify(this._writablePayload(this._rootSection, state.root, isCreate))
          });
          var businessPartner = result && result.BusinessPartner
            ? result.BusinessPartner
            : state.businessPartner || state.root.BusinessPartner;
          if (!businessPartner) throw new Error("S/4HANA did not return a Business Partner number.");

          for (var section of this._metadata.filter(function (item) { return item.kind !== "root"; })) {
            var records = state.sections[section.id] || [];
            for (var record of records.filter(function (item) { return Boolean(item.__state); })) {
              var createRecord = record.__state === "new";
              record[section.relationField] = businessPartner;
              var keys = createRecord ? {} : (record.__keys || Object.fromEntries(
                section.fields.filter(function (field) { return field.key; }).map(function (field) {
                  return [field.name, record[field.name]];
                })
              ));
              await this._executeAction("saveBusinessPartnerEntity", {
                Entity: section.id,
                IsCreate: createRecord,
                KeyJson: JSON.stringify(keys),
                DataJson: JSON.stringify(this._writablePayload(section, record, createRecord))
              });
              delete record.__state;
              record.__keys = Object.fromEntries(
                section.fields.filter(function (field) { return field.key; }).map(function (field) {
                  return [field.name, record[field.name]];
                })
              );
            }
          }

          state.mode = "display";
          state.modeText = "Display";
          state.businessPartner = businessPartner;
          state.root.BusinessPartner = businessPartner;
          state.title = "Business Partner " + businessPartner;
          state.headerTitle = (result && result.BusinessPartnerFullName)
            || state.root.BusinessPartnerFullName
            || "Business Partner";
          MessageToast.show("Business Partner " + businessPartner + " was saved in S/4HANA.");
          this._router.navTo("BusinessPartnerDisplay", { businessPartner: businessPartner }, true);
        } catch (error) {
          MessageBox.error(errorMessage(error, "The Business Partner could not be saved in S/4HANA."));
        } finally {
          state.busy = false;
          maintenanceModel.refresh(true);
        }
      },

      onCancel: function () {
        var state = this.getView().getModel("maintenance").getData();
        if (state.mode === "edit" && state.businessPartner) {
          this._router.navTo("BusinessPartnerDisplay", { businessPartner: state.businessPartner }, true);
          return;
        }
        this._router.navTo("BusinessPartnersList", {}, true);
      }
    }
  );
});
