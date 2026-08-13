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
  "sap/m/Select",
  "sap/m/CheckBox",
  "sap/m/DatePicker",
  "sap/ui/core/Item",
  "sap/ui/layout/Grid",
  "sap/m/Table",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/SelectDialog",
  "sap/m/StandardListItem",
  "sap/m/Text",
  "sap/m/Toolbar",
  "sap/m/ToolbarSpacer",
  "sap/m/ObjectStatus",
  "sap/m/SearchField",
  "sap/m/VBox",
  "mdm/md/businesspartner/manage/ext/BusinessPartnerMetadata",
  "mdm/md/businesspartner/manage/ext/BusinessPartnerAssistant"
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
  Select,
  CheckBox,
  DatePicker,
  Item,
  Grid,
  Table,
  Column,
  ColumnListItem,
  SelectDialog,
  StandardListItem,
  Text,
  Toolbar,
  ToolbarSpacer,
  ObjectStatus,
  SearchField,
  VBox,
  Metadata,
  BusinessPartnerAssistant
) {
  "use strict";

  var GENERAL_FIELDS = [
    "BusinessPartner",
    "BusinessPartnerCategory",
    "BusinessPartnerGrouping",
    "SearchTerm1",
    "SearchTerm2",
    "CorrespondenceLanguage",
    "BusinessPartnerIsBlocked",
    "IsMarkedForArchiving"
  ];

  var NAME_FIELDS = [
    "FirstName",
    "MiddleName",
    "LastName",
    "OrganizationBPName1",
    "OrganizationBPName2",
    "GroupBusinessPartnerName1",
    "GroupBusinessPartnerName2",
    "BusinessPartnerFullName"
  ];

  // S/4 only persists the name fields that match the chosen
  // BusinessPartnerCategory — e.g. FirstName/LastName are silently dropped
  // for an Organization (category 2), even though the create request sends
  // them. Showing only the applicable fields avoids that surprise instead of
  // letting the user fill in fields S/4 will discard.
  var CATEGORY_NAME_FIELDS = {
    "1": ["FirstName", "MiddleName", "LastName"],
    "2": ["OrganizationBPName1", "OrganizationBPName2"],
    "3": ["GroupBusinessPartnerName1", "GroupBusinessPartnerName2"]
  };

  function nameFieldsForCategory(category) {
    var fields = CATEGORY_NAME_FIELDS[category] || NAME_FIELDS.filter(function (name) {
      return name !== "BusinessPartnerFullName";
    });
    return fields.concat(["BusinessPartnerFullName"]);
  }

  var ROOT_LABELS = {
    BusinessPartnerCategory: "Category",
    BusinessPartnerGrouping: "Grouping",
    CorrespondenceLanguage: "Correspondence Language",
    BusinessPartnerIsBlocked: "Blocked",
    IsMarkedForArchiving: "Marked for Archiving",
    OrganizationBPName1: "Organization Name 1",
    OrganizationBPName2: "Organization Name 2",
    GroupBusinessPartnerName1: "Group Name 1",
    GroupBusinessPartnerName2: "Group Name 2"
  };

  // F4 search helps backed by the S/4 value-help service ZSRVB_MDMLIGHT_VH
  // (see srv/external/ZSRVB_MDMLIGHT_VH, srv/annotations.cds and
  // VALUE_HELP_ENTITIES in business-partner-service.js — keep all three in
  // sync). Applies wherever _createFieldControl renders this field name, so
  // one entry here covers every section that has the field (e.g. Country
  // applies to both Addresses and Identifications).
  //
  // BusinessPartnerCategory is intentionally NOT listed here: it keeps its
  // own fixed 3-value Select below instead of an F4 dialog. It still has a
  // matching @Common.ValueList in annotations.cds for other OData consumers.
  var VALUE_HELP_FIELDS = {
    BusinessPartnerGrouping: {
      collectionPath: "BusinessPartnerGroupings", keyField: "BusinessPartnerGrouping",
      descriptionField: "BusinessPartnerGrouping_Text", title: "Select Grouping"
    },
    LegalForm: {
      collectionPath: "LegalForms", keyField: "LegalForm",
      descriptionField: "LegalForm_Text", title: "Select Legal Form"
    },
    FormOfAddress: {
      collectionPath: "FormsOfAddress", keyField: "FormOfAddress",
      descriptionField: "FormOfAddress_Text", title: "Select Form of Address"
    },
    AcademicTitle: {
      collectionPath: "AcademicTitles", keyField: "AcademicTitle",
      descriptionField: "AcademicTitle_Text", title: "Select Academic Title"
    },
    GenderCodeName: {
      collectionPath: "Genders", keyField: "GenderCodeName",
      descriptionField: "GenderCodeName_Text", title: "Select Gender"
    },
    Industry: {
      collectionPath: "IndustryCodes", keyField: "BusinessPartnerIndustryCode",
      descriptionField: "BusinessPartnerIndustryCode_Text", title: "Select Industry Code"
    },
    CorrespondenceLanguage: {
      collectionPath: "Languages", keyField: "Language",
      descriptionField: "Language_Text", title: "Select Language"
    },
    Language: {
      collectionPath: "Languages", keyField: "Language",
      descriptionField: "Language_Text", title: "Select Language"
    },
    Country: {
      collectionPath: "Countries", keyField: "Country",
      descriptionField: "Country_Text", title: "Select Country"
    },
    Region: {
      collectionPath: "Regions", keyField: "Region",
      descriptionField: "Region_Text", title: "Select Region"
    },
    IndustrySystemType: {
      collectionPath: "IndustrySystems", keyField: "IndustrySystemType",
      descriptionField: "IndustrySystemType_Text", title: "Select Industry System"
    },
    IndustrySector: {
      collectionPath: "IndustrySectors", keyField: "IndustrySector",
      descriptionField: "IndustrySector_Text", title: "Select Industry"
    },
    // Not AddressDependentTaxTypes: that is the address-dependent subset and holds one row (FR1)
    // on this system, so BE0/BE1/BE2 were unreachable. The service returns one row per category.
    BPTaxType: {
      collectionPath: "TaxTypes", keyField: "BPTaxType",
      descriptionField: "TaxTypeName", title: "Select Tax Type"
    },
    // IdentificationTypes has no description column in ZSRVB_MDMLIGHT_VH.
    BPIdentificationType: {
      collectionPath: "IdentificationTypes", keyField: "BPIdentificationType",
      descriptionField: null, title: "Select Identification Type"
    },
    CustomerAccountGroup: {
      collectionPath: "CustomerAccountGroups", keyField: "CustomerAccountGroup",
      descriptionField: "CustomerAccountGroup_Text", title: "Select Account Group"
    },
    CustomerClassification: {
      collectionPath: "CustomerClassifications", keyField: "CustomerClassification",
      descriptionField: "CustomerClassification_Text", title: "Select Customer Classification"
    },
    SupplierAccountGroup: {
      collectionPath: "SupplierAccountGroups", keyField: "SupplierAccountGroup",
      descriptionField: "SupplierAccountGroup_Text", title: "Select Account Group"
    },
    // BusinessPartnerRoleCodes, not BusinessPartnerRoles — that name is
    // already used by the child-entity section itself.
    BusinessPartnerRole: {
      collectionPath: "BusinessPartnerRoleCodes", keyField: "BusinessPartnerRole",
      descriptionField: "BusinessPartnerRole_Text", title: "Select Role"
    }
  };

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

  function unsupportedFieldFromError(error, availableFields) {
    var message = errorMessage(error, "");
    var match = message.match(/(?:segment|property)\s+['"]([^'"]+)['"]/iu)
      || message.match(/property\s+([^\s.]+)\s+(?:not found|does not exist)/iu);
    if (!match) return "";
    return availableFields.includes(match[1]) ? match[1] : "";
  }

  function isBoolean(field) {
    return field.type === "cds.Boolean";
  }

  function isNumber(field) {
    return ["cds.Decimal", "cds.Double", "cds.Integer", "cds.Integer64"].includes(field.type);
  }

  function isDate(field) {
    // Fields like BusinessPartnerRole's ValidFrom/ValidTo are typed
    // cds.DateTime in the metadata even though they only ever carry a
    // calendar date (no meaningful time-of-day) — a plain date picker suits
    // both cds.Date and cds.DateTime fields in this maintenance UI.
    return ["cds.Date", "cds.DateTime"].includes(field.type);
  }

  // DatePicker's valueFormat/displayFormat expect a bare "yyyy-MM-dd" —
  // values coming from the OData model may carry a time/offset suffix
  // (e.g. "2026-08-06T00:00:00.000Z"), which this strips.
  function dateOnly(value) {
    if (!value) return "";
    var text = String(value);
    return text.length >= 10 ? text.slice(0, 10) : text;
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
        this._router.getRoute("ChangeRequestApprove").attachPatternMatched(this._onApproveRoute, this);
        this._router.getRoute("ChangeRequestEdit").attachPatternMatched(this._onRequestEditRoute, this);

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
          // Check, Save Request and Submit Request are all reachable from the empty create form.
          // Preview used to be the step that revealed the last two; without it they start visible.
          showCheckButton: true,
          showSaveButton: true,
          showSaveRequestButton: true,
          showDecisionButtons: false,
          showFooter: true,
          saveButtonText: "Submit Request",
          cancelButtonText: "Cancel",
          messages: [],
          // Set when a duplicate check found something; the next press confirms.
          awaitingConfirmation: false,
          awaitingConfirmationFor: "",
          changeRequest: "",
          requestType: "",
          requestStatus: "",
          previewCategory: "Organization (2)",
          previewGrouping: "",
          previewSearchTerm: "",
          previewLanguage: "",
          sectionWarnings: [],
          deletedRecords: {},
          originalRoot: {},
          root: {
            BusinessPartnerCategory: "2",
            BusinessPartnerGrouping: ""
          },
          sections: {}
        };
      },

      _onCreateRoute: function (event) {
        var state = this._emptyState();
        var routeArguments = event && event.getParameter("arguments") || {};
        var query = routeArguments["?query"] || {};
        ["BusinessPartnerCategory", "BusinessPartnerGrouping", "OrganizationBPName1", "SearchTerm1"]
          .forEach(function (field) {
            if (query[field]) state.root[field] = query[field];
          });
        this.getView().getModel("maintenance").setData(state);
        this._metadata.forEach(function (section) {
          if (section.kind !== "root") state.sections[section.id] = [];
        });
        var suggestedAddress = {
          StreetName: query.AddressStreetName || "",
          HouseNumber: query.AddressHouseNumber || "",
          PostalCode: query.AddressPostalCode || "",
          CityName: query.AddressCityName || "",
          Country: query.AddressCountry || ""
        };
        if (Object.values(suggestedAddress).some(Boolean)) {
          suggestedAddress.__state = "new";
          state.sections.Addresses.push(suggestedAddress);
        }
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
        // Editing an existing partner is a change request, not a direct write.
        state.requestType = editing ? "change" : "";
        state.showEditButton = !editing;
        state.showCheckButton = editing;
        state.showSaveButton = editing;
        state.showSaveRequestButton = editing;
        state.showFooter = true;
        state.saveButtonText = "Submit Request";
        state.cancelButtonText = editing ? "Cancel" : "Back";
        maintenanceModel.setData(state);

        try {
          var model = this.getView().getModel();
          var rootBinding = model.bindContext(
            "/BusinessPartners('" + escapeODataKey(businessPartner) + "')"
          );
          var rootContext = rootBinding.getBoundContext();
          state.root = clone(await rootContext.requestObject());
          state.originalRoot = clone(state.root);
          rootBinding.destroy();

          var sections = await Promise.all(
            this._metadata
              .filter(function (section) { return section.kind !== "root"; })
              .map(async function (section) {
                try {
                  return await this._loadSection(businessPartner, section);
                } catch (error) {
                  return {
                    id: section.id,
                    records: [],
                    warning: section.title + ": " + errorMessage(
                      error,
                      "This section could not be loaded."
                    )
                  };
                }
              }.bind(this))
          );
          sections.forEach(function (result) {
            state.sections[result.id] = result.records;
          });
          var sectionWarnings = sections
            .filter(function (result) { return Boolean(result.warning); })
            .map(function (result) { return result.warning; });
          state.sectionWarnings = sectionWarnings;
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
        var availableFields = section.fields.map(function (field) { return field.name; });
        if (!availableFields.includes(section.relationField)) availableFields.push(section.relationField);
        var omittedFields = [];
        var records;

        while (true) {
          var parameters = omittedFields.length
            ? { $select: availableFields.filter(function (field) {
              return !omittedFields.includes(field);
            }).join(",") }
            : undefined;
          var listBinding = model.bindList(
            "/" + section.entitySet,
            null,
            null,
            [new Filter(section.relationField, FilterOperator.EQ, businessPartner)],
            parameters
          );
          try {
            var contexts = await listBinding.requestContexts(0, 1000);
            records = contexts.map(function (context) {
              var record = clone(context.getObject());
              record.__keys = Object.fromEntries(
                section.fields.filter(function (field) { return field.key; }).map(function (field) {
                  return [field.name, record[field.name]];
                })
              );
              return record;
            });
            break;
          } catch (error) {
            var unsupportedField = unsupportedFieldFromError(error, availableFields);
            if (!unsupportedField || omittedFields.includes(unsupportedField) || omittedFields.length >= 20) {
              throw error;
            }
            omittedFields.push(unsupportedField);
          } finally {
            listBinding.destroy();
          }
        }
        return { id: section.id, records: records };
      },

      _renderAll: function () {
        this._renderRootForm();
        this._metadata
          .filter(function (section) { return section.kind !== "root"; })
          .forEach(this._renderSection.bind(this));
      },

      _renderRootForm: function () {
        var state = this.getView().getModel("maintenance").getData();
        this._renderRootSection("GeneralInformationContent", GENERAL_FIELDS, true, state);
        this._renderRootSection("NamesContent", nameFieldsForCategory(state.root.BusinessPartnerCategory), false, state);
      },

      _renderRootSection: function (containerId, fieldNames, showAdditionalFields, state) {
        var container = this.byId(containerId);
        if (!container) return;
        container.removeAllItems();

        var section = Object.assign({}, this._rootSection, {
          fields: fieldNames.map(function (fieldName) {
            var field = this._rootSection.fields.find(function (candidate) {
              return candidate.name === fieldName;
            });
            return field && Object.assign({}, field, {
              label: ROOT_LABELS[field.name] || field.label
            });
          }, this).filter(Boolean)
        });

        if (showAdditionalFields) {
          container.addItem(new Toolbar({
            design: "Transparent",
            content: [
              new ToolbarSpacer(),
              new Button({
                text: "Additional Fields",
                icon: "sap-icon://detail-view",
                type: "Transparent",
                press: this._openAdditionalFields.bind(this)
              })
            ]
          }).addStyleClass("bpCardToolbar"));
        }

        container.addItem(this._createForm(
          section,
          state.root,
          state.mode === "create",
          state.editing
        ).addStyleClass("bpObjectPageCard"));
      },

      _createForm: function (section, record, isCreate, editing) {
        var content = section.fields.filter(function (field) {
          if (field.name === section.relationField) return false;
          return !(isCreate && field.key && field.creatable === false);
        }).map(function (field) {
          var control = this._createFieldControl(section, field, record, isCreate, editing);
          return new VBox({
            items: [
              new Label({
                text: field.label + (this._isRequired(section, field, isCreate, editing) ? " *" : ""),
                labelFor: control
              }).addStyleClass("bpFieldLabel"),
              control
            ]
          }).addStyleClass("bpField");
        }, this);

        return new Grid({
          defaultSpan: "XL3 L3 M6 S12",
          hSpacing: 2,
          vSpacing: 1,
          content: content
        });
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
        if (isCreate && (section.requiredCreateFields || []).includes(field.name)) return true;
        return !field.nullable;
      },

      _createFieldControl: function (section, field, record, isCreate, editing) {
        var editable = this._isEditable(section, field, isCreate, editing);
        var control;

        if (!editing) {
          return new Text({
            text: field.name === "BusinessPartnerCategory"
              ? categoryText(record[field.name]) || "–"
              : displayValue(record[field.name]) || "–",
            wrapping: true
          }).addStyleClass("bpDisplayValue");
        }

        if (field.name === "BusinessPartnerCategory") {
          control = new Select({
            selectedKey: String(record[field.name] || "2"),
            enabled: editable,
            width: "100%",
            items: [
              new Item({ key: "1", text: "Person (1)" }),
              new Item({ key: "2", text: "Organization (2)" }),
              new Item({ key: "3", text: "Group (3)" })
            ]
          });
          control.attachChange(function (event) {
            var newCategory = event.getSource().getSelectedKey();
            record[field.name] = newCategory;
            this._updatePreview();
            // Re-render the Names card so it only shows the fields S/4 will
            // actually keep for this category (see nameFieldsForCategory).
            var state = this.getView().getModel("maintenance").getData();
            this._renderRootSection("NamesContent", nameFieldsForCategory(newCategory), false, state);
          }.bind(this));
        } else if (isBoolean(field)) {
          control = new CheckBox({ selected: Boolean(record[field.name]), enabled: editable });
          control.attachSelect(function (event) {
            record[field.name] = event.getParameter("selected");
            if (section.kind === "root") this._updatePreview();
          }.bind(this));
        } else if (VALUE_HELP_FIELDS[field.name]) {
          var valueHelpConfig = VALUE_HELP_FIELDS[field.name];
          control = new Input({
            value: displayValue(record[field.name]),
            editable: editable,
            maxLength: field.maxLength || 0,
            showValueHelp: editable,
            width: "100%"
          });
          control.attachLiveChange(function (event) {
            record[field.name] = event.getParameter("value");
            if (section.kind === "root") this._updatePreview();
          }.bind(this));
          control.attachValueHelpRequest(function (event) {
            this._openValueHelp(valueHelpConfig, event.getSource(), record, field, section);
          }.bind(this));
        } else if (isDate(field)) {
          control = new DatePicker({
            value: dateOnly(record[field.name]),
            editable: editable,
            displayFormat: "yyyy-MM-dd",
            valueFormat: "yyyy-MM-dd",
            width: "100%"
          });
          control.attachChange(function (event) {
            if (event.getParameter("valid") === false) return;
            record[field.name] = event.getParameter("value");
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

      /** Generic F4 search-help dialog, config-driven via VALUE_HELP_FIELDS.
       *  One dialog instance is cached per collectionPath (this._valueHelpDialogs)
       *  so fields that share a lookup — e.g. CorrespondenceLanguage (root) and
       *  Language (Addresses) both use "Languages" — reuse the same dialog. */
      _openValueHelp: function (config, input, record, field, section) {
        this._valueHelpDialogs = this._valueHelpDialogs || {};
        var dialog = this._valueHelpDialogs[config.collectionPath];
        if (!dialog) {
          dialog = new SelectDialog({
            title: config.title,
            noDataText: "No matching values found.",
            confirm: function (event) {
              var selectedItem = event.getParameter("selectedItem");
              if (!selectedItem) return;
              var context = selectedItem.getBindingContext();
              var value = context.getProperty(this._valueHelpTarget.config.keyField);
              this._valueHelpTarget.record[this._valueHelpTarget.field.name] = value;
              this._valueHelpTarget.input.setValue(value);
              if (this._valueHelpTarget.section.kind === "root") this._updatePreview();
            }.bind(this),
            search: function (event) {
              var searchValue = event.getParameter("value");
              var searchConfig = this._valueHelpTarget.config;
              var filters = searchValue
                ? [new Filter({
                    filters: searchConfig.descriptionField
                      ? [
                          new Filter(searchConfig.keyField, FilterOperator.Contains, searchValue),
                          new Filter(searchConfig.descriptionField, FilterOperator.Contains, searchValue)
                        ]
                      : [new Filter(searchConfig.keyField, FilterOperator.Contains, searchValue)],
                    and: false
                  })]
                : [];
              event.getSource().getBinding("items").filter(filters);
            }.bind(this)
          });
          dialog.setModel(this.getView().getModel());
          var itemSettings = { title: "{" + config.keyField + "}" };
          if (config.descriptionField) itemSettings.description = "{" + config.descriptionField + "}";
          dialog.bindAggregation("items", {
            path: "/" + config.collectionPath,
            template: new StandardListItem(itemSettings)
          });
          this.getView().addDependent(dialog);
          this._valueHelpDialogs[config.collectionPath] = dialog;
        }
        this._valueHelpTarget = { input: input, record: record, field: field, section: section, config: config };
        dialog.open();
      },

      _openAdditionalFields: function () {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        var record = clone(state.root);
        var primaryFields = new Set(GENERAL_FIELDS.concat(NAME_FIELDS));
        var section = Object.assign({}, this._rootSection, {
          fields: this._rootSection.fields.filter(function (field) {
            return !primaryFields.has(field.name);
          })
        });
        var form = this._createForm(
          section,
          record,
          state.mode === "create",
          state.editing
        ).addStyleClass("bpAdditionalFields");
        var dialog = new Dialog({
          title: "Additional Business Partner Fields",
          contentWidth: "80rem",
          contentHeight: "75%",
          resizable: true,
          draggable: true,
          stretchOnPhone: true,
          content: new VBox({ items: [form] }).addStyleClass("sapUiSmallMargin"),
          beginButton: new Button({
            text: "Apply",
            type: "Emphasized",
            visible: state.editing,
            press: function () {
              Object.assign(state.root, record);
              this._updatePreview(state);
              this._renderRootForm();
              dialog.close();
            }.bind(this)
          }),
          endButton: new Button({
            text: state.editing ? "Cancel" : "Close",
            press: function () { dialog.close(); }
          }),
          afterClose: function () { dialog.destroy(); }
        });
        this.getView().addDependent(dialog);
        dialog.open();
      },

      _updatePreview: function (state) {
        var maintenanceModel = this.getView().getModel("maintenance");
        state = state || maintenanceModel.getData();
        var root = state.root || {};
        if (state.mode === "create") state.businessPartner = root.BusinessPartner || "";
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
        var preferred = (section.summaryFields || []).map(function (fieldName) {
          return section.fields.find(function (field) { return field.name === fieldName; });
        }).filter(Boolean);
        if (preferred.length) return preferred;

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
        var searchField = new SearchField({
          width: "18rem",
          placeholder: "Search"
        });
        var table = new Table({
          inset: false,
          growing: true,
          growingThreshold: 20,
          noDataText: section.creatable === false
            ? "No " + section.title.toLowerCase() + " exists for this Business Partner. Add the corresponding role first."
            : "No records yet. Choose Add to create one.",
          headerToolbar: new Toolbar({
            content: [
              new ToolbarSpacer(),
              searchField,
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
        var showDelete = state.editing && section.deletable !== false;
        if (showDelete) {
          table.addColumn(new Column({ width: "4rem", header: new Text({ text: "Actions" }) }));
        }

        records.forEach(function (record, index) {
          var cells = summaryFields.map(function (field) {
            return new Text({ text: displayValue(record[field.name]), wrapping: false });
          });
          if (showDelete) {
            cells.push(new Button({
              icon: "sap-icon://delete",
              type: "Transparent",
              tooltip: "Delete",
              press: this._confirmDeleteRecord.bind(this, section, index)
            }));
          }
          var item = new ColumnListItem({
            type: "Active",
            cells: cells
          });
          item.attachPress(this._openExistingRecord.bind(this, section, index));
          table.addItem(item);
        }, this);

        searchField.attachLiveChange(function (event) {
          var query = event.getParameter("newValue").trim().toLocaleLowerCase();
          table.getItems().forEach(function (item, index) {
            var searchable = summaryFields
              .map(function (field) { return displayValue(records[index][field.name]); })
              .join(" ")
              .toLocaleLowerCase();
            item.setVisible(!query || searchable.includes(query));
          });
        });

        container.addItem(table);
        container.addItem(new Text({
          text: "Open a row to view or maintain these fields.",
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

      _confirmDeleteRecord: function (section, index) {
        MessageBox.confirm("Delete this " + section.title.toLowerCase() + " record?", {
          emphasizedAction: MessageBox.Action.DELETE,
          actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
          onClose: function (action) {
            if (action !== MessageBox.Action.DELETE) return;
            var state = this.getView().getModel("maintenance").getData();
            var records = state.sections[section.id] || [];
            var record = records[index];
            if (!record) return;
            if (record.__state !== "new") {
              state.deletedRecords[section.id] = state.deletedRecords[section.id] || [];
              state.deletedRecords[section.id].push(record);
            }
            records.splice(index, 1);
            this.getView().getModel("maintenance").refresh(true);
            this._renderSection(section);
          }.bind(this)
        });
      },

      _sectionRecordErrors: function (section, record, isCreate) {
        if (!isCreate) return [];
        var hasValue = function (value) {
          return value !== undefined && value !== null
            && (typeof value !== "string" || value.trim() !== "");
        };
        var label = function (fieldName) {
          var field = section.fields.find(function (candidate) {
            return candidate.name === fieldName;
          });
          return field ? field.label : fieldName;
        };
        var errors = (section.requiredCreateFields || [])
          .filter(function (fieldName) { return !hasValue(record[fieldName]); })
          .map(function (fieldName) { return "Enter " + label(fieldName) + "."; });
        var oneOf = section.oneOfCreateFields || [];
        if (oneOf.length && !oneOf.some(function (fieldName) {
          return hasValue(record[fieldName]);
        })) {
          errors.push("Enter at least one of " + oneOf.map(label).join(" or ") + ".");
        }
        return errors;
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
              var validationErrors = this._sectionRecordErrors(section, record, isCreate);
              if (validationErrors.length) {
                MessageBox.error(validationErrors.join("\n"));
                return;
              }
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

      _writablePayload: function (section, record, isCreate, originalRecord) {
        return Object.fromEntries(
          section.fields
            .filter(function (field) {
              if (record[field.name] === undefined || record[field.name] === null) return false;
              if (isCreate) return field.creatable !== false;
              if (field.updatable === false || field.key) return false;
              return !originalRecord || record[field.name] !== originalRecord[field.name];
            })
            .map(function (field) { return [field.name, record[field.name]]; })
        );
      },

      // modelName selects the service: undefined is BusinessPartnerService,
      // "cr" is ChangeRequestService (the staging actions).
      _executeAction: async function (name, parameters, modelName) {
        var binding = this.getView().getModel(modelName).bindContext("/" + name + "(...)");
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

      onEdit: function () {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        state.editing = true;
        state.showEditButton = false;
        state.showCheckButton = true;
        state.showSaveButton = true;
        // Both flows are change requests now, so both can be parked as drafts.
        state.showSaveRequestButton = true;
        if (state.mode !== "create") state.requestType = "change";
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
        // Nothing reaches S/4 from here, on create or on change. Everything
        // goes to the staging tables and into approval; S/4 is written only
        // once an approver approves.
        if (isCreate || state.mode === "edit") {
          return this._sendChangeRequest("submitRequest");
        }
        state.busy = true;
        maintenanceModel.refresh(true);

        try {
          var rootPayload = this._writablePayload(
            this._rootSection,
            state.root,
            isCreate,
            isCreate ? null : state.originalRoot
          );
          var result = state.root;
          if (isCreate || Object.keys(rootPayload).length > 0) {
            result = await this._executeAction("saveBusinessPartner", {
              BusinessPartner: state.businessPartner || state.root.BusinessPartner || null,
              IsCreate: isCreate,
              DataJson: JSON.stringify(rootPayload)
            });
          }
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
              var actionResult = await this._executeAction("saveBusinessPartnerEntity", {
                Entity: section.id,
                IsCreate: createRecord,
                KeyJson: JSON.stringify(keys),
                DataJson: JSON.stringify(this._writablePayload(section, record, createRecord))
              });
              if (createRecord) {
                // S/4 assigns key fields such as AddressID on create; without
                // merging the response back in, __keys below would capture
                // the still-blank client value, and any later edit of this
                // same record would fail server-side with "Missing key
                // field(s)" because KeyJson would be incomplete.
                var createdJson = actionResult && typeof actionResult === "object"
                  ? actionResult.value
                  : actionResult;
                if (typeof createdJson === "string") {
                  try {
                    Object.assign(record, JSON.parse(createdJson));
                  } catch (parseError) {
                    // saveBusinessPartnerEntity's create branch always returns
                    // JSON on success; ignore defensively otherwise.
                  }
                }
              }
              delete record.__state;
              record.__keys = Object.fromEntries(
                section.fields.filter(function (field) { return field.key; }).map(function (field) {
                  return [field.name, record[field.name]];
                })
              );
            }
            var deletedRecords = state.deletedRecords[section.id] || [];
            for (var deletedRecord of deletedRecords) {
              var deleteKeys = deletedRecord.__keys || Object.fromEntries(
                section.fields.filter(function (field) { return field.key; }).map(function (field) {
                  return [field.name, deletedRecord[field.name]];
                })
              );
              await this._executeAction("deleteBusinessPartnerEntity", {
                Entity: section.id,
                KeyJson: JSON.stringify(deleteKeys)
              });
            }
            state.deletedRecords[section.id] = [];
          }

          if (isCreate) {
            // Only now does S/4 have the full record (root + addresses +
            // ... saved above) — starting the workflow any earlier would
            // send it an empty address list.
            try {
              await this._executeAction("startBusinessPartnerApprovalWorkflow", {
                BusinessPartner: businessPartner
              });
            } catch (workflowError) {
              MessageToast.show(
                "Business Partner " + businessPartner + " was saved, but the approval workflow could not be started."
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

      /**
       * The screen state as the staging service expects it. Section ids are the
       * generated metadata ids, which are also the staging node names, so
       * nothing has to be translated on either side.
       */
      _requestDataJson: function (state) {
        var sections = {};
        var deleted = {};
        this._metadata
          .filter(function (section) { return section.kind !== "root"; })
          .forEach(function (section) {
            sections[section.id] = (state.sections[section.id] || []).slice();
            deleted[section.id] = (state.deletedRecords[section.id] || []).slice();
          });
        return JSON.stringify({ root: state.root, sections: sections, deleted: deleted });
      },

      _findingsFrom: function (result) {
        try {
          var parsed = JSON.parse((result && result.MessagesJson) || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
          return [];
        }
      },

      /**
       * The message area's content. A duplicate names the record it matched so the user can go and
       * look, rather than being told only that something was found.
       */
      /**
       * Continue arms the confirmation the next Submit carries; Cancel leaves the request exactly
       * as it was, still a draft, still editable. Neither writes anything — the request is already
       * staged by the time this runs, and it stays in `draft` either way.
       */
      _confirmDuplicates: function (findings, dataJson) {
        var duplicates = findings.filter(function (finding) { return !!finding.verdict; });
        var listed = duplicates.map(function (finding) {
          return "  \u2022 " + (finding.candidateBP || ("pending request " + finding.candidateRequest))
            + (finding.verdict ? " (" + finding.verdict + ")" : "");
        }).join("\n");
        // Whatever the check reported about itself belongs here too: an outage must not hide
        // behind a list of duplicates.
        var notes = findings.filter(function (finding) { return !finding.verdict; })
          .map(function (finding) { return finding.message; })
          .filter(Boolean);

        MessageBox.warning(
          "This Business Partner might already exist:\n\n" + listed
            + (notes.length ? "\n\n" + notes.join("\n") : "")
            + "\n\nContinue to submit it anyway, or Cancel to go back and change it.",
          {
            title: "Possible duplicate",
            actions: ["Continue", MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.CANCEL,
            contentWidth: "32rem",
            onClose: function (action) {
              var state = this.getView().getModel("maintenance").getData();
              if (action === "Continue") {
                // Armed against this exact payload, whether the warning came from Check or from
                // Submit — it is the same duplicate check either way, so confirming it once is
                // enough. Editing anything afterwards changes the payload and asks again.
                state.awaitingConfirmation = true;
                state.awaitingConfirmationFor = dataJson || "";
                MessageToast.show("Press Submit Request to confirm.");
                return;
              }
              // Cancelled: drop the confirmation so an unchanged payload is checked afresh.
              state.awaitingConfirmation = false;
              state.awaitingConfirmationFor = "";
            }.bind(this)
          }
        );
      },

      // Only ever called for a request that was actually submitted: the unconfirmed case is a
      // dialog now (_confirmDuplicates), not a strip the user can scroll past.
      _submitMessages: function (result) {
        var findings = this._findingsFrom(result);
        var duplicates = findings.filter(function (finding) { return !!finding.verdict; });
        var messages = [{
          type: "Success",
          text: "Change request " + ((result && result.ChangeRequest) || "") + " submitted for approval."
        }];

        // Only the clean outcome is reported here. A duplicate was already put to the user in the
        // dialog they confirmed through, so repeating it above the submitted request adds nothing
        // but noise — the finding is on CheckFindings for the approver either way.
        if (!duplicates.length) {
          messages.push({
            type: "Information",
            text: "Duplicate check ran: no duplicate detected."
          });
        }
        // Anything the check itself reported - an outage, a rule that could not run - is shown
        // rather than swallowed, so "no duplicate detected" never covers for a check that failed.
        findings.filter(function (finding) { return !finding.verdict; })
          .forEach(function (finding) {
            messages.push({ type: "Information", text: finding.message });
          });
        return messages;
      },

      /** action is "saveRequest" (stays a draft) or "submitRequest". */
      _sendChangeRequest: async function (action) {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        state.busy = true;
        maintenanceModel.refresh(true);

        try {
          var parameters = {
            ChangeRequest: state.changeRequest || null,
            RequestType: state.requestType || "create",
            BusinessPartner: state.businessPartner || null,
            Reason: null,
            DataJson: this._requestDataJson(state)
          };
          // Confirmation is tied to the exact payload that was warned about, not to a flag: edit
          // the record after a warning and the check has to be seen again before it counts.
          if (action === "submitRequest") {
            parameters.Confirm = Boolean(state.awaitingConfirmationFor)
              && state.awaitingConfirmationFor === parameters.DataJson;
          }

          var result = await this._executeAction(action, parameters, "cr");

          state.changeRequest = (result && result.ChangeRequest) || state.changeRequest;
          state.requestStatus = (result && result.Status) || "";

          if (action === "saveRequest") {
            // Stay on the request in read mode. Edit resumes this same draft -
            // state.changeRequest is kept, so no second request is created.
            state.editing = false;
            state.showEditButton = true;
            state.showSaveButton = false;
            state.showSaveRequestButton = false;
            state.showCheckButton = false;
            state.modeText = "Draft";
            state.title = "Change request " + state.changeRequest;
            MessageToast.show("Change request " + state.changeRequest + " saved as a draft.");
            return;
          }

          // Nothing was submitted: the check found something and the request is still a draft.
          // A dialog rather than a message strip, because this is a decision the user has to make
          // now — a banner above a long object page is easy to submit straight past.
          if (result && result.NeedsConfirmation) {
            state.messages = [];
            this._confirmDuplicates(this._findingsFrom(result), parameters.DataJson);
            return;
          }

          state.awaitingConfirmation = false;
          state.awaitingConfirmationFor = "";
          state.mode = "display";
          state.modeText = "Submitted";
          state.editing = false;
          state.showSaveButton = false;
          state.showSaveRequestButton = false;
          state.showCheckButton = false;
          state.showEditButton = false;
          state.title = "Request submitted for approval";
          state.messages = this._submitMessages(result);
          // Deliberately no navigation: the request header and its messages stay on screen, the
          // way Save already behaves and the way MDG reports a submit.
        } catch (error) {
          MessageBox.error(errorMessage(error, "The request could not be saved."));
        } finally {
          state.busy = false;
          maintenanceModel.refresh(true);
          this._renderAll();
        }
      },

      /**
       * Validate, derive, then check for duplicates — the order is fixed server-side in
       * srv/checks/pipeline.js and the reasons live there. Stages nothing: this is a question the
       * user can ask as often as they like without leaving a change request behind.
       *
       * Submit runs the same duplicate check regardless, so Check is a convenience, never a gate.
       */
      onCheck: async function () {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        // The client-side required-field check first: it needs no round trip.
        var errors = state.mode === "create" ? this._validationErrors(state.root) : [];
        if (errors.length) {
          MessageBox.error(errors.join("\n"));
          return;
        }

        state.busy = true;
        maintenanceModel.refresh(true);
        try {
          var result = await this._executeAction("checkRequest", {
            ChangeRequest: state.changeRequest || null,
            BusinessPartner: state.businessPartner || null,
            DataJson: this._requestDataJson(state)
          }, "cr");

          var validations = this._parseJsonArray(result && result.ValidationsJson);
          var derivations = this._parseJsonArray(result && result.DerivationsJson);
          var duplicates = this._parseJsonArray(result && result.DuplicatesJson);

          // Derived values are written into the form so the user sees what was filled in, rather
          // than discovering it after approval. A derivation can target an address row, not only
          // the root, which is the whole reason the pipeline works on the payload shape.
          derivations.filter(function (entry) { return entry.field; }).forEach(function (entry) {
            var record = (!entry.target || entry.target === "root")
              ? state.root
              : (state.sections[entry.target] || [])[entry.index || 0];
            if (!record) return;
            record[entry.field] = entry.value;
            // Mark an existing row as changed, or the enriched fields never reach staging.
            if (record !== state.root && !record.__state) record.__state = "changed";
          });
          if (derivations.length) this._updatePreview(state);

          state.messages = this._checkMessages(validations, derivations, duplicates, result);
          this._renderAll();

          if (!result || result.Valid === false) {
            MessageBox.error(
              "The data is not valid yet:\n\n"
              + validations.map(function (entry) { return "  \u2022 " + entry.message; }).join("\n")
            );
            return;
          }
          // A check that could not run must never read as an all-clear.
          if (result.RanDuplicateCheck === false) {
            MessageBox.information("The duplicate check could not run. Nothing was ruled out.");
            return;
          }
          if (duplicates.some(function (finding) { return !!finding.verdict; })) {
            // After the derived values were applied, so Continue arms the payload Submit will
            // actually send and no second dialog appears.
            this._confirmDuplicates(duplicates, this._requestDataJson(state));
            return;
          }
          MessageToast.show("Checked: no duplicate detected.");
        } catch (error) {
          MessageBox.error(errorMessage(error, "The check could not be run."));
        } finally {
          state.busy = false;
          maintenanceModel.refresh(true);
        }
      },

      _parseJsonArray: function (text) {
        try {
          var value = JSON.parse(text || "[]");
          return Array.isArray(value) ? value : [];
        } catch (parseError) {
          return [];
        }
      },

      _checkMessages: function (validations, derivations, duplicates, result) {
        var messages = [];
        validations.forEach(function (entry) {
          messages.push({
            type: entry.severity === "error" ? "Error" : "Warning",
            text: entry.message
          });
        });
        derivations.forEach(function (entry) {
          messages.push({ type: "Information", text: entry.message });
        });
        if (!result || result.Valid === false) return messages;

        // A found duplicate is reported by the dialog and nowhere else — it is a decision, and
        // repeating it as a strip is what made the old message area redundant.
        var found = duplicates.filter(function (finding) { return !!finding.verdict; });
        if (result.RanDuplicateCheck === false) {
          messages.push({ type: "Warning", text: "The duplicate check did not run." });
        } else if (!found.length) {
          messages.push({ type: "Success", text: "Duplicate check ran: no duplicate detected." });
        }
        duplicates.filter(function (finding) { return !finding.verdict && finding.message; })
          .forEach(function (finding) {
            messages.push({ type: "Information", text: finding.message });
          });
        return messages;
      },

      onSaveRequest: function () {
        return this._sendChangeRequest("saveRequest");
      },

      // --- Approver view and draft resume ------------------------------------

      _onApproveRoute: function (event) {
        return this._loadStagedRequest(
          decodeURIComponent(event.getParameter("arguments").changeRequest), false
        );
      },

      /** Reopens a saved draft for further editing, same staged payload. */
      _onRequestEditRoute: function (event) {
        return this._loadStagedRequest(
          decodeURIComponent(event.getParameter("arguments").changeRequest), true
        );
      },

      _loadStagedRequest: async function (changeRequest, editing) {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = this._emptyState();
        state.busy = true;
        state.mode = editing ? "edit" : "approve";
        state.modeText = editing ? "Draft" : "Approval";
        state.editing = editing;
        state.changeRequest = changeRequest;
        state.showEditButton = false;
        state.showCheckButton = false;
        state.showSaveButton = editing;
        state.showSaveRequestButton = editing;
        state.showDecisionButtons = !editing;
        state.showFooter = true;
        state.saveButtonText = "Submit Request";
        state.cancelButtonText = "Back";
        maintenanceModel.setData(state);

        try {
          var payload = await this._executeAction(
            "getRequestPayload", { ChangeRequest: changeRequest }, "cr"
          );
          var data = JSON.parse((payload && payload.DataJson) || "{}");

          state.root = data.root || {};
          state.originalRoot = clone(state.root);
          this._metadata
            .filter(function (section) { return section.kind !== "root"; })
            .forEach(function (section) {
              var value = data.sections && data.sections[section.id];
              state.sections[section.id] = Array.isArray(value)
                ? value
                : (value ? [value] : []);
            });

          state.requestType = (payload && payload.RequestType) || "";
          state.requestStatus = (payload && payload.Status) || "";
          state.businessPartner = (payload && payload.BusinessPartner) || "";
          state.title = (editing ? "Change request " : "Approve request ") + changeRequest;
          state.headerTitle = previewName(state.root) || "Requested Business Partner";
          // Only a request still awaiting a decision can be decided on. Opening
          // an already-decided task must not offer the buttons again.
          state.showDecisionButtons = !editing && state.requestStatus === "inApproval";
          // A submitted request is owned by the approval process from here on.
          if (editing && state.requestStatus !== "draft") {
            state.editing = false;
            state.showSaveButton = false;
            state.showSaveRequestButton = false;
            state.modeText = state.requestStatus;
          }
        } catch (error) {
          MessageBox.error(errorMessage(error, "The change request could not be loaded."));
        } finally {
          state.busy = false;
          this._updatePreview(state);
          maintenanceModel.refresh(true);
          this._renderAll();
        }
      },

      _decide: async function (decision, comment) {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        state.busy = true;
        maintenanceModel.refresh(true);

        try {
          var result = await this._executeAction("decideRequest", {
            ChangeRequest: state.changeRequest,
            Decision: decision,
            Comment: comment || null
          }, "cr");

          state.requestStatus = (result && result.Status) || "";
          state.showDecisionButtons = false;
          if (result && result.BusinessPartner) {
            state.businessPartner = result.BusinessPartner;
            MessageToast.show("Approved. Business Partner " + result.BusinessPartner + " was created in S/4HANA.");
          } else {
            MessageToast.show("Request rejected.");
          }
        } catch (error) {
          MessageBox.error(errorMessage(error, "The decision could not be recorded."));
        } finally {
          state.busy = false;
          maintenanceModel.refresh(true);
          this._renderAll();
        }
      },

      onApprove: function () {
        var that = this;
        MessageBox.confirm(
          "Approve this request and create the Business Partner in S/4HANA?",
          {
            onClose: function (choice) {
              if (choice === MessageBox.Action.OK) that._decide("approve");
            }
          }
        );
      },

      onReject: function () {
        var that = this;
        MessageBox.confirm(
          "Reject this request? The Business Partner will not be created.",
          {
            onClose: function (choice) {
              if (choice === MessageBox.Action.OK) that._decide("reject");
            }
          }
        );
      },

      onBackToList: function () {
        this._router.navTo("BusinessPartnersList", {}, true);
      },

      onOpenAssistant: function () {
        BusinessPartnerAssistant.open(this.getView().getModel(), this.getView());
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
