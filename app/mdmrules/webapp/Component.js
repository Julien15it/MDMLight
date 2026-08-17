sap.ui.define(
    [
        "sap/ui/core/UIComponent",
        "sap/ui/model/json/JSONModel"
    ],
    function (UIComponent, JSONModel) {
        "use strict";

        return UIComponent.extend("mdm.md.mdmrules.manage.Component", {
            metadata: {
                manifest: "json"
            },

            init: function () {
                UIComponent.prototype.init.apply(this, arguments);
                // Starts false so a steward-only hint is never briefly wrong.
                this.setModel(new JSONModel({ isDataSteward: false }), "perm");
                this._loadPermissions();
                this.getRouter().initialize();
            },

            /**
             * Hiding or softening a control is courtesy, not the control: the service checks
             * the Steward scope on every call regardless of what this page shows.
             */
            _loadPermissions: function () {
                var model = this.getModel();
                if (!model || !model.bindContext) return;
                var binding = model.bindContext("/currentUserPermissions(...)");
                binding.execute("$direct").then(function () {
                    var context = binding.getBoundContext();
                    var result = context ? context.getObject() : null;
                    this.getModel("perm").setProperty(
                        "/isDataSteward",
                        Boolean(result && result.isDataSteward)
                    );
                    binding.destroy();
                }.bind(this)).catch(function () {
                    // Left false: an unreadable permission is not a permission.
                    binding.destroy();
                });
            }
        });
    }
);
