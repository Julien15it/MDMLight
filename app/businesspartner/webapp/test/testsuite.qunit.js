sap.ui.define(function () {
    "use strict";

    return {
        name: "QUnit test suite for the UI5 Application: mdm.md.businesspartner.manage",
        defaults: {
            page: "ui5://test-resources/mdm/md/businesspartner/manage/Test.qunit.html?testsuite={suite}&test={name}",
            qunit: { version: 2 },
            sinon: { version: 4 },
            ui5: {
                language: "EN",
                theme: "sap_horizon"
            },
            loader: {
                paths: {
                    "mdm/md/businesspartner/manage": "../"
                }
            }
        },
        tests: {
            "unit/unitTests": {
                title: "Unit tests for Manage Business Partner"
            },
            "integration/opaTests": {
                title: "Integration tests for Manage Business Partner"
            }
        }
    };
});
