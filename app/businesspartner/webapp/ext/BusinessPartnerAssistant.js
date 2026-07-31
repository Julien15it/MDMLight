sap.ui.define([
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Input",
  "sap/m/Text",
  "sap/m/TextArea",
  "sap/m/VBox",
  "sap/m/MessageBox",
  "sap/ui/core/routing/HashChanger"
], function (Dialog, Button, Input, Text, TextArea, VBox, MessageBox, HashChanger) {
  "use strict";

  function errorMessage(error) {
    var responseText = error && error.cause && error.cause.responseText;
    if (responseText) {
      try {
        var response = JSON.parse(responseText);
        var message = response.error && response.error.message;
        if (typeof message === "object") message = message.value;
        if (message) return message;
      } catch (_ignored) {
        // Use the regular UI5 error below.
      }
    }
    return error && error.cause && error.cause.message
      || error && error.message
      || "The Business Partner Assistant is unavailable.";
  }

  function resultInfo(result) {
    if (typeof result === "string") return { answer: result, provider: "S/4HANA" };
    if (!result || typeof result !== "object") {
      return { answer: "No answer was returned.", provider: "Assistant" };
    }
    var payload = result.value && typeof result.value === "object" ? result.value : result;
    var suggestedData = {};
    try {
      suggestedData = payload.SuggestedData ? JSON.parse(payload.SuggestedData) : {};
    } catch (_ignored) {
      suggestedData = {};
    }
    return {
      answer: payload.Answer
        || payload.answer
        || payload.askBusinessPartnerAssistant
        || payload.Result
        || "No answer was returned.",
      provider: payload.Provider || payload.provider || "Assistant",
      suggestedAction: payload.SuggestedAction || "",
      suggestedData: suggestedData
    };
  }

  return {
    open: function (model, view) {
      if (!model) {
        MessageBox.error("The Business Partner service is not available.");
        return;
      }

      var transcript = "Assistant: Ask me about the Business Partners currently available in S/4HANA.\n\n"
        + "Examples:\n"
        + "- How many Business Partners are there?\n"
        + "- Which Business Partners are blocked?\n"
        + "- Show BP 1\n"
        + "- Find Brussels\n"
        + "- Find Business Partners in Dorpstraat\n"
        + "- What is the address of BP 1?\n"
        + "- Give me information about the company Coca-Cola";
      var conversation = new TextArea({
        value: transcript,
        editable: false,
        width: "100%",
        height: "22rem",
        growing: false
      }).addStyleClass("bpAssistantConversation");
      var question = new Input({
        placeholder: "Ask a question about the available Business Partners...",
        width: "100%"
      });
      var createSuggestionButton = new Button({
        text: "Create Suggested Business Partner",
        icon: "sap-icon://add-employee",
        type: "Attention",
        visible: false,
        press: function () {
          var draft = createSuggestionButton.data("draft") || {};
          var query = Object.keys(draft).map(function (key) {
            return encodeURIComponent(key) + "=" + encodeURIComponent(draft[key]);
          }).join("&");
          dialog.close();
          HashChanger.getInstance().setHash("BusinessPartners/create" + (query ? "?" + query : ""));
        }
      }).addStyleClass("sapUiSmallMarginTop");
      var dialog;

      var send = async function () {
        var value = question.getValue().trim();
        if (!value) return;

        transcript += "\n\nYou: " + value;
        conversation.setValue(transcript + "\n\nAssistant: Looking up live S/4HANA data...");
        question.setValue("");
        question.setEnabled(false);
        dialog.setBusy(true);

        var binding = model.bindContext("/askBusinessPartnerAssistant(...)");
        binding.setParameter("Question", value);
        try {
          await binding.execute("$direct");
          var context = binding.getBoundContext();
          var info = resultInfo(context && context.getObject());
          transcript += "\n\nAssistant (" + info.provider + "): " + info.answer;
          conversation.setValue(transcript);
          createSuggestionButton.data("draft", info.suggestedData);
          createSuggestionButton.setVisible(info.suggestedAction === "CREATE_BUSINESS_PARTNER");
        } catch (error) {
          var message = errorMessage(error);
          transcript += "\n\nAssistant: " + message;
          conversation.setValue(transcript);
        } finally {
          binding.destroy();
          dialog.setBusy(false);
          question.setEnabled(true);
          question.focus();
        }
      };

      question.attachSubmit(send);
      dialog = new Dialog({
        title: "Business Partner Assistant",
        icon: "sap-icon://discussion-2",
        contentWidth: "44rem",
        resizable: true,
        draggable: true,
        stretchOnPhone: true,
        content: new VBox({
          items: [
            new Text({
              text: "The assistant searches live S/4HANA Business Partner and address data, checks possible duplicates, and can use clearly sourced public company information to prepare a new Business Partner.",
              wrapping: true
            }).addStyleClass("sapUiSmallMarginBottom"),
            conversation,
            createSuggestionButton,
            question.addStyleClass("sapUiSmallMarginTop")
          ]
        }).addStyleClass("sapUiSmallMargin"),
        beginButton: new Button({
          text: "Send",
          icon: "sap-icon://paper-plane",
          type: "Emphasized",
          press: send
        }),
        endButton: new Button({
          text: "Close",
          press: function () { dialog.close(); }
        }),
        afterOpen: function () { question.focus(); },
        afterClose: function () { dialog.destroy(); }
      });
      if (view && typeof view.addDependent === "function") view.addDependent(dialog);
      dialog.open();
    }
  };
});
