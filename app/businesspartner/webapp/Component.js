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
                // Both start false so a control is never briefly offered to someone who
                // may not use it: a steward-only button, or an AI assistant on an
                // installation that switched AI off. The cost is that both appear a moment
                // after load where they are allowed, which is the harmless direction.
                this.setModel(
                    new JSONModel({ isDataSteward: false, aiAssistanceEnabled: false }),
                    "perm"
                );
                this._loadPermissions();
                /**
                 * Always false here, and the shared maintenance view still binds it: `embedded`
                 * means "My Inbox is drawing the decision buttons, so the screen must not".
                 * That case moved to mdm.md.businesspartner.task on 2026-08-20 - this app is
                 * Fiori Elements, which is not a documented task-UI host. Kept rather than
                 * removed because the view is shared with the app where it is sometimes true.
                 */
                // `taskChangeRequest` is declared and never filled here: the shared controller
                // reads it, and only the task app has anything to put in it.
                this.setModel(new JSONModel({ embedded: false, taskChangeRequest: "" }), "env");
                this._openDeepLink();
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
                    var permissions = this.getModel("perm");
                    permissions.setProperty(
                        "/isDataSteward",
                        Boolean(result && result.isDataSteward)
                    );
                    // Only an explicit false is "off", matching srv/ai/availability.js.
                    permissions.setProperty(
                        "/aiAssistanceEnabled",
                        !result || result.aiAssistanceEnabled !== false
                    );
                    binding.destroy();
                }.bind(this)).catch(function () {
                    // Left false: an unreadable permission is not a permission.
                    binding.destroy();
                });
            },

            /**
             * A `bpurl` opened outside the launchpad lands on index.html with the change request
             * as a QUERY parameter rather than a hash, so honour that and let the router do the
             * rest. With a hash present the router already has its instruction and this stands
             * aside - re-navigating would override the route the user actually asked for.
             */
            _openDeepLink: function () {
                var changeRequest = new URLSearchParams(window.location.search).get("changerequestid");
                if (!changeRequest || window.location.hash) return;
                this.getRouter().navTo(
                    "ChangeRequestApprove",
                    { changeRequest: encodeURIComponent(changeRequest) },
                    true
                );
            },

            exit: function () {
                CustomActions.clearEnvironment();
                Component.prototype.exit.apply(this, arguments);
            }
        });
    }
);
