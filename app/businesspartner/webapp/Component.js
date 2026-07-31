sap.ui.define(
    [
        "sap/fe/core/AppComponent",
        "mdm/md/businesspartner/manage/ext/CustomActions"
    ],
    function (Component, CustomActions) {
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
            },

            exit: function () {
                CustomActions.clearEnvironment();
                Component.prototype.exit.apply(this, arguments);
            }
        });
    }
);
