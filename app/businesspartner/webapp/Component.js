sap.ui.define(
    [
        "sap/fe/core/AppComponent",
        "sap/ui/model/json/JSONModel",
        "mdm/md/businesspartner/manage/ext/CustomActions"
    ],
    function (Component, JSONModel, CustomActions) {
        "use strict";

        return Component.extend("mdm.md.businesspartner.manage.Component", {
            metadata: {
                manifest: "json"
            },

            init: function () {
                Component.prototype.init.apply(this, arguments);
                // Manifest actions without a selection do not receive a binding
                // context. Keep the application OData model available for them.
                CustomActions.setEnvironment(this.getModel(), null);
                // Starts false so a steward-only button is never briefly visible
                // to someone who cannot use it.
                this.setModel(new JSONModel({ isDataSteward: false }), "perm");
                this._loadPermissions();
            },

            /**
             * Hiding a button is courtesy, not the control: the service checks
             * the Steward scope on every call regardless of what the UI shows.
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
            },

            exit: function () {
                CustomActions.clearEnvironment();
                Component.prototype.exit.apply(this, arguments);
            }
        });
    }
);
