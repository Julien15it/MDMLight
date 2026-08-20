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
                // isDataSteward starts false so a steward-only hint is never briefly wrong.
                // aiAssistanceEnabled starts true because that is the server's own default -
                // starting false would flash "AI is off" on every load before the real value
                // lands, which reads as a setting nobody made.
                this.setModel(
                    new JSONModel({ isDataSteward: false, aiAssistanceEnabled: true }),
                    "perm"
                );
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
                    var permissions = this.getModel("perm");
                    permissions.setProperty(
                        "/isDataSteward",
                        Boolean(result && result.isDataSteward)
                    );
                    // Only an explicit false is "off", matching srv/ai/availability.js: a
                    // service too old to return the flag must not read as AI switched off.
                    permissions.setProperty(
                        "/aiAssistanceEnabled",
                        !result || result.aiAssistanceEnabled !== false
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
