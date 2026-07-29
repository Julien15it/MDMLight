sap.ui.define(
    ["sap/fe/test/JourneyRunner", "integration/FirstJourney"],
    function (JourneyRunner, FirstJourney) {
        "use strict";

        var runner = new JourneyRunner({
            launchUrl: sap.ui.require.toUrl("mdm/md/businesspartner/manage") + "/test/flpSandbox.html#BusinessPartner-manage"
        });

        runner.run({ pages: {} }, FirstJourney);
    }
);
