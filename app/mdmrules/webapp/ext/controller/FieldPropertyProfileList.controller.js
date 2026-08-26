sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, UIComponent, Fragment, JSONModel, MessageBox, MessageToast) {
  "use strict";

  var UPDATE_GROUP = "ruleChanges";

  /**
   * Field property profiles: two conditions per profile, and behind Modify what the profile says
   * about each entity and field. The conditions are ordinary table rows on the same batch-on-save
   * pattern as the other rule pages; the properties are not - the dialog sends the complete state
   * of one profile through `saveFieldProperties`, which replaces it wholesale.
   */
  return Controller.extend("mdm.md.mdmrules.manage.ext.controller.FieldPropertyProfileList", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        busy: false,
        dirty: false,
        // profile ID -> how many settings it carries, so the list can say which profiles are empty.
        counts: {}
      }), "view");
      this._router = UIComponent.getRouterFor(this);
      this._loadOptions();
      this._loadCounts();
    },

    onBackToHub: function () {
      if (this._model() && this._model().hasPendingChanges(UPDATE_GROUP)) {
        MessageBox.confirm("Leave without saving? Unsaved profile changes are discarded.", {
          onClose: function (action) {
            if (action === MessageBox.Action.OK) {
              this._model().resetChanges(UPDATE_GROUP);
              this._router.navTo("MDMRuleHub", {}, true);
            }
          }.bind(this)
        });
        return;
      }
      this._router.navTo("MDMRuleHub", {}, true);
    },

    // The component's model, not only the view's: a routed view is not in the control tree yet
    // during onInit, which is what left the duplicate page's dropdowns empty the first time round.
    _model: function () {
      var component = this.getOwnerComponent();
      return this.getView().getModel("dc") || (component && component.getModel("dc"));
    },

    _table: function () {
      return this.byId("profileTable");
    },

    /** The entity/field tree and both condition lists, generated from the staging model. */
    _loadOptions: async function () {
      try {
        var options = await this._callAction("fieldPropertyOptions", {});
        this.getView().setModel(new JSONModel(options || {}), "opt");
        if (!options || !options.entities || !options.entities.length) {
          MessageBox.error("The entity catalog came back empty, so no property can be set. "
            + "The staging model could not be read.");
        }
      } catch (error) {
        MessageBox.error("The field property options could not be loaded: " + this._errorText(error));
      }
    },

    // One read of every setting, counted per profile. A profile with none is a profile that says
    // nothing, and the list has to show that rather than look configured.
    _loadCounts: async function () {
      var model = this._model();
      if (!model) return;
      try {
        var binding = model.bindList("/FieldPropertySettings");
        var contexts = await binding.requestContexts(0, 5000);
        var counts = {};
        contexts.forEach(function (context) {
          var profile = context.getProperty("profile_ID");
          if (!profile) return;
          counts[profile] = (counts[profile] || 0) + 1;
        });
        this.getView().getModel("view").setProperty("/counts", counts);
      } catch (error) {
        // A count is a nicety; the page still has to load and let someone maintain the profiles.
        this.getView().getModel("view").setProperty("/counts", {});
      }
    },

    formatPropertyCount: function (id, counts) {
      if (!id) return "not saved yet";
      var count = (counts || {})[id] || 0;
      return count ? count + (count === 1 ? " setting" : " settings") : "none set";
    },

    // --- The profile rows --------------------------------------------------

    onAddProfile: function () {
      var binding = this._table().getBinding("items");
      if (!binding) return;
      // Both conditions default to `*`: a new profile is global until someone narrows it, which is
      // the safer default to read - a half-filled condition would be a profile matching nothing.
      binding.create({
        name: "",
        requestType: "*",
        role: "*",
        isActive: true
      });
      this._markDirty();
    },

    onDeleteProfile: function () {
      var item = this._table().getSelectedItem();
      if (!item) {
        MessageToast.show("Select the profile to delete.");
        return;
      }
      var context = item.getBindingContext("dc");
      if (!context) return;
      MessageBox.confirm("Delete this profile and everything it says about the fields?", {
        onClose: function (action) {
          if (action !== MessageBox.Action.OK) return;
          context.delete(UPDATE_GROUP);
          this._markDirty();
        }.bind(this)
      });
    },

    onCellChange: function () {
      this._markDirty();
    },

    _markDirty: function () {
      this.getView().getModel("view").setProperty("/dirty", true);
    },

    _localProblems: function (rows) {
      var problems = [];
      rows.forEach(function (profile, index) {
        var label = "Row " + (index + 1) + ": ";
        if (!profile.requestType) problems.push(label + "choose a request type, or * for all.");
        if (!profile.role) problems.push(label + "choose a role, or * for all.");
      });
      return problems;
    },

    _draftProfiles: function () {
      var binding = this._table().getBinding("items");
      if (!binding) return [];
      return binding.getCurrentContexts().map(function (context) {
        var row = Object.assign({}, context.getObject());
        delete row["@odata.etag"];
        return row;
      });
    },

    onSave: async function () {
      var view = this.getView().getModel("view");
      var problems = this._localProblems(this._draftProfiles());
      if (problems.length) {
        MessageBox.error(problems.join("\n"));
        return;
      }
      view.setProperty("/busy", true);
      try {
        await this._model().submitBatch(UPDATE_GROUP);
        // A rejected row leaves its change pending rather than silently vanishing.
        if (this._model().hasPendingChanges(UPDATE_GROUP)) {
          MessageBox.error("The service rejected at least one profile. Check the messages and correct the row.");
          return;
        }
        view.setProperty("/dirty", false);
        MessageToast.show("Field property profiles saved.");
      } catch (error) {
        MessageBox.error("The profiles could not be saved: " + this._errorText(error));
      } finally {
        view.setProperty("/busy", false);
      }
    },

    onDiscard: function () {
      this._model().resetChanges(UPDATE_GROUP);
      this.getView().getModel("view").setProperty("/dirty", false);
    },

    // --- The properties behind Modify --------------------------------------

    /**
     * The settings hang off a saved profile, so an unsaved row has nothing to hang them on. Offered
     * as a save rather than refused outright: pressing Modify on a row just added is the obvious
     * thing to do, and "save first" with no way to save from here would be a dead end.
     */
    onModify: async function (event) {
      var context = event.getSource().getBindingContext("dc");
      if (!context) return;
      if (this._model().hasPendingChanges(UPDATE_GROUP)) {
        var saved = await this._confirmSaveFirst();
        if (!saved) return;
      }
      var profile = context.getProperty("ID");
      if (!profile) {
        MessageBox.error("This profile has no id yet, so its fields cannot be set. Save the page first.");
        return;
      }
      await this._openPropertyDialog(profile, context.getProperty("name"));
    },

    _confirmSaveFirst: function () {
      return new Promise(function (resolve) {
        MessageBox.confirm(
          "The profile has to be saved before its field properties can be set. Save now?",
          {
            onClose: async function (action) {
              if (action !== MessageBox.Action.OK) {
                resolve(false);
                return;
              }
              await this.onSave();
              // Still pending means the service refused it, and onSave has already said so.
              resolve(!this._model().hasPendingChanges(UPDATE_GROUP));
            }.bind(this)
          }
        );
      }.bind(this));
    },

    _openPropertyDialog: async function (profile, name) {
      var view = this.getView().getModel("view");
      view.setProperty("/busy", true);
      try {
        var stored = await this._callAction("fieldPropertiesOf", { Profile: profile });
        var settings = JSON.parse(stored || "[]");
        this._profile = profile;
        this._tree = this._buildTree(settings);
        if (!this._dialog) {
          this._dialog = await Fragment.load({
            id: this.getView().getId(),
            name: "mdm.md.mdmrules.manage.ext.fragment.FieldPropertyDialog",
            controller: this
          });
          this.getView().addDependent(this._dialog);
          this._dialog.setModel(new JSONModel({ title: "", rows: [] }), "fp");
        }
        this._dialog.getModel("fp").setProperty(
          "/title", "Field Properties" + (name ? " — " + name : "")
        );
        this._query = "";
        this._rebuildRows();
        this._dialog.open();
      } catch (error) {
        MessageBox.error("The field properties could not be loaded: " + this._errorText(error));
      } finally {
        view.setProperty("/busy", false);
      }
    },

    /**
     * The catalog turned into rows the dialog can both render and mutate: an entity node IS the row
     * the table binds, and so is a field node, so ticking a box writes straight through and
     * rebuilding the visible list keeps whatever was ticked.
     */
    _buildTree: function (settings) {
      var byTarget = {};
      var criticalByTarget = {};
      (settings || []).forEach(function (setting) {
        var key = setting.section + "." + (setting.element || "");
        byTarget[key] = setting.property;
        criticalByTarget[key] = !!setting.critical;
      });
      var options = this.getView().getModel("opt");
      var entities = (options && options.getProperty("/entities")) || [];
      return entities.map(function (entity) {
        return {
          kind: "entity",
          section: entity.section,
          element: null,
          text: entity.text,
          expanded: false,
          property: byTarget[entity.section + "."] || null,
          critical: criticalByTarget[entity.section + "."] || false,
          fields: (entity.fields || []).map(function (field) {
            return {
              kind: "field",
              section: entity.section,
              element: field.element,
              text: field.text,
              property: byTarget[entity.section + "." + field.element] || null,
              critical: criticalByTarget[entity.section + "." + field.element] || false
            };
          })
        };
      });
    },

    // An entity is shown when it matches, or when one of its fields does - and a field match opens
    // the entity, because a hit nobody can see reads as no hit at all.
    _rebuildRows: function () {
      var query = (this._query || "").toLowerCase();
      var rows = [];
      (this._tree || []).forEach(function (entity) {
        var entityMatches = !query || entity.text.toLowerCase().indexOf(query) >= 0;
        var fields = query && !entityMatches
          ? entity.fields.filter(function (field) {
            return field.text.toLowerCase().indexOf(query) >= 0;
          })
          : entity.fields;
        if (query && !entityMatches && !fields.length) return;
        rows.push(entity);
        if (entity.expanded || (query && !entityMatches)) {
          rows.push.apply(rows, fields);
        }
      });
      this._dialog.getModel("fp").setProperty("/rows", rows);
    },

    onToggleEntity: function (event) {
      var row = event.getSource().getBindingContext("fp").getObject();
      row.expanded = !row.expanded;
      this._rebuildRows();
    },

    onExpandAll: function () {
      (this._tree || []).forEach(function (entity) { entity.expanded = true; });
      this._rebuildRows();
    },

    onCollapseAll: function () {
      (this._tree || []).forEach(function (entity) { entity.expanded = false; });
      this._rebuildRows();
    },

    onFieldSearch: function (event) {
      this._query = event.getParameter("newValue") || event.getParameter("query") || "";
      this._rebuildRows();
    },

    /**
     * One state per row. The four boxes are a radio group drawn as checkboxes: ticking one clears
     * the other three, and unticking clears the row - which is not the same as `optional`, because
     * a row with nothing ticked says nothing about the field at all.
     */
    onPropertySelect: function (event) {
      var box = event.getSource();
      var row = box.getBindingContext("fp").getObject();
      var picked = box.data("property");
      row.property = event.getParameter("selected") ? picked : null;
      // The checkboxes are expression bindings over the same row, so the whole list is refreshed
      // rather than one property: the other three have to redraw as cleared.
      this._dialog.getModel("fp").refresh(true);
    },

    /**
     * Independent of the four above - ticking or clearing Critical never touches `property`, and
     * vice versa. A field can be mandatory AND critical, or carry no property at all and only be
     * critical.
     */
    onCriticalSelect: function (event) {
      var row = event.getSource().getBindingContext("fp").getObject();
      row.critical = event.getParameter("selected");
    },

    onClearProperties: function () {
      MessageBox.confirm("Clear every property and critical flag in this profile?", {
        onClose: function (action) {
          if (action !== MessageBox.Action.OK) return;
          (this._tree || []).forEach(function (entity) {
            entity.property = null;
            entity.critical = false;
            entity.fields.forEach(function (field) {
              field.property = null;
              field.critical = false;
            });
          });
          this._dialog.getModel("fp").refresh(true);
        }.bind(this)
      });
    },

    /** Everything that is set, entity rows included - untouched rows are simply not sent. */
    _settingsFromTree: function () {
      var settings = [];
      (this._tree || []).forEach(function (entity) {
        if (entity.property || entity.critical) {
          settings.push({
            section: entity.section, element: null,
            property: entity.property || null, critical: !!entity.critical
          });
        }
        entity.fields.forEach(function (field) {
          if (!field.property && !field.critical) return;
          settings.push({
            section: field.section, element: field.element,
            property: field.property || null, critical: !!field.critical
          });
        });
      });
      return settings;
    },

    onApplyProperties: async function () {
      var view = this.getView().getModel("view");
      view.setProperty("/busy", true);
      try {
        var result = await this._callAction("saveFieldProperties", {
          Profile: this._profile,
          SettingsJson: JSON.stringify(this._settingsFromTree())
        });
        this._dialog.close();
        await this._loadCounts();
        var saved = (result && result.Saved) || 0;
        MessageToast.show(saved
          ? "Saved " + saved + (saved === 1 ? " field property." : " field properties.")
          : "The profile now sets no field properties.");
      } catch (error) {
        MessageBox.error("The field properties could not be saved: " + this._errorText(error));
      } finally {
        view.setProperty("/busy", false);
      }
    },

    // The tree is rebuilt from the stored settings on every open, so dropping it IS the discard.
    onCancelProperties: function () {
      this._dialog.close();
      this._tree = null;
    },

    _callAction: async function (name, parameters) {
      var model = this._model();
      if (!model) throw new Error("The rule configuration service is not bound to this page.");
      var binding = model.bindContext("/" + name + "(...)");
      Object.keys(parameters).forEach(function (parameter) {
        binding.setParameter(parameter, parameters[parameter]);
      });
      await binding.execute("$direct");
      var context = binding.getBoundContext();
      var result = context ? context.getObject() : null;
      binding.destroy();
      // A function returning a primitive comes back wrapped in a `value` property.
      return result && result.value !== undefined ? result.value : result;
    },

    _errorText: function (error) {
      return (error && (error.message || error.toString())) || "unknown error";
    }
  });
});
