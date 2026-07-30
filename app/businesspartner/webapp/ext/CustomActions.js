sap.ui.define([
  "sap/ui/core/routing/HashChanger",
  "sap/m/MessageBox"
], function (HashChanger, MessageBox) {
  "use strict";

  function contextsFrom(bindingContext, selectedContexts) {
    if (Array.isArray(selectedContexts)) return selectedContexts;
    if (Array.isArray(bindingContext)) return bindingContext;
    if (bindingContext && typeof bindingContext.getProperty === "function") return [bindingContext];
    return [];
  }

  function contextFrom(value) {
    if (!value) return null;
    if (typeof value.getProperty === "function") return value;
    if (Array.isArray(value)) return contextFrom(value[0]);
    if (typeof value.getSource === "function") {
      var source = value.getSource();
      if (source && typeof source.getBindingContext === "function") {
        return source.getBindingContext();
      }
    }
    return null;
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

  return {
    setEnvironment: function () {},

    clearEnvironment: function () {},

    isSingleSelection: function (bindingContext, selectedContexts) {
      return contextsFrom(bindingContext, selectedContexts).length === 1;
    },

    openCreatePage: function () {
      navigate("BusinessPartners/create");
    },

    openEditPage: function (bindingContext, selectedContexts) {
      var selected = contextsFrom(bindingContext, selectedContexts);
      if (selected.length !== 1) {
        MessageBox.error("Select exactly one Business Partner to edit.");
        return;
      }
      navigateToEdit(selected[0].getProperty("BusinessPartner"));
    },

    openEditCurrentPage: function (bindingContext) {
      var context = contextFrom(bindingContext);
      var businessPartner = context ? context.getProperty("BusinessPartner") : businessPartnerFromHash();
      navigateToEdit(businessPartner);
    }
  };
});
