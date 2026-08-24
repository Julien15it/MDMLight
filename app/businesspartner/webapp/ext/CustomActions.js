sap.ui.define([
  "sap/ui/core/routing/HashChanger",
  "sap/m/MessageBox",
  "mdm/md/businesspartner/reuse/BusinessPartnerAssistant"
], function (HashChanger, MessageBox, BusinessPartnerAssistant) {
  "use strict";

  var environment = { model: null, view: null };

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
   * A change request row reports itself and leads nowhere. Deliberately: the search list is open to
   * everyone, and the only route to a saved draft is the steward-gated Change Requests list. Making
   * this row a link would hand every user someone else's draft, which is a permission change and not
   * what showing the request in the list is for. An `inApproval` request is the approver's, opened
   * from their inbox, so a decision is always taken against a real task.
   */
  function explainRequest(context) {
    MessageBox.information(
      describeRequest(context)
      + " It is already in progress, so there is no need to request it again."
    );
  }

  /** One sentence naming the request, so a blocked action says which one is in the way. */
  function describeRequest(context) {
    var status = context.getProperty("RecordStatus") || "A change request";
    var by = context.getProperty("RequestedBy");
    return status + (by ? ", requested by " + by + "." : ".");
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
    setEnvironment: function (model, view) {
      if (model) environment.model = model;
      if (view) environment.view = view;
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
