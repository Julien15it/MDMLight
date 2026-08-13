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
                this._navigateToApproveWhenEmbedded();
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
            },

            /**
             * Standalone (bpurl, direct browser use) this app is always
             * reached through a URL hash - #ChangeRequests/{id}/approve for
             * the approver, #BusinessPartners/... for everything else - and
             * the router in manifest.json already handles that on its own,
             * untouched by this method.
             *
             * Imported into SAP Build Process Automation as a UI5 Task Form
             * (sap.bpa.task in manifest.json), BPA instantiates this same
             * Component directly instead of a browser navigating to a bpurl
             * hash, so there is nothing in the address bar to route on. If it
             * handed us the change request id - as componentData (the
             * standard UI5 way a host passes init data into an embedded
             * Component) or as a ?changerequestid= query parameter, in case
             * it opens index.html directly instead - jump straight to the
             * approve screen for it, exactly like a bpurl click would.
             *
             * Guarded to only ever act when there is no hash yet, so it can
             * only trigger on the embedded, hash-less entry point: any real
             * deep link (bpurl included) already has one and is left alone.
             */
            _navigateToApproveWhenEmbedded: function () {
                if (window.location.hash && window.location.hash !== "#") return;

                var firstValue = function (value) {
                    return Array.isArray(value) ? value[0] : value;
                };
                var componentData = (this.getComponentData && this.getComponentData()) || {};
                var startupParameters = componentData.startupParameters || {};
                var changeRequest = firstValue(componentData.changerequestid)
                    || firstValue(startupParameters.changerequestid)
                    || new URLSearchParams(window.location.search).get("changerequestid");

                if (!changeRequest) return;

                this.getRouter().navTo("ChangeRequestApprove", { changeRequest: changeRequest }, true);
            }
        });
    }
);
