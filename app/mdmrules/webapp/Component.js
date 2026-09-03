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
                // isAdmin starts false so the read-only hint is never briefly wrong. This panel
                // moved off isDataSteward 2026-09-03: it is gated by this app's own `Admin` role
                // now, and the data steward role template belongs to the workflow step instead.
                // Both start false, matching the partner app: the switch is disabled until
                // the check answers anyway, and briefly reading "off" is the safer of the two
                // wrong states to show for a moment - claiming AI is on when it may not be is
                // the one that misleads.
                this.setModel(
                    new JSONModel({ isAdmin: false, aiAssistanceEnabled: false }),
                    "perm"
                );
                this._loadPermissions();
                this.getRouter().initialize();
            },

            /**
             * Hiding or softening a control is courtesy, not the control: the service checks
             * the Admin scope on every call regardless of what this page shows.
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
                        "/isAdmin",
                        Boolean(result && result.isAdmin)
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
