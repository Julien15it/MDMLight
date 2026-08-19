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
  "sap/m/DateTimePicker",
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
  "sap/m/HBox",
  "sap/m/Title",
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
  DateTimePicker,
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
  HBox,
  Title,
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

  // S/4 silently drops name fields that do not match the chosen category, so only the applicable
  // ones are shown rather than letting someone fill in fields S/4 will discard.
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

  // F4 helps backed by ZSRVB_MDMLIGHT_VH; keep in sync with annotations.cds and VALUE_HELP_ENTITIES.
  // One entry covers every section with that field. BusinessPartnerCategory is deliberately absent -
  // it keeps its own fixed 3-value Select.

  // --- Automatic check triggers ---------------------------------------------------------------
  // Fields worth a register lookup the moment they are committed. Everything else only marks its
  // scope dirty; the normalisation runs once the requester moves on, not per field.
  var REGISTRY_TRIGGER_FIELDS = { BPTaxNumber: true };
  // Long enough not to fire mid-edit, short enough to feel automatic.
  var TRIGGER_DELAY_MS = 700;
  // "Left the section", realised without ObjectPage internals: either the next commit lands in a
  // different scope, or the requester simply stops typing for this long.
  var TRIGGER_IDLE_MS = 1500;

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
    return ["cds.Date", "cds.DateTime"].includes(field.type);
  }

  // cds.DateTime gets a date+time picker, cds.Date a date-only one.
  function isDateTime(field) {
    return field.type === "cds.DateTime";
  }

  // DatePicker expects a bare "yyyy-MM-dd"; model values may carry a time/offset suffix.
  function dateOnly(value) {
    if (!value) return "";
    var text = String(value);
    return text.length >= 10 ? text.slice(0, 10) : text;
  }

  // DateTimePicker expects "yyyy-MM-dd'T'HH:mm:ss", so fractional seconds and any suffix go.
  function dateTimeOnly(value) {
    if (!value) return "";
    var text = String(value);
    var match = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    return match ? match[1] : text.slice(0, 19);
  }

  // The reverse of dateOnly/dateTimeOnly: the value written back must be a full ISO datetime, or the
  // save sends a bare date for a field S/4 expects as a datetime.
  function toDateTimeValue(value) {
    if (!value) return "";
    if (value.length === 10) return value + "T00:00:00.000Z"; // date-only picker
    if (value.length === 19) return value + ".000Z"; // date+time picker, no millis/zone yet
    return value;
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
        this._router.getRoute("ChangeRequestRework").attachPatternMatched(this._onReworkRoute, this);

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
          // Resubmit and Withdraw, the requester's two ways out of a rejection.
          showReworkButtons: false,
          /** Why the approver sent it back. Empty except in rework mode. */
          rejectionComment: "",
          showCancelButton: true,
          showFooter: true,
          saveButtonText: "Submit Request",
          cancelButtonText: "Cancel",
          messages: [],
          // Findings from the last duplicate check, kept on screen in a collapsed panel so they
          // survive the dialog being dismissed.
          duplicates: [],
          duplicatesHeader: "",
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
        state.showCancelButton = true;
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

          // CVI does not guarantee Customer/Supplier == BusinessPartner, so filtering by the BP number
          // finds nothing where they diverge; A_BusinessPartner carries the resolved number itself.
          // Do NOT retry a to_Customer/to_Supplier fallback from the client: it crashed the server
          // uncaught inside @sap/cds getODataResult, taking every other in-flight request with it.
          // If the plain field is ever blank, that needs a server action calling S/4 directly.
          state.customerNumber = state.root.Customer || null;
          state.supplierNumber = state.root.Supplier || null;

          var relationValues = {
            BusinessPartner: businessPartner,
            Customer: state.customerNumber,
            Supplier: state.supplierNumber
          };

          var sections = await Promise.all(
            this._metadata
              .filter(function (section) { return section.kind !== "root"; })
              .map(async function (section) {
                var relationValue = relationValues[section.relationField];
                // No number means the role was never assigned - an ordinary state, so the section stays
                // empty and its own "no records" text says so, rather than a banner burying real warnings.
                if (relationValue === null || relationValue === undefined) {
                  return { id: section.id, records: [] };
                }
                try {
                  return await this._loadSection(relationValue, section);
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
          state.sectionWarnings = sections
            .filter(function (result) { return Boolean(result.warning); })
            .map(function (result) { return { text: result.warning }; });

          // Rendering is synchronous, so the code lists must be in hand first - otherwise every coded
          // field paints its bare code and gains its description only on a later redraw.
          await this._loadCodeTexts(this._neededCodeTextPaths(state));
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
          var parameters = Object.assign(
            // "$direct", not the default "$auto": batched together, one section's 502 fails every other
            // section in the same batch with "previous request failed".
            { $$groupId: "$direct" },
            omittedFields.length
              ? { $select: availableFields.filter(function (field) {
                return !omittedFields.includes(field);
              }).join(",") }
              : {}
          );
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

      // Descriptions for the coded fields, so a screen reads "Vendor (int.number assgnmnt)" and not
      // "0001". Fetched once per collection for the controller's life - these lists do not change.
      _loadCodeTexts: async function (collectionPaths) {
        this._codeTexts = this._codeTexts || {};
        this._codeTextRequests = this._codeTextRequests || {};
        var model = this.getView().getModel();

        await Promise.all(collectionPaths.map(function (path) {
          if (this._codeTextRequests[path]) return this._codeTextRequests[path];

          var config = null;
          Object.keys(VALUE_HELP_FIELDS).some(function (name) {
            if (VALUE_HELP_FIELDS[name].collectionPath === path) { config = VALUE_HELP_FIELDS[name]; return true; }
            return false;
          });
          if (!config || !config.descriptionField) return null;

          var binding = model.bindList("/" + path, null, null, null, {
            $$groupId: "$direct",
            $select: [config.keyField, config.descriptionField].join(",")
          });
          var request = binding.requestContexts(0, 2000).then(function (contexts) {
            var map = {};
            contexts.forEach(function (context) {
              var row = context.getObject();
              if (row && row[config.keyField]) map[row[config.keyField]] = row[config.descriptionField];
            });
            this._codeTexts[path] = map;
          }.bind(this)).catch(function () {
            // A code list that cannot be read must not take the screen down with it -
            // the field then simply shows its bare code, as it did before.
            this._codeTexts[path] = {};
          }.bind(this)).finally(function () {
            binding.destroy();
          });

          this._codeTextRequests[path] = request;
          return request;
        }, this).filter(Boolean));
      },

      /** Every value-help collection needed to describe the codes currently on screen. */
      _neededCodeTextPaths: function (state) {
        var paths = {};
        var consider = function (record) {
          Object.keys(record || {}).forEach(function (name) {
            var config = VALUE_HELP_FIELDS[name];
            if (!config || !config.descriptionField) return;
            var value = record[name];
            if (value === null || value === undefined || value === "") return;
            paths[config.collectionPath] = true;
          });
        };
        consider(state.root);
        Object.keys(state.sections || {}).forEach(function (id) {
          (state.sections[id] || []).forEach(consider);
        });
        return Object.keys(paths);
      },

      /** "0001 – Vendor (int.number assgnmnt)", or the bare code when no text is known. */
      _describeCode: function (fieldName, value) {
        var shown = displayValue(value);
        var config = VALUE_HELP_FIELDS[fieldName];
        if (!shown || !config || !config.descriptionField) return shown;
        var text = (this._codeTexts && this._codeTexts[config.collectionPath] || {})[value];
        return text ? shown + " – " + text : shown;
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

      _createForm: function (section, record, isCreate, editing, compact) {
        // fieldGroups renders one titled block per group, as the MDG screen splits Control Data /
        // Tax Information / Additional Data. Without them it stays the flat grid everything else uses.
        if (!section.fieldGroups || !section.fieldGroups.length) {
          return this._createFieldGrid(section, section.fields, record, isCreate, editing, compact);
        }

        var byName = {};
        section.fields.forEach(function (field) { byName[field.name] = field; });

        var blocks = section.fieldGroups.map(function (group) {
          var fields = group.fields.map(function (name) { return byName[name]; }).filter(Boolean);
          // These sit directly above child tables in the same dialog, so they use the same table control
          // rather than a form - otherwise the fields appear to float next to bounded tables.
          var body = compact
            ? this._createFieldTable(section, fields, record, isCreate, editing)
            : this._createFieldGrid(section, fields, record, isCreate, editing, compact);
          // A group whose every field was filtered out (all keys hidden on create, say)
          // would otherwise leave a heading with nothing under it.
          if (!body.getItems && !body.getContent().length) {
            body.destroy();
            return null;
          }
          if (body.getItems && !body.getItems().length) {
            body.destroy();
            return null;
          }
          return new VBox({
            items: [
              new Title({ text: group.title, level: "H3" }).addStyleClass("sapUiSmallMarginTop"),
              body
            ]
          });
        }, this).filter(Boolean);

        return new VBox({ items: blocks });
      },

      // One field group in the same sap.m.Table the record sections use, so both carry identical
      // chrome. Chunked four to a table and padded back to four, so the widths line up down the block.
      _createFieldTable: function (section, fields, record, isCreate, editing) {
        var COLUMNS = 4;
        var shown = fields.filter(function (field) {
          // Noise on a collection, where it repeats per row; on a "single" section it is the record's
          // own ERP Customer/Vendor number and belongs on screen. Read-only either way, via _isEditable.
          if (field.name === section.relationField && section.kind !== "single") return false;
          return !(isCreate && field.key && field.creatable === false);
        });

        var container = new VBox();
        for (var start = 0; start < shown.length; start += COLUMNS) {
          var chunk = shown.slice(start, start + COLUMNS);
          var table = new Table({ inset: false, showSeparators: "All" });

          chunk.forEach(function (field) {
            table.addColumn(new Column({
              header: new Text({
                text: field.label + (this._isRequired(section, field, isCreate, editing) ? " *" : "")
              })
            }));
          }, this);
          for (var pad = chunk.length; pad < COLUMNS; pad += 1) {
            table.addColumn(new Column({ header: new Text({ text: "" }) }));
          }

          var cells = chunk.map(function (field) {
            return this._createFieldControl(section, field, record, isCreate, editing);
          }, this);
          while (cells.length < COLUMNS) cells.push(new Text({ text: "" }));

          table.addItem(new ColumnListItem({ cells: cells }));
          container.addItem(table);
        }
        return container;
      },

      // Label-above-field cards in a responsive grid: the layout every section uses outside the
      // grouped Customer/Supplier blocks - see _createFieldTable.
      _createFieldGrid: function (section, fields, record, isCreate, editing) {
        var shown = fields.filter(function (field) {
          // Noise on a collection, where it repeats per row; on a "single" section it is the record's
          // own ERP Customer/Vendor number and belongs on screen. Read-only either way, via _isEditable.
          if (field.name === section.relationField && section.kind !== "single") return false;
          return !(isCreate && field.key && field.creatable === false);
        });

        var content = shown.map(function (field) {
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
              : this._describeCode(field.name, record[field.name]) || "–",
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
          var isDateTimeField = isDateTime(field);
          var PickerControl = isDateTimeField ? DateTimePicker : DatePicker;
          control = new PickerControl({
            value: isDateTimeField ? dateTimeOnly(record[field.name]) : dateOnly(record[field.name]),
            editable: editable,
            displayFormat: isDateTimeField ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd",
            valueFormat: isDateTimeField ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd",
            width: "100%"
          });
          control.attachChange(function (event) {
            if (event.getParameter("valid") === false) return;
            record[field.name] = toDateTimeValue(event.getParameter("value"));
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

        if (control instanceof Input) this._attachCommitTrigger(control, section, field);
        return control;
      },

      /** Generic F4 dialog, driven by VALUE_HELP_FIELDS. Cached per collectionPath, so fields sharing
       *  a lookup reuse one dialog instance. */
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

      // Where a section's table lives: normally its Object Page block, but a child section is hosted in
      // its parent's Details dialog and registers its container here, so re-render paths keep working.
      _sectionContainer: function (section) {
        var hosted = this._hostedSectionContainers && this._hostedSectionContainers[section.id];
        if (hosted && !hosted.bIsDestroyed) return hosted;
        return this.byId(section.id + "Content");
      },

      _renderSection: function (section) {
        var container = this._sectionContainer(section);
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
          noDataText: section.emptyText
            || (section.creatable === false
              ? "No " + section.title.toLowerCase() + " exists for this Business Partner. Add the corresponding role first."
              : "No records yet. Choose Add to create one."),
          headerToolbar: new Toolbar({
            content: [
              new ToolbarSpacer(),
              searchField,
              new ObjectStatus({ text: records.length + " record(s)", state: "Information" }),
              new Button({
                text: "Add",
                icon: "sap-icon://add",
                // A "single" section is 1:1 with the partner, so once it has its record Add must disappear
                // rather than invite a row the remote key cannot hold.
                visible: state.editing && section.creatable !== false
                  && (section.kind !== "single" || records.length === 0),
                press: this._openNewRecord.bind(this, section)
              })
            ]
          })
        });

        summaryFields.forEach(function (field) {
          table.addColumn(new Column({ header: new Text({ text: field.label }) }));
        });
        var showDelete = state.editing && section.deletable !== false;
        // Always present: pressing the row already opened the record but nothing said so, and on a
        // non-deletable section this is the only affordance there is.
        table.addColumn(new Column({
          width: showDelete ? "9rem" : "6rem",
          hAlign: "End",
          header: new Text({ text: "Actions" })
        }));

        records.forEach(function (record, index) {
          var cells = summaryFields.map(function (field) {
            return new Text({ text: this._describeCode(field.name, record[field.name]), wrapping: false });
          }, this);
          var actions = [
            new Button({
              text: "Details",
              icon: "sap-icon://detail-view",
              type: "Transparent",
              tooltip: state.editing ? "Open to view or edit every field" : "Open to view every field",
              press: this._openExistingRecord.bind(this, section, index)
            })
          ];
          if (showDelete) {
            actions.push(new Button({
              icon: "sap-icon://delete",
              type: "Transparent",
              tooltip: "Delete",
              press: this._confirmDeleteRecord.bind(this, section, index)
            }));
          }
          cells.push(new HBox({ items: actions, justifyContent: "End" }));

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
        // Customer/Supplier carry their own number, not the BP's. Falls back to the BP number for every
        // other relationField, and to nothing on a create that has not posted.
        var relationValue = section.relationField === "Customer" ? state.customerNumber
          : section.relationField === "Supplier" ? state.supplierNumber
          : state.businessPartner;
        if (relationValue) record[section.relationField] = relationValue;
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
        // Only a grouped section switches to the table layout, because only there do field blocks sit
        // above child tables and need to match them.
        var grouped = Boolean(section.fieldGroups && section.fieldGroups.length);
        var form = this._createForm(section, record, isCreate, editing, grouped);
        var items = [form];

        // Child sections render inside this dialog rather than as blocks of their own, so one role is one
        // block. They read and write the same state.sections arrays, so staging and posting are untouched.
        var hosted = (section.childSections || []).map(function (childId) {
          var child = this._metadata.find(function (candidate) { return candidate.id === childId; });
          if (!child) return null;
          var container = new VBox();
          items.push(new VBox({
            items: [
              new Title({ text: child.title, level: "H3" }).addStyleClass("sapUiSmallMarginTop"),
              container
            ]
          }));
          return { section: child, container: container };
        }, this).filter(Boolean);

        this._hostedSectionContainers = this._hostedSectionContainers || {};
        hosted.forEach(function (entry) {
          this._hostedSectionContainers[entry.section.id] = entry.container;
        }, this);

        var dialog = new Dialog({
          title: (isCreate ? "Add " : editing ? "Edit " : "View ") + section.title,
          contentWidth: hosted.length ? "90rem" : "70rem",
          contentHeight: "70%",
          resizable: true,
          draggable: true,
          stretchOnPhone: true,
          content: new VBox({ items: items }).addStyleClass("sapUiSmallMargin"),
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
          afterClose: function () {
            // Deregister before destroying, so a later re-render of these sections falls
            // back to their Object Page container instead of a destroyed VBox.
            hosted.forEach(function (entry) {
              delete this._hostedSectionContainers[entry.section.id];
            }, this);
            dialog.destroy();
          }.bind(this)
        });
        this.getView().addDependent(dialog);
        dialog.open();
        hosted.forEach(function (entry) { this._renderSection(entry.section); }, this);
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
        // `editing` only drives the buttons; `mode` is what onSave routes on, so both are set here.
        if (state.mode !== "create") {
          state.mode = "edit";
          state.requestType = "change";
        }
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
        // No direct-write branch left: an unrecognised mode refuses rather than reaching S/4.
        if (isCreate || state.mode === "edit") {
          return this._sendChangeRequest("submitRequest");
        }
        // The draft view with a different primary action: Resubmit hands the request back to the parked
        // process rather than starting a new one.
        if (state.mode === "rework") {
          return this._sendChangeRequest("resubmitRequest");
        }
        MessageBox.error("This Business Partner is not open for editing.");
      },

      // Withdraw deletes the request and its staging rows. Confirmed first and worded plainly: it is
      // the one action here that destroys data, and there is no undo.
      onWithdraw: function () {
        var that = this;
        var state = this.getView().getModel("maintenance").getData();
        MessageBox.warning(
          "Withdraw and delete change request " + state.changeRequest + "?\n\n"
          + "The request and everything staged on it are deleted permanently. This cannot be undone.",
          {
            actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.CANCEL,
            onClose: function (choice) {
              if (choice === MessageBox.Action.DELETE) that._withdraw();
            }
          }
        );
      },

      _withdraw: async function () {
        // The request is about to stop existing; a trigger firing into the deleted record would
        // fail server-side and log a warning nobody can act on.
        this._cancelPendingTrigger();
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        state.busy = true;
        maintenanceModel.refresh(true);

        try {
          await this._executeAction(
            "withdrawRequest", { ChangeRequest: state.changeRequest }, "cr"
          );
          // Nothing is left to show, so unlike every other outcome on this screen there is no
          // staying put: the record this page was rendering no longer exists.
          state.editing = false;
          state.showReworkButtons = false;
          state.showSaveButton = false;
          state.showSaveRequestButton = false;
          state.showCheckButton = false;
          state.showCancelButton = false;
          state.showFooter = false;
          state.modeText = "Withdrawn";
          state.title = "Request withdrawn";
          state.duplicates = [];
          state.duplicatesHeader = "";
          state.messages = [{
            type: "Success",
            text: "Change request " + state.changeRequest + " was withdrawn and deleted."
          }];
        } catch (error) {
          MessageBox.error(errorMessage(error, "The request could not be withdrawn."));
        } finally {
          state.busy = false;
          maintenanceModel.refresh(true);
          this._renderAll();
        }
      },

      // The screen state in the staging service's shape. Section ids are the generated metadata ids,
      // which are also the staging node names, so nothing is translated on either side.
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

      // One dialog, two callers. Check has nothing to decide, so it gets Continue Editing alone;
      // Submit adds `confirmText`, whose button IS the submit. Neither writes anything.
      _confirmDuplicates: function (findings, dataJson, options) {
        var settings = options || {};
        var confirmText = settings.confirmText || "";
        var keepEditing = "Continue Editing";
        var duplicates = findings.filter(function (finding) { return !!finding.verdict; });
        // Named, not just numbered: several distinct partners with similar names read as the same
        // one repeated when the list shows numbers alone.
        var listed = duplicates.map(function (finding) {
          var subject = finding.candidateBP || ("pending request " + finding.candidateRequest);
          return "  \u2022 " + subject
            + (finding.candidateName ? " " + finding.candidateName : "")
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
            + (confirmText
              ? "\n\nSubmit it anyway, or carry on editing it first."
              : "\n\nThe request has not been submitted."),
          {
            title: "Possible duplicate",
            actions: confirmText ? [confirmText, keepEditing] : [keepEditing],
            emphasizedAction: keepEditing,
            contentWidth: "32rem",
            onClose: function (action) {
              var state = this.getView().getModel("maintenance").getData();
              if (confirmText && action === confirmText) {
                // Armed against this exact payload, so the re-submit carries Confirm. Editing
                // anything afterwards changes the payload and asks again.
                state.awaitingConfirmation = true;
                state.awaitingConfirmationFor = dataJson || "";
                if (typeof settings.onConfirm === "function") settings.onConfirm();
              } else {
                // Still editing, so nothing is confirmed: an unchanged payload is asked about again.
                state.awaitingConfirmation = false;
                state.awaitingConfirmationFor = "";
              }
              if (typeof settings.after === "function") settings.after();
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

        // Only the clean outcome: a duplicate was already put to the user in the dialog they confirmed
        // through, and the finding is on CheckFindings for the approver either way.
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

      /** action is "saveRequest" or "submitRequest"; `confirmed` allows the dialog one re-entry. */
      _sendChangeRequest: async function (action, confirmed) {
        // Save, Submit and Resubmit all run their own gates. A trigger landing afterwards would
        // report on a request that has already moved on.
        this._cancelPendingTrigger();
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
          // Tied to the exact payload warned about, not a flag: edit after a warning and the check has to
          // be seen again. A resubmit needs the same second press - rework is the requester changing it.
          if (action === "submitRequest" || action === "resubmitRequest") {
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

          // A validation blocked, so nothing was submitted. Strips, not a dialog: this is a list of
          // things to fix in the form behind it, not a decision to take now.
          if (result && result.Valid === false) {
            state.awaitingConfirmation = false;
            state.awaitingConfirmationFor = "";
            state.messages = this._parseJsonArray(result.ValidationsJson).map(function (entry) {
              return {
                type: entry.severity === "error" ? "Error" : "Warning",
                text: entry.message
              };
            });
            this._renderAll();
            return;
          }

          // The check found something and the request is still a draft. A dialog, not a strip: this is a
          // decision to take now, and a banner above a long object page is easy to submit straight past.
          if (result && result.NeedsConfirmation) {
            state.messages = [];
            // Submit matched too, so its findings replace what the panel was showing rather than
            // leaving an older list up next to a newer dialog.
            this._setDuplicatePanel(state, this._findingsFrom(result), { RanDuplicateCheck: true });
            this._confirmDuplicates(this._findingsFrom(result), parameters.DataJson, {
              // `confirmed` stops a second dialog re-submitting, so no loop if the server asks twice.
              confirmText: action === "resubmitRequest" ? "Resubmit" : "Submit Request",
              onConfirm: confirmed ? null : function () {
                this._sendChangeRequest(action, true);
              }.bind(this)
            });
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
          // The request is back with the approver, so Withdraw goes with the rest. It is only
          // withdrawable while it is the requester's to act on.
          state.showReworkButtons = false;
          // "Cancel" cancels nothing once the request is in approval, and with every other button
          // gone the toolbar would be an empty bar. Leaving the page is the shell's back arrow.
          state.showCancelButton = false;
          state.showFooter = false;
          state.title = action === "resubmitRequest"
            ? "Request resubmitted for approval"
            : "Request submitted for approval";
          state.messages = this._submitMessages(result);
          // The approver has these on CheckFindings; leaving the panel up invites editing a
          // request nobody can edit any more.
          state.duplicates = [];
          state.duplicatesHeader = "";
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

      // --- Automatic triggers -------------------------------------------------------------------
      // The same action the Check button calls, but quiet: no MessageBox, no busy overlay, and
      // nothing written to the form. Derivations stay proposals - see the 2026-08-13 decision.

      _attachCommitTrigger: function (control, section, field) {
        control.attachChange(function () {
          this._onFieldCommitted(section, field);
        }.bind(this));
      },

      _onFieldCommitted: function (section, field) {
        // A tax number is worth the register on its own, and only the register: Propose false so
        // no AI Core call rides along with it.
        if (REGISTRY_TRIGGER_FIELDS[field.name]) {
          this._flushPendingScope();
          this._scheduleTrigger({ propose: false, scope: null });
          return;
        }
        var scope = section.kind === "root" ? "root" : section.id;
        // Committing in a different scope means the previous one is finished.
        if (this._pendingScope && this._pendingScope !== scope) this._flushPendingScope();
        this._pendingScope = scope;
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(this._flushPendingScope.bind(this), TRIGGER_IDLE_MS);
      },

      _flushPendingScope: function () {
        clearTimeout(this._idleTimer);
        var scope = this._pendingScope;
        this._pendingScope = null;
        if (scope) this._scheduleTrigger({ propose: true, scope: scope });
      },

      _scheduleTrigger: function (options) {
        clearTimeout(this._triggerTimer);
        this._triggerTimer = setTimeout(function () {
          this._runTriggeredCheck(options);
        }.bind(this), TRIGGER_DELAY_MS);
      },

      // Called by every button that runs a check. The guard was one-directional: a scheduled trigger
      // still fired once the button released `busy`, so the derivation ran twice. `_buttonRun` covers
      // the other half - a trigger already mid-flight drops its result when a press overtakes it.
      _cancelPendingTrigger: function () {
        clearTimeout(this._idleTimer);
        clearTimeout(this._triggerTimer);
        this._pendingScope = null;
        this._buttonRun = (this._buttonRun || 0) + 1;
      },

      _runTriggeredCheck: async function (options) {
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        // Never compete with a button press or another trigger, and never queue - the next commit
        // schedules the next one anyway.
        if (state.busy || this._triggerInFlight) return;

        var dataJson = this._requestDataJson(state);
        // Re-committing a field nobody changed must cost nothing.
        var key = (options.scope || "-") + "|" + options.propose + "|" + dataJson;
        if (key === this._lastTriggerKey) return;

        // Which button press this trigger started under. If it changes while the call is out, a
        // button overtook us and its answer is the one the requester is looking at.
        var startedUnder = this._buttonRun || 0;
        this._triggerInFlight = true;
        try {
          var result = await this._executeAction("checkRequest", {
            ChangeRequest: state.changeRequest || null,
            BusinessPartner: state.businessPartner || null,
            DataJson: dataJson,
            Propose: options.propose,
            Scope: options.scope || null
          }, "cr");
          this._lastTriggerKey = key;

          // A button ran while this was out. Its result is on screen and it asked the same question
          // of the same record, so reporting this one too is the duplicate dialog we are fixing.
          if (startedUnder !== (this._buttonRun || 0)) return;

          var validations = this._parseJsonArray(result && result.ValidationsJson);
          var derivations = this._parseJsonArray(result && result.DerivationsJson);
          var normalisations = this._parseJsonArray(result && result.NormalisationsJson);

          // Strips, never a MessageBox: the requester is still filling the form.
          state.messages = this._checkMessages(validations, derivations);
          this._renderAll();

          // Silence when there is nothing to offer. A dialog on every commit would be unusable.
          var proposals = this._proposalRows(derivations, normalisations);
          if (proposals.length) this._offerProposals(proposals);
        } catch (error) {
          // A check nobody asked for must never interrupt; the buttons still report properly.
          console.warn("[triggers] automatic check failed:", errorMessage(error, ""));
        } finally {
          this._triggerInFlight = false;
        }
      },

      onCheck: async function () {
        // Before the early return below, not after: a press that fails the client-side check has
        // still superseded whatever the trigger was about to ask.
        this._cancelPendingTrigger();
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
          var normalisations = this._parseJsonArray(result && result.NormalisationsJson);

          state.messages = this._checkMessages(validations, derivations);
          this._renderAll();

          if (!result || result.Valid === false) {
            MessageBox.error(
              "The data is not valid yet:\n\n"
              + validations.map(function (entry) { return "  \u2022 " + entry.message; }).join("\n")
            );
            return;
          }

          var proposals = this._proposalRows(derivations, normalisations);
          if (proposals.length) {
            this._offerProposals(proposals);
            return;
          }
          MessageToast.show("Checked: nothing to propose.");
        } catch (error) {
          MessageBox.error(errorMessage(error, "The check could not be run."));
        } finally {
          state.busy = false;
          maintenanceModel.refresh(true);
        }
      },

      // "Does this partner already exist?" - validate, derive in memory, match. The derived values
      // are never shown; they exist so a rule on a field nobody typed yet still fires.
      onDuplicateCheck: async function () {
        this._cancelPendingTrigger();
        var maintenanceModel = this.getView().getModel("maintenance");
        var state = maintenanceModel.getData();
        var errors = state.mode === "create" ? this._validationErrors(state.root) : [];
        if (errors.length) {
          MessageBox.error(errors.join("\n"));
          return;
        }

        state.busy = true;
        maintenanceModel.refresh(true);
        try {
          var result = await this._executeAction("duplicateCheckRequest", {
            ChangeRequest: state.changeRequest || null,
            BusinessPartner: state.businessPartner || null,
            DataJson: this._requestDataJson(state)
          }, "cr");

          var validations = this._parseJsonArray(result && result.ValidationsJson);
          var duplicates = this._parseJsonArray(result && result.DuplicatesJson);

          this._setDuplicatePanel(state, duplicates, result);
          state.messages = this._duplicateCheckMessages(validations, duplicates, result);
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
            // No confirmText: this reports, it does not ask. Deciding belongs to Submit, which
            // offers the submit itself, so acknowledging here confirms nothing.
            this._confirmDuplicates(duplicates, this._requestDataJson(state), {});
            return;
          }
          MessageToast.show("Checked: no duplicate detected.");
        } catch (error) {
          MessageBox.error(errorMessage(error, "The duplicate check could not be run."));
        } finally {
          state.busy = false;
          maintenanceModel.refresh(true);
        }
      },

      // The findings outlive the dialog: dismissing it used to destroy the only copy of the list.
      _setDuplicatePanel: function (state, findings, result) {
        // A check that did not run leaves them standing - clearing reads as "now clean".
        if (result && result.RanDuplicateCheck === false) return;
        var found = (findings || []).filter(function (finding) { return !!finding.verdict; });
        state.duplicates = found.map(function (finding) {
          var subject = finding.candidateBP || ("pending request " + finding.candidateRequest);
          return {
            title: subject + (finding.candidateName ? " \u2014 " + finding.candidateName : ""),
            description: finding.message || "",
            verdict: finding.verdict || ""
          };
        });
        state.duplicatesHeader = found.length
          ? found.length + (found.length === 1 ? " possible duplicate" : " possible duplicates")
          : "";
      },

      _parseJsonArray: function (text) {
        try {
          var value = JSON.parse(text || "[]");
          return Array.isArray(value) ? value : [];
        } catch (parseError) {
          return [];
        }
      },

      // `info` is its own severity: a rule the engine could not evaluate is the table's problem, not
      // the requester's, so it must not share a strip with theirs.
      _validationMessages: function (validations) {
        var TYPE = { error: "Error", warning: "Warning", info: "Information" };
        return validations.map(function (entry) {
          return {
            type: TYPE[entry.severity] || "Warning",
            text: entry.message
          };
        });
      },

      _checkMessages: function (validations, derivations) {
        var messages = this._validationMessages(validations);
        // A derivation carrying no field is a statement, not a value — there is nothing to tick,
        // so it is said here instead of in the proposals dialog.
        derivations.filter(function (entry) { return !entry.field && entry.message; })
          .forEach(function (entry) {
            messages.push({ type: "Information", text: entry.message });
          });
        return messages;
      },

      _duplicateCheckMessages: function (validations, duplicates, result) {
        var messages = this._validationMessages(validations);
        if (!result || result.Valid === false) return messages;

        // The findings themselves live in the panel, which stays on screen — this only says
        // whether the check ran and got a clean answer.
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

      // One list for both stages: to the requester they are one question. The Change column keeps
      // them apart - a derivation fills an empty field, a normalisation rewrites a filled one.
      _proposalRows: function (derivations, normalisations) {
        var rows = [];
        var seen = {};
        var keyOf = function (entry) {
          return (entry.target || "root") + "|" + (entry.index || 0) + "|" + entry.field;
        };
        derivations.filter(function (entry) { return entry.field; }).forEach(function (entry) {
          seen[keyOf(entry)] = rows.length;
          rows.push({
            change: "Filled in",
            target: entry.target || "root",
            index: entry.index || 0,
            field: entry.field,
            current: "",
            proposed: entry.value,
            reason: entry.message || "found in the official register",
            accepted: true
          });
        });
        normalisations.forEach(function (entry) {
          var existing = seen[keyOf(entry)];
          // A field derived and then reformatted is one row: applying both writes it twice.
          if (existing !== undefined) {
            rows[existing].proposed = entry.proposed;
            rows[existing].reason += " (" + entry.reason + ")";
            return;
          }
          rows.push({
            change: "Reformatted",
            target: entry.target || "root",
            index: entry.index || 0,
            field: entry.field,
            current: entry.current,
            proposed: entry.proposed,
            reason: entry.reason,
            accepted: true
          });
        });
        return rows;
      },

      // Proposals, never changes: declining is not ticking it, and the next Check proposes it again.
      // Proposed is an Input because the model can be right that "st" needs resolving and wrong how.
      _offerProposals: function (proposals) {
        var model = new JSONModel({ proposals: proposals });

        var table = new Table({
          mode: "MultiSelect",
          columns: [
            new Column({ header: new Text({ text: "Field" }) }),
            new Column({ header: new Text({ text: "Change" }) }),
            new Column({ header: new Text({ text: "Current" }) }),
            new Column({ header: new Text({ text: "Proposed" }), width: "14rem" }),
            new Column({ header: new Text({ text: "Why" }) })
          ]
        });
        table.bindItems({
          path: "/proposals",
          template: new ColumnListItem({
            selected: "{accepted}",
            cells: [
              new Text({ text: "{field}" }),
              new Text({ text: "{change}" }),
              new Text({ text: "{current}" }),
              new Input({ value: "{proposed}" }),
              new Text({ text: "{reason}" })
            ]
          })
        });
        table.setModel(model);

        var dialog = new Dialog({
          title: "Proposed changes",
          contentWidth: "56rem",
          resizable: true,
          content: [
            new Text({
              text: "These values were filled in from the official register, or differ from how master data is usually written. Edit anything you want to change, untick what you do not want, and nothing else is touched.",
              wrapping: true
            }).addStyleClass("sapUiSmallMargin"),
            table
          ],
          beginButton: new Button({
            text: "Apply Selected",
            type: "Emphasized",
            press: function () {
              // Read back from the model, not from the row: the value may have been edited, and
              // `accepted` is two-way bound to the checkbox.
              this._applyProposals(model.getProperty("/proposals").filter(function (proposal) {
                return proposal.accepted;
              }));
              dialog.close();
            }.bind(this)
          }),
          endButton: new Button({ text: "Not Now", press: function () { dialog.close(); } }),
          afterClose: function () { dialog.destroy(); }
        });
        this.getView().addDependent(dialog);
        dialog.open();
      },

      _applyProposals: function (accepted) {
        var applied = 0;
        var state = this.getView().getModel("maintenance").getData();
        accepted.forEach(function (proposal) {
          var record = (!proposal.target || proposal.target === "root")
            ? state.root
            : (state.sections[proposal.target] || [])[proposal.index || 0];
          if (!record) return;
          // An emptied field is a decline, not an instruction to blank what is there.
          var value = String(proposal.proposed === undefined ? "" : proposal.proposed).trim();
          if (!value || value === proposal.current) return;
          record[proposal.field] = value;
          // Or the accepted value never reaches staging.
          if (record !== state.root && !record.__state) record.__state = "changed";
          applied += 1;
        });
        if (!applied) return;
        // The payload changed, so a duplicate confirmation taken against the old one no longer
        // applies - the next submit has to check again.
        state.awaitingConfirmation = false;
        state.awaitingConfirmationFor = "";
        // The findings deliberately stay: only a match may clear them, or the screen would look
        // clean on the strength of a check nobody ran.
        this._updatePreview(state);
        this._renderAll();
        MessageToast.show(applied + " field(s) updated.");
      },

      onSaveRequest: function () {
        return this._sendChangeRequest("saveRequest");
      },

      // --- Approver view and draft resume ------------------------------------

      _onApproveRoute: function (event) {
        return this._loadStagedRequest(
          decodeURIComponent(event.getParameter("arguments").changeRequest), "approve"
        );
      },

      /** Reopens a saved draft for further editing, same staged payload. */
      _onRequestEditRoute: function (event) {
        return this._loadStagedRequest(
          decodeURIComponent(event.getParameter("arguments").changeRequest), "edit"
        );
      },

      // The requester's screen for a request sent back. Reached only by the `reworkurl` deep link -
      // the list is steward-gated. Every field is editable, and the footer offers Resubmit/Withdraw.
      _onReworkRoute: function (event) {
        return this._loadStagedRequest(
          decodeURIComponent(event.getParameter("arguments").changeRequest), "rework"
        );
      },

      // `mode` is "approve", "edit" or "rework". It was a boolean until rework arrived, which needs a
      // draft's editability and a footer of its own.
      _loadStagedRequest: async function (changeRequest, mode) {
        var maintenanceModel = this.getView().getModel("maintenance");
        var reworking = mode === "rework";
        // Rework edits the payload, so it is an editing mode - it just does not save drafts.
        var editing = mode === "edit" || reworking;
        var state = this._emptyState();
        state.busy = true;
        state.mode = reworking ? "rework" : (editing ? "edit" : "approve");
        state.modeText = reworking ? "Rework" : (editing ? "Draft" : "Approval");
        state.editing = editing;
        state.changeRequest = changeRequest;
        state.showEditButton = false;
        // Rework IS the draft view with one different primary action, so the buttons are the editing
        // ones in both modes and only the label and onSave's route change.
        state.showCheckButton = reworking;
        state.showSaveButton = editing;
        // No Save Request in rework: it drops the screen out of editing and offers Edit, which re-enters
        // "edit" mode - and onSave would then start a second workflow for an already-parked instance.
        state.showSaveRequestButton = editing && !reworking;
        state.showDecisionButtons = !editing;
        // Set properly once the status is known: a rework link outlives the state it was sent for.
        state.showReworkButtons = false;
        state.showFooter = true;
        state.saveButtonText = reworking ? "Resubmit" : "Submit Request";
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
          state.rejectionComment = (payload && payload.RejectionComment) || "";
          state.title = (reworking ? "Rework request " : (editing ? "Change request " : "Approve request "))
            + changeRequest;
          state.headerTitle = previewName(state.root) || "Requested Business Partner";
          // Only a request still awaiting a decision can be decided on. Opening
          // an already-decided task must not offer the buttons again.
          state.showDecisionButtons = !editing && state.requestStatus === "inApproval";

          if (reworking) {
            // The link outlives the state it was sent for, so an already-resubmitted or withdrawn request
            // must not offer the buttons again - the rule the approve view follows for a decided task.
            var awaitingRework = state.requestStatus === "reworkRequired";
            state.showReworkButtons = awaitingRework;
            state.editing = awaitingRework;
            state.showCheckButton = awaitingRework;
            state.showSaveButton = awaitingRework;
            if (!awaitingRework) {
              state.modeText = state.requestStatus;
              state.messages = [{
                type: "Information",
                text: "This request is " + state.requestStatus + ", so there is nothing to rework."
                  + " It has either been resubmitted already or withdrawn."
              }];
            } else if (state.rejectionComment) {
              // Why it came back, at the top of the screen. "Rejected" with no reason is not
              // something a requester can act on, and it is the first thing they will look for.
              state.messages = [{
                type: "Warning",
                text: "Sent back by the approver: " + state.rejectionComment
              }];
            }
          } else if (editing && state.requestStatus !== "draft") {
            // A submitted request is owned by the approval process from here on.
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
