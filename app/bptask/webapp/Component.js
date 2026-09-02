sap.ui.define(
    [
        "sap/ui/core/UIComponent",
        "sap/ui/model/json/JSONModel",
        "sap/ui/model/odata/v4/ODataModel",
        "sap/m/MessageBox",
        "sap/m/MessageToast"
    ],
    function (UIComponent, JSONModel, ODataModel, MessageBox, MessageToast) {
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
                // `taskChangeRequest`/`taskReworkChangeRequest` are filled only while embedded,
                // and are how the approve/rework pages learn which request to load without a
                // route to carry it - see _openApprove/_openRework.
                this.setModel(
                    new JSONModel({ embedded: false, taskChangeRequest: "", taskReworkChangeRequest: "" }),
                    "env"
                );
                this.setModel(
                    new JSONModel({ isDataSteward: false, aiAssistanceEnabled: false }),
                    "perm"
                );
                // _loadPermissions and the router both wait for _begin: neither can run before the
                // OData models exist, and those cannot be built until the prefix arrives.
                // Never allowed to reject: init() is synchronous to its caller, and an unhandled
                // rejection here can abort the shell's app creation and be retried, which surfaces
                // as "adding element with duplicate id ...-content" rather than as the real fault.
                this._initTaskForm().catch(function (error) {
                    console.error("[taskform] Task form initialisation failed:", error);
                });
            },

            /** Models, permissions and routing in one place, because all three need the prefix. */
            _begin: function (prefix) {
                this._initServiceModels(prefix);
                this._loadPermissions();
                this.getRouter().initialize();
            },

            /** Built here, not declared in manifest.json: only the task context knows the path. */
            _initServiceModels: function (prefix) {
                this.setModel(new ODataModel(this._serviceSettings("mainService", prefix, true)));
                this.setModel(
                    new ODataModel(this._serviceSettings("changeRequestService", prefix, false)),
                    "cr"
                );
            },

            _serviceSettings: function (dataSource, prefix, earlyRequests) {
                return {
                    serviceUrl: this._serviceUrl(dataSource, prefix),
                    synchronizationMode: "None",
                    operationMode: "Server",
                    autoExpandSelect: true,
                    earlyRequests: earlyRequests
                };
            },

            _serviceUrl: function (dataSource, prefix) {
                var uri = String(this.getManifestEntry("/sap.app/dataSources/" + dataSource + "/uri") || "");
                return this._appPath(prefix) + "/" + uri.replace(/^\//, "");
            },

            /**
             * `{destination service instance guid}.{sap.cloud.service}.{sap.app.id}`, dots stripped -
             * the approuter needs the guid to know which instance resolves the destination.
             */
            _appPath: function (prefix) {
                // No prefix is standalone, where the document root is already the right base.
                if (!prefix) return "";
                var service = String(this.getManifestEntry("/sap.cloud/service") || "").replaceAll(".", "");
                var app = String(this.getManifestEntry("/sap.app/id") || "").replaceAll(".", "");
                return "/" + prefix + "." + service + "." + app;
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
                if (!startup.inboxAPI || !startup.taskModel) {
                    // Standalone: served from the document root, where a relative uri resolves.
                    this._begin("");
                    return;
                }

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
                if (!context.prefix) {
                    // Relative would resolve against the launchpad root and 404 every call, which
                    // reads as a broken service rather than as an unmapped task input.
                    MessageBox.error(
                        "This task carries no service prefix, so its data cannot be loaded. "
                        + "In the approval and rework steps of the process, map the process context "
                        + "onto the task input `prefix` declared in sap.bpa.task."
                    );
                    return;
                }
                // Nothing may bind before this: the OData path is only knowable from the context.
                this._begin(context.prefix);
                // `tasktype` is the only thing telling a rework or data steward task apart from the
                // approver's decision task. Absent - every task built before either existed - still
                // means approve, so no workflow that already works needs its input mapping touched.
                if (context.tasktype === "rework") {
                    if (context.changerequestid) {
                        this._openRework(context.changerequestid);
                    } else {
                        MessageBox.error(
                            "This task carries no change request id, so there is nothing to show. "
                            + "In the rework step of the process, map the process context onto the "
                            + "task inputs declared in sap.bpa.task - changerequestid is the required one."
                        );
                    }
                    this._addReworkInboxActions();
                    return;
                }

                if (context.tasktype === "datasteward") {
                    if (context.changerequestid) {
                        this._openDataStewardReview(context.changerequestid);
                    } else {
                        MessageBox.error(
                            "This task carries no change request id, so there is nothing to show. "
                            + "In the data steward step of the process, map the process context onto "
                            + "the task inputs declared in sap.bpa.task - changerequestid is the "
                            + "required one."
                        );
                    }
                    this._addDataStewardInboxActions();
                    return;
                }

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

            /**
             * Unlike approve/reject, Resubmit and Withdraw need the requester to actually edit and
             * confirm on the shared screen (checks, the duplicate-check confirmation dialog) - that
             * cannot be reduced to inbox.addAction completing the task directly the way approve/
             * reject do. But both ARE declared outcomes (sap.bpa.task.outcomes), so pressing them
             * still belongs in My Inbox's own action bar rather than as a header button on the page
             * (reverted 2026-08-24, back from a brief detour through the object page header actions -
             * that place is for Check/Duplicate Check, which are not outcomes and have nowhere else to
             * go). _addReworkInboxActions below registers them, but each handler only *asks* the
             * shared controller to run its normal onSave/onWithdraw flow over the event bus - the full
             * check/duplicate-confirm/submit flow still runs, and completeOutcome() still only fires
             * after that flow actually succeeds. The header keeps Check/Duplicate Check only; the
             * footer's own Resubmit/Withdraw stay hidden embedded either way, one place to press.
             *
             * Routing embedded is broken for the same reason _openApprove works around it: the
             * hash belongs to the inbox shell, so a route pattern written into it matches nothing
             * of ours and the page never activates. So the same bypass applies here - display the
             * target directly and hand the id over through the env model and the event bus.
             * Standalone still navigates: the guard puts navTo on that side only.
             */
            _openRework: function (changeRequest) {
                if (!this.getModel("env").getProperty("/embedded")) {
                    this.getRouter().navTo(
                        "ChangeRequestRework",
                        { changeRequest: encodeURIComponent(changeRequest) },
                        true
                    );
                    return;
                }

                this.getModel("env").setProperty("/taskReworkChangeRequest", changeRequest);
                this.getEventBus().publish("taskform", "rework", { changeRequest: changeRequest });

                var router = this.getRouter();
                var targets = router && router.getTargets && router.getTargets();
                if (targets) targets.display("BusinessPartnerMaintenance");
            },

            // Same shape as _openRework - see that one's comment for why routing is bypassed
            // embedded and both the model and the event are used.
            _openDataStewardReview: function (changeRequest) {
                if (!this.getModel("env").getProperty("/embedded")) {
                    this.getRouter().navTo(
                        "ChangeRequestDataSteward",
                        { changeRequest: encodeURIComponent(changeRequest) },
                        true
                    );
                    return;
                }

                this.getModel("env").setProperty("/taskDataStewardChangeRequest", changeRequest);
                this.getEventBus().publish("taskform", "datasteward", { changeRequest: changeRequest });

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

            /**
             * Unlike _addInboxActions, pressing these does not complete the task directly - it
             * only publishes a request onto the same "taskform" event bus channel Julien's inbox-
             * loading fix uses, which the shared controller (subscribed in onInit) answers by
             * running the exact onSave/onWithdraw flow the in-page buttons would have run: Check,
             * the duplicate-check confirmation dialog if one is needed, then the actual resubmit/
             * withdraw. completeOutcome() only fires afterwards, from _completeEmbeddedOutcome in
             * the controller, and only once that flow actually succeeded.
             */
            _addReworkInboxActions: function () {
                var inbox = this._startupParameters().inboxAPI;
                var eventBus = this.getEventBus();
                [
                    { id: "withdraw", label: "Withdraw", type: "reject" },
                    { id: "resubmit", label: "Resubmit", type: "accept" }
                ].forEach(function (outcome) {
                    inbox.addAction(
                        { action: outcome.id, label: outcome.label, type: outcome.type },
                        function () { eventBus.publish("taskform", outcome.id); }
                    );
                }, this);
            },

            /**
             * Same shape as _addReworkInboxActions, for the data steward's two outcomes. Reject
             * reuses the approve task type's own "reject" id rather than a new one - the two never
             * coexist on one task instance (tasktype picks exactly one of _addInboxActions/
             * _addReworkInboxActions/_addDataStewardInboxActions), so the same id can be registered
             * with a different handler each time. "enrich" has no such counterpart to reuse. Complete
             * Review needs the shared screen's Check/duplicate-confirm flow (it edits the payload),
             * and Reject is a plain decision - but both still go through the event bus rather than
             * completing the task directly, because both need decideDataStewardReview's result (a
             * fresh ContextJson on complete) before the task can be patched.
             */
            _addDataStewardInboxActions: function () {
                var inbox = this._startupParameters().inboxAPI;
                var eventBus = this.getEventBus();
                [
                    { id: "reject", label: "Reject", type: "reject" },
                    { id: "enrich", label: "Complete Review", type: "accept" }
                ].forEach(function (outcome) {
                    inbox.addAction(
                        { action: outcome.id, label: outcome.label, type: outcome.type },
                        function () { eventBus.publish("taskform", outcome.id); }
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
             * Record the decision in CAP first, then complete the task. The order matters: an
             * approve is what creates the business partner in S/4 (changed 2026-08-25 - it used to
             * happen in completeRequest, after the task resumed the workflow), so the post has
             * already been attempted by the time the task is patched. SignalWorkflow false stops
             * CAP firing its own decision trigger, because completing the task here IS that signal;
             * both would resume the process twice. It does NOT suppress the post result, which the
             * process waits on separately.
             *
             * The task is still completed when the post failed. The human's decision stands and the
             * task is done either way; the request has gone back to `reworkRequired` and the
             * message below is how the approver learns that. Whether a failed post should instead
             * leave the task open is Julien's call, not this screen's.
             *
             * **Every** approve reaches `decideRequest` now (2026-09-02, reversing the 2026-09-01
             * design below) - CAP decides for itself whether this is the last approval a multi-
             * approver chain needs, by counting `ApprovalsReceived` against `RequiredApprovals`
             * server-side, and posts only once they match. The task still completes here either way
             * - BPA's own routing sends the next approver's task from the task completing, not from
             * anything decideRequest returns.
             *
             * What this replaced: reading `currentapprover`/`totalapprovers` off the task context to
             * decide client-side whether to call decideRequest at all. Those values came from BPA
             * mapping them onto the task the same way `prefix` is - which meant the decision of
             * "is this the last approver" depended on the SBPA Lobby being re-pointed at a task-form
             * version that declares the two inputs. It was not: the version was reverted the same
             * day it was raised, so neither input ever reached this task, both were read as absent,
             * and the FIRST approver of every multi-approver chain decided and posted. Counting
             * server-side removes the dependency on that external configuration state entirely - see
             * CLAUDE.md, "Several approvers, sequentially". Reject is unaffected either way: rejecting
             * at any step still rejects the whole request.
             */
            _completeTask: async function (outcomeId) {
                try {
                    var decision = await this._decideOnServer(outcomeId);
                    await this._patchTaskInstance(outcomeId);
                    this._startupParameters().inboxAPI.updateTask("NA", this._taskInstanceId());
                    if (decision && decision.ErrorMessage) {
                        MessageBox.error(
                            "Approved, but the Business Partner could not be created in S/4HANA:\n\n"
                            + decision.ErrorMessage
                            + "\n\nThe request has been sent back to the requester for rework."
                        );
                    } else if (
                        outcomeId === "approve" && decision
                        && decision.RequiredApprovals && decision.ApprovalsReceived < decision.RequiredApprovals
                    ) {
                        MessageToast.show(
                            "Approval recorded (" + decision.ApprovalsReceived + " of "
                            + decision.RequiredApprovals + "). Waiting for the remaining approver(s)."
                        );
                    }
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
                    var value = binding.getBoundContext();
                    return value ? value.getObject() : null;
                } finally {
                    binding.destroy();
                }
            },

            /**
             * `overrides` (resubmit only) is the rebuilt businesspartnerinput from resubmitRequest's
             * own ContextJson - merged in so the context this PATCH sends is the reworked data, not
             * the stale one the task opened with. The task's own completion is what BPA reads it
             * from now (2026-08-24): the signal resubmitRequest also tries is best-effort and no
             * longer what this depends on - see the comment on that action in
             * srv/change-request-service.js.
             */
            _patchTaskInstance: async function (outcomeId, overrides) {
                var token = await fetch(this._workflowRuntimeBaseUrl() + "/xsrf-token", {
                    method: "GET",
                    credentials: "same-origin",
                    headers: { "X-CSRF-Token": "Fetch" }
                }).then(function (response) { return response.headers.get("X-CSRF-Token"); });

                var context = Object.assign(
                    {},
                    (this.getModel("context") && this.getModel("context").getData()) || {},
                    overrides || {}
                );
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
            completeOutcome: async function (outcomeId, freshContext) {
                try {
                    await this._patchTaskInstance(outcomeId, freshContext);
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
