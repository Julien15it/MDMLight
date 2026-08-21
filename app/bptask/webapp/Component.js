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
                this.setModel(new JSONModel({ embedded: false }), "env");
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
                // `tasktype` is the only thing telling a rework task apart from the approver's
                // decision task. Absent - every task built before rework existed - still means
                // approve, so no workflow that already works needs its input mapping touched.
                if (context.tasktype === "rework") {
                    if (context.changerequestid) this._openRework(context.changerequestid);
                    return;
                }

                if (context.changerequestid) this._openApprove(context.changerequestid);

                this._addInboxActions();
            },

            _openApprove: function (changeRequest) {
                this.getRouter().navTo(
                    "ChangeRequestApprove",
                    { changeRequest: encodeURIComponent(changeRequest) },
                    true
                );
            },

            /**
             * Unlike approve/reject, Resubmit and Withdraw need the requester to actually edit and
             * confirm on the shared screen (checks, the duplicate-check confirmation dialog) - that
             * cannot be reduced to a My Inbox outcome button. So no inboxAPI.addAction here: the
             * screen keeps its own Resubmit/Withdraw buttons (they are not hidden by env>/embedded),
             * and completeOutcome() below is called back from the shared controller once the action
             * has already succeeded server-side.
             */
            _openRework: function (changeRequest) {
                this.getRouter().navTo(
                    "ChangeRequestRework",
                    { changeRequest: encodeURIComponent(changeRequest) },
                    true
                );
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
            },

            /**
             * Called by the shared maintenance controller after a resubmit or withdraw succeeds,
             * only while embedded. resubmitRequest/withdrawRequest already did the server-side work,
             * so this is purely telling the workflow runtime the outcome - the same PATCH the
             * approve path sends, just without a decideRequest call in front of it.
             */
            completeOutcome: async function (outcomeId) {
                try {
                    await this._patchTaskInstance(outcomeId);
                    this._startupParameters().inboxAPI.updateTask("NA", this._taskInstanceId());
                } catch (error) {
                    MessageBox.error(
                        "The request was saved, but the task could not be completed: "
                        + (error.message || error)
                    );
                }
            }
        });
    }
);
