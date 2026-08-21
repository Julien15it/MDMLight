sap.ui.define(
    [
        "sap/ui/core/UIComponent",
        "sap/ui/model/json/JSONModel",
        "sap/m/MessageBox"
    ],
    function (UIComponent, JSONModel, MessageBox) {
        "use strict";

        /**
         * The approval task UI: a freestyle UI5 app whose only job is to render one change request
         * for a decision, inside SAP Build Process Automation's My Inbox.
         *
         * It exists separately from mdm.md.businesspartner.manage because that app is Fiori
         * Elements - its root view is sap.fe.core.rootView.NavContainer and its component extends
         * sap.fe.core.AppComponent, which is not a combination SAP documents as a task UI. The
         * screen itself is shared rather than copied: both apps render
         * mdm.md.businesspartner.reuse.view.BusinessPartnerMaintenance, synced out of app/reuse at
         * build time and resolved through `resourceRoots`.
         *
         * The contract below is SAP Help, "Technical Information for Adapting the SAPUI5
         * Application", and is unchanged from the Fiori Elements implementation it replaces.
         */
        return UIComponent.extend("mdm.md.businesspartner.task.Component", {
            metadata: {
                manifest: "json"
            },

            init: function () {
                UIComponent.prototype.init.apply(this, arguments);
                // The shared screen binds all three. `env>/embedded` decides whether it draws its
                // own decision buttons; `perm` gates the steward-only and AI-only controls. Both
                // start closed, so a control is never briefly offered to someone who may not use it.
                // `taskChangeRequest` is filled only while embedded, and is how the approve page
                // learns which request to load without a route to carry it - see _openApprove.
                this.setModel(new JSONModel({ embedded: false, taskChangeRequest: "" }), "env");
                this.setModel(
                    new JSONModel({ isDataSteward: false, aiAssistanceEnabled: false }),
                    "perm"
                );
                this._loadPermissions();
                this.getRouter().initialize();
                // Never allowed to reject: init() is synchronous to its caller, and an unhandled
                // rejection here can abort the shell's app creation and be retried, which surfaces
                // as "adding element with duplicate id ...-content" rather than as the real fault.
                this._initTaskForm().catch(function (error) {
                    console.error("[taskform] Task form initialisation failed:", error);
                });
            },

            /**
             * Hiding a control is courtesy, not the control: the service checks the Steward scope
             * on every call regardless of what this page shows.
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
             * My Inbox instantiates this component and passes the task model plus its own API
             * through componentData.startupParameters.
             *
             * Run standalone - opened directly for local testing - none of that is present and the
             * router handles the hash on its own. Deliberately no check on window.location.hash:
             * embedded, that is the HOST's URL (My Inbox is itself a routed app), so guarding on it
             * would route to the wrong request, or to none.
             */
            _initTaskForm: async function () {
                var startup = this._startupParameters();
                if (!startup.inboxAPI || !startup.taskModel) return;

                this.getModel("env").setProperty("/embedded", true);
                this.setModel(startup.taskModel, "task");

                var contextModel = new JSONModel();
                this.setModel(contextModel, "context");
                try {
                    await contextModel.loadData(this._taskInstanceUrl() + "/context");
                } catch (error) {
                    // Without the context there is no change request to show. Say so rather than
                    // leaving the approver on an empty create screen.
                    MessageBox.error("The task could not be loaded: " + (error.message || error));
                    return;
                }

                var context = contextModel.getData() || {};
                if (context.changerequestid) {
                    this._openApprove(context.changerequestid);
                } else {
                    // The task loaded but carries no request id, which is a mapping problem in
                    // the process rather than anything this app can recover from. Said out loud:
                    // an empty form looks like the app lost the data it was given.
                    MessageBox.error(
                        "This task carries no change request id, so there is nothing to show. "
                        + "In the approval step of the process, map the process context onto the "
                        + "task inputs declared in sap.bpa.task - changerequestid is the required one."
                    );
                }

                this._addInboxActions();
            },

            /**
             * Standalone - opened directly for local testing - this is a route: the URL is ours,
             * and the hash is how the app says which request it is showing.
             *
             * Embedded in My Inbox it cannot be. The hash belongs to the inbox shell, so writing
             * our pattern into it matches no route of ours - the component renders and its approve
             * page never activates, which is exactly "the form is there but the data is not". So
             * the target is displayed directly and the id is handed to the page through the env
             * model and the event bus, bypassing routing entirely.
             *
             * Both are used because the order is not guaranteed: the page may already be listening
             * when the context arrives, or may still be initialising. The model covers the late
             * reader, the event the early one.
             */
            _openApprove: function (changeRequest) {
                if (!this.getModel("env").getProperty("/embedded")) {
                    this.getRouter().navTo(
                        "ChangeRequestApprove",
                        { changeRequest: encodeURIComponent(changeRequest) },
                        true
                    );
                    return;
                }

                this.getModel("env").setProperty("/taskChangeRequest", changeRequest);
                this.getEventBus().publish("taskform", "approve", { changeRequest: changeRequest });

                var router = this.getRouter();
                var targets = router && router.getTargets && router.getTargets();
                if (targets) targets.display("BusinessPartnerMaintenance");
            },

            _startupParameters: function () {
                var componentData = (this.getComponentData && this.getComponentData()) || {};
                return componentData.startupParameters || {};
            },

            /**
             * My Inbox renders the buttons; the outcome ids must match sap.bpa.task.outcomes in
             * manifest.json or the completion is rejected. The screen's own decision buttons hide
             * on env>/embedded, so there is exactly one place to press.
             */
            _addInboxActions: function () {
                var inbox = this._startupParameters().inboxAPI;
                [
                    { id: "reject", label: "Reject", type: "reject" },
                    { id: "approve", label: "Approve", type: "accept" }
                ].forEach(function (outcome) {
                    inbox.addAction(
                        { action: outcome.id, label: outcome.label, type: outcome.type },
                        function () { this._completeTask(outcome.id); },
                        this
                    );
                }, this);
            },

            _workflowRuntimeBaseUrl: function () {
                var service = String(this.getManifestEntry("/sap.cloud/service") || "").replaceAll(".", "");
                var app = String(this.getManifestEntry("/sap.app/id") || "").replaceAll(".", "");
                return "/" + service + "." + app + "/api/public/workflow/rest/v1";
            },

            _taskInstanceId: function () {
                var data = (this.getModel("task") && this.getModel("task").getData()) || {};
                return data.InstanceID || data.instanceId;
            },

            _taskInstanceUrl: function () {
                return this._workflowRuntimeBaseUrl() + "/task-instances/" + this._taskInstanceId();
            },

            /**
             * Record the decision in CAP first, then complete the task. The order matters:
             * completing the task resumes the workflow, which goes on to call completeRequest and
             * post to S/4 - so the change request has to be `approved` by then. SignalWorkflow
             * false stops CAP firing its own trigger, because completing the task here IS that
             * signal; both would resume the process twice.
             */
            _completeTask: async function (outcomeId) {
                try {
                    await this._decideOnServer(outcomeId);
                    await this._patchTaskInstance(outcomeId);
                    this._startupParameters().inboxAPI.updateTask("NA", this._taskInstanceId());
                } catch (error) {
                    MessageBox.error(
                        "The decision could not be completed: " + (error.message || error)
                    );
                }
            },

            _decideOnServer: async function (outcomeId) {
                var context = this.getModel("context");
                var binding = this.getModel("cr").bindContext("/decideRequest(...)");
                binding.setParameter("ChangeRequest", context.getProperty("/changerequestid"));
                binding.setParameter("Decision", outcomeId);
                binding.setParameter("Comment", context.getProperty("/comment") || null);
                binding.setParameter("SignalWorkflow", false);
                try {
                    await binding.execute("$direct");
                } finally {
                    binding.destroy();
                }
            },

            _patchTaskInstance: async function (outcomeId) {
                var token = await fetch(this._workflowRuntimeBaseUrl() + "/xsrf-token", {
                    method: "GET",
                    credentials: "same-origin",
                    headers: { "X-CSRF-Token": "Fetch" }
                }).then(function (response) { return response.headers.get("X-CSRF-Token"); });

                var context = (this.getModel("context") && this.getModel("context").getData()) || {};
                var response = await fetch(this._taskInstanceUrl(), {
                    method: "PATCH",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
                    body: JSON.stringify({
                        // The whole context goes back per the documented contract; only the
                        // declared output (comment) is ours to contribute.
                        status: "COMPLETED",
                        context: context,
                        decision: outcomeId
                    })
                });
                if (!response.ok) {
                    throw new Error("the workflow runtime answered " + response.status);
                }
            }
        });
    }
);
