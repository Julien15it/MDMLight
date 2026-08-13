sap.ui.define(
    [
        "sap/fe/core/AppComponent",
        "sap/ui/model/json/JSONModel",
        "sap/m/MessageBox",
        "mdm/md/businesspartner/manage/ext/CustomActions"
    ],
    function (Component, JSONModel, MessageBox, CustomActions) {
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
                // Always set, so the view can bind on it whether or not BPA embedded us.
                this.setModel(new JSONModel({ embedded: false }), "env");
                // Never allowed to reject: init() is synchronous to its caller, and an unhandled
                // rejection here can abort the shell's app creation and have it retried - which
                // surfaces as "adding element with duplicate id ...-content" rather than as
                // anything resembling the real fault.
                this._initTaskForm().catch(function (error) {
                    console.error("[taskform] Task form initialisation failed:", error);
                });
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
             * SAP Build Process Automation instantiates this same Component as a UI5 Task
             * Form (sap.bpa.task in manifest.json) and passes the task model plus the My
             * Inbox API through componentData.startupParameters. Contract per SAP Help,
             * "Technical Information for Adapting the SAPUI5 Application".
             *
             * Standalone - the Work Zone tile, or a bpurl deep link - none of that is
             * present, the router handles the URL hash on its own and this does nothing.
             * Deliberately no check on window.location.hash: embedded, that is the HOST's
             * URL (My Inbox is itself a routed app), so guarding on it would send the task
             * form to the partner list instead of the request under review.
             */
            _initTaskForm: async function () {
                var startup = this._startupParameters();
                if (!startup.inboxAPI || !startup.taskModel) {
                    // Not embedded. A bpurl opens index.html with the id as a query
                    // parameter rather than a hash, so honour that and stop.
                    var fromQuery = new URLSearchParams(window.location.search).get("changerequestid");
                    if (fromQuery && !window.location.hash) this._openApprove(fromQuery);
                    return;
                }

                this.getModel("env").setProperty("/embedded", true);
                this.setModel(startup.taskModel, "task");

                var contextModel = new JSONModel();
                this.setModel(contextModel, "context");
                try {
                    await contextModel.loadData(this._taskInstanceUrl() + "/context");
                } catch (error) {
                    // Without the context there is no change request to show. Say so rather
                    // than leaving the approver on an empty create screen.
                    MessageBox.error("The task could not be loaded: " + (error.message || error));
                    return;
                }

                var context = contextModel.getData() || {};
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

            _startupParameters: function () {
                var componentData = (this.getComponentData && this.getComponentData()) || {};
                return componentData.startupParameters || {};
            },

            /**
             * My Inbox renders the buttons; the outcome ids must match sap.bpa.task.outcomes
             * in manifest.json or the completion is rejected. Our own footer Approve/Reject
             * are hidden while embedded (env>/embedded in the view) so there is exactly one
             * place to press.
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
             * completing the task resumes the workflow, which goes on to call
             * completeRequest and post to S/4 - so the change request has to be `approved`
             * by then. SignalWorkflow false stops CAP firing its own BPA trigger, because
             * completing the task here IS that signal; both would resume it twice.
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
