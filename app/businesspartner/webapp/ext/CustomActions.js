sap.ui.define([
  "sap/ui/core/routing/HashChanger",
  "sap/m/MessageBox",
  "mdm/md/businesspartner/manage/ext/BusinessPartnerAssistant"
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

    openAssistant: function () {
      var values = Array.prototype.slice.call(arguments);
      var model = values.map(modelFrom).find(Boolean) || environment.model;
      // The assistant dialog owns and destroys itself; no page dependency is
      // required, which also keeps it working after returning to the list.
      BusinessPartnerAssistant.open(model, null);
    },

    openEditPage: function (bindingContext, selectedContexts) {
      var selected = contextsFrom(bindingContext, selectedContexts);
      if (selected.length !== 1) {
        MessageBox.error("Select exactly one Business Partner to edit.");
        return;
      }
      navigateToEdit(selected[0].getProperty("BusinessPartner"));
    },

    openDisplayPage: function (bindingContext) {
      var context = contextFrom(bindingContext);
      navigateToDisplay(context && context.getProperty("BusinessPartner"));
    },

    openEditCurrentPage: function (bindingContext) {
      var context = contextFrom(bindingContext);
      var businessPartner = context ? context.getProperty("BusinessPartner") : businessPartnerFromHash();
      navigateToEdit(businessPartner);
    }
  };
});
