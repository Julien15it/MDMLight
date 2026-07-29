sap.ui.define([], function () {
    "use strict";

    return function (opaTest) {
        QUnit.module("First journey");

        opaTest("Start application", function (Given, When, Then) {
            Given.iStartMyApp();
            Then.onTheListReportPage.iSeeThisPage();
        });

        opaTest("Navigate to ObjectPage", function (Given, When, Then) {
            // Load the list report and expect the number of items to be more than 0
            When.onTheListReportPage.onFilterBar().iExecuteSearch();
            Then.onTheListReportPage.onTable().iCheckRows();

            // Navigate to the first list item
            When.onTheListReportPage.onTable().iPressRow(0);
            Then.onTheObjectPage.iSeeThisPage();
        });

        opaTest("Teardown", function (Given, When, Then) {
            Then.iTeardownMyApp();
        });
    };
});
