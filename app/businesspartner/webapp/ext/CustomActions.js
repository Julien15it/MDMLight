sap.ui.define([
  "sap/ui/core/routing/HashChanger",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "mdm/md/businesspartner/reuse/BusinessPartnerAssistant"
], function (HashChanger, MessageBox, MessageToast, BusinessPartnerAssistant) {
  "use strict";

  var environment = { model: null, view: null, extensionAPI: null };

  function contextsFrom() {
    var result = [];
    var seen = [];

    function collect(value) {
      if (!value || seen.includes(value)) return;
      if (typeof value === "object" || typeof value === "function") seen.push(value);
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (typeof value.getProperty === "function") {
        result.push(value);
        return;
      }
      ["bindingContext", "sourceBindingContext", "context", "contexts", "selectedContexts"]
        .forEach(function (property) { collect(value[property]); });
      if (typeof value.getParameter === "function") {
        ["bindingContext", "contexts", "selectedContexts"]
          .forEach(function (name) { collect(value.getParameter(name)); });
      }
      if (typeof value.getSource === "function") {
        var source = value.getSource();
        if (source && typeof source.getBindingContext === "function") collect(source.getBindingContext());
      }
    }

    Array.prototype.forEach.call(arguments, collect);
    return result.filter(function (context, index) { return result.indexOf(context) === index; });
  }

  function contextFrom(value) {
    return contextsFrom(value)[0] || null;
  }

  function businessPartnerFromHash() {
    var hash = HashChanger.getInstance().getHash() || "";
    var match = decodeURIComponent(hash).match(/BusinessPartners\((?:'([^']+)'|([^)]*))\)/u);
    return match ? (match[1] || match[2]) : "";
  }

  function navigate(hash) {
    HashChanger.getInstance().setHash(hash);
  }

  function navigateToEdit(businessPartner) {
    if (!businessPartner) {
      MessageBox.error("A Business Partner number could not be determined.");
      return;
    }
    navigate("BusinessPartners/" + encodeURIComponent(businessPartner) + "/maintain");
  }

  function navigateToDisplay(businessPartner) {
    if (!businessPartner) {
      MessageBox.error("A Business Partner number could not be determined.");
      return;
    }
    navigate("BusinessPartners/" + encodeURIComponent(businessPartner) + "/display");
  }

  /**
   * A change request row opens **read-only**, for anyone: seeing what has already been asked for is
   * the point of showing the request in this list at all, and it is the whole list that is open.
   *
   * The DISPLAY route, never the edit one. Editing a draft stays on the steward-gated Change
   * Requests list, and an `inApproval` request is decided from the approver's inbox against a real
   * task - so this shows more without letting anyone change more.
   */
  function explainRequest(context) {
    var request = context.getProperty("ChangeRequest");
    if (!request) {
      MessageBox.information(
        describeRequest(context)
        + " It is already in progress, so there is no need to request it again."
      );
      return;
    }
    navigate("ChangeRequests/" + encodeURIComponent(request) + "/display");
  }

  /** One sentence naming the request, so a blocked action says which one is in the way. */
  function describeRequest(context) {
    var status = context.getProperty("RecordStatus") || "A change request";
    var by = context.getProperty("RequestedBy");
    return status + (by ? ", requested by " + by + "." : ".");
  }

  /** One unbound action call, the same idiom the maintenance screen's _executeAction uses. */
  function executeAction(model, name, parameters) {
    var binding = model.bindContext("/" + name + "(...)");
    Object.keys(parameters).forEach(function (parameter) {
      binding.setParameter(parameter, parameters[parameter]);
    });
    return binding.execute("$direct").then(function () {
      var resultContext = binding.getBoundContext();
      var result = resultContext ? resultContext.getObject() : null;
      binding.destroy();
      return result;
    });
  }

  function modelFrom(value) {
    if (value && typeof value.getModel === "function") return value.getModel();
    var context = contextFrom(value);
    if (context && typeof context.getModel === "function") return context.getModel();
    if (value && typeof value.getSource === "function") {
      var source = value.getSource();
      if (source && typeof source.getModel === "function") return source.getModel();
    }
    return environment.model;
  }

  return {
    setEnvironment: function (model, view, extensionAPI) {
      if (model) environment.model = model;
      if (view) environment.view = view;
      if (extensionAPI) environment.extensionAPI = extensionAPI;
    },

    /** Whether the AI assistant may be offered at all. The Fiori Elements actions bind
     *  their `visible` to the same flag; this is what keeps a press from opening the
     *  dialog if that binding never evaluated. */
    isAssistantAvailable: function () {
      return BusinessPartnerAssistant.isAvailable(environment.view);
    },

    clearEnvironment: function () {
      environment.model = null;
      environment.view = null;
      environment.extensionAPI = null;
    },

    isSingleSelection: function (bindingContext, selectedContexts) {
      return contextsFrom(bindingContext, selectedContexts).length === 1;
    },

    openCreatePage: function () {
      navigate("BusinessPartners/create");
    },

    openListPage: function () {
      navigate("");
    },

    openChangeRequests: function () {
      navigate("ChangeRequests");
    },

    openAssistant: function () {
      var values = Array.prototype.slice.call(arguments);
      var model = values.map(modelFrom).find(Boolean) || environment.model;
      if (!BusinessPartnerAssistant.isAvailable(environment.view)) return;
      // The assistant dialog owns and destroys itself; no page dependency is
      // required, which also keeps it working after returning to the list.
      BusinessPartnerAssistant.open(model, null);
    },

    /**
     * A partner under a request in flight is not editable: a second request over the same partner
     * would post over the first one's staged values. The list used to hide such a partner outright,
     * which is why nothing checked here before.
     */
    openEditPage: function (bindingContext, selectedContexts) {
      var selected = contextsFrom(bindingContext, selectedContexts);
      if (selected.length !== 1) {
        MessageBox.error("Select exactly one Business Partner to edit.");
        return;
      }
      var context = selected[0];
      if (context.getProperty("IsChangeRequest")) {
        explainRequest(context);
        return;
      }
      if (context.getProperty("ChangeRequest")) {
        MessageBox.warning(
          "This Business Partner already has a change request in flight. " + describeRequest(context)
        );
        return;
      }
      navigateToEdit(context.getProperty("BusinessPartner"));
    },

    /**
     * S/4 has no DELETE verb for a Business Partner - "deleting" one means setting its central
     * "Mark for Deletion" flag (IsMarkedForArchiving), the same reversible flag the BP transaction
     * uses. A direct write, like an edit - not staged or approved, since this is not a create.
     *
     * A pending create row is skipped: it has no Business Partner number yet, so there is nothing
     * in S/4 to mark.
     */
    markForDeletion: function (bindingContext, selectedContexts) {
      var selected = contextsFrom(bindingContext, selectedContexts);
      if (!selected.length) {
        MessageBox.error("Select at least one Business Partner to mark for deletion.");
        return;
      }
      var pending = selected.filter(function (context) { return context.getProperty("IsChangeRequest"); });
      var eligible = selected.filter(function (context) { return !context.getProperty("IsChangeRequest"); });
      if (!eligible.length) {
        MessageBox.error("A pending create has no Business Partner number yet, so it cannot be marked for deletion.");
        return;
      }
      var model = modelFrom(eligible[0]);
      if (!model) {
        MessageBox.error("The Business Partner service is not bound to this screen.");
        return;
      }
      var names = eligible.map(function (context) {
        return context.getProperty("BusinessPartner") + " - " + (context.getProperty("BusinessPartnerFullName") || "");
      });
      var skippedNote = pending.length
        ? "\n\n" + pending.length + " pending create row(s) were skipped: a create has no Business Partner number yet."
        : "";

      MessageBox.confirm(
        "This is applied directly in S/4HANA, without approval:\n\n" + names.join("\n") + skippedNote,
        {
          title: "Mark for Deletion",
          onClose: function (action) {
            if (action !== MessageBox.Action.OK) return undefined;
            return Promise.all(eligible.map(function (context) {
              return executeAction(model, "updateBusinessPartner", {
                BusinessPartner: context.getProperty("BusinessPartner"),
                IsMarkedForArchiving: true
              });
            })).then(function () {
              MessageToast.show(
                eligible.length === 1
                  ? "Business Partner marked for deletion."
                  : eligible.length + " Business Partners marked for deletion."
              );
              if (environment.extensionAPI && typeof environment.extensionAPI.refresh === "function") {
                environment.extensionAPI.refresh();
              }
            }).catch(function (error) {
              MessageBox.error("Could not mark for deletion: " + ((error && error.message) || error));
            });
          }
        }
      );
    },

    /**
     * A row in the merged search list is either a partner or a pending create. The create has no
     * partner number, so there is no display page to open - it says what it is instead.
     */
    openDisplayPage: function (bindingContext) {
      var context = contextFrom(bindingContext);
      if (!context) {
        navigateToDisplay("");
        return;
      }
      if (context.getProperty("IsChangeRequest")) {
        explainRequest(context);
        return;
      }
      navigateToDisplay(context.getProperty("BusinessPartner"));
    },

    openEditCurrentPage: function (bindingContext) {
      var context = contextFrom(bindingContext);
      var businessPartner = context ? context.getProperty("BusinessPartner") : businessPartnerFromHash();
      navigateToEdit(businessPartner);
    }
  };
});
