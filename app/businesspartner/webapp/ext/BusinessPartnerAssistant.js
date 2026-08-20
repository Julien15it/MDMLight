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

  // An idle approuter session answers an XHR with a bare 401, which only a reload can recover.
  function isSessionExpired(error) {
    var cause = error && error.cause;
    var status = (cause && (cause.status || cause.statusCode))
      || (error && (error.status || error.statusCode));
    if (Number(status) === 401) return true;
    var text = (cause && cause.message) || (error && error.message) || "";
    return /\b401\b/.test(String(text));
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
    // Exposed so the session-expiry branch can be tested without a browser.
    _isSessionExpired: isSessionExpired,

    /**
     * Whether the assistant may be offered. False once a steward switches AI
     * assistance off: the assistant is the one feature that exists only to reach a
     * language model, so it is withdrawn rather than quietly answered without one.
     *
     * Defaults to true only when there is no perm model at all - a view outside the
     * component, or a service too old to report the flag - matching
     * srv/ai/availability.js. Where the model exists it starts false and is corrected
     * once currentUserPermissions answers, so nothing is offered before it is known to
     * be allowed. Courtesy either way: askBusinessPartnerAssistant refuses on the
     * server.
     */
    isAvailable: function (view) {
      var permissions = view && view.getModel && view.getModel("perm");
      return !permissions || permissions.getProperty("/aiAssistanceEnabled") !== false;
    },
    open: function (model, view) {
      if (!model) {
        MessageBox.error("The Business Partner service is not available.");
        return;
      }

      var transcript = "Assistant: Ask me a free-form question about Business Partners. "
        + "I use the configured SAP AI Core model with live S/4HANA data, check possible duplicates, "
        + "and can prepare a reviewed creation proposal when a company is not yet present.";
      var conversationHistory = [];
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
        binding.setParameter("ConversationJson", JSON.stringify(conversationHistory.slice(-10)));
        try {
          await binding.execute("$direct");
          var context = binding.getBoundContext();
          var info = resultInfo(context && context.getObject());
          transcript += "\n\nAssistant (" + info.provider + "): " + info.answer;
          conversationHistory.push(
            { role: "user", content: value },
            { role: "assistant", content: info.answer }
          );
          conversation.setValue(transcript);
          createSuggestionButton.data("draft", info.suggestedData);
          createSuggestionButton.setVisible(info.suggestedAction === "CREATE_BUSINESS_PARTNER");
        } catch (error) {
          if (isSessionExpired(error)) {
            transcript += "\n\nAssistant: Your session expired, so the question was not sent. "
              + "Reload the page to sign in again.";
            conversation.setValue(transcript);
            MessageBox.error(
              "Your session expired, so the question was not sent. Reload the page to sign in again.",
              {
                actions: ["Reload", MessageBox.Action.CANCEL],
                emphasizedAction: "Reload",
                onClose: function (action) {
                  if (action === "Reload") window.location.reload();
                }
              }
            );
          } else {
            transcript += "\n\nAssistant: " + errorMessage(error);
            conversation.setValue(transcript);
          }
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
