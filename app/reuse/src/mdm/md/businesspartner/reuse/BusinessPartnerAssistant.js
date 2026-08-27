sap.ui.define([
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Input",
  "sap/m/Text",
  "sap/m/List",
  "sap/m/FeedListItem",
  "sap/m/VBox",
  "sap/m/MessageBox",
  "sap/ui/model/json/JSONModel",
  "sap/ui/core/routing/HashChanger"
], function (
  Dialog, Button, Input, Text, List, FeedListItem, VBox, MessageBox, JSONModel, HashChanger
) {
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

      /**
       * One list drives what is on screen - `sender`/`role` decide the colour, a `FeedListItem`
       * per turn instead of one growing block of plain text, so "who typed what" is legible at a
       * glance rather than read out of "You: "/"Assistant: " prefixes buried in a wall of text.
       * `conversationHistory` below is the separate, narrower thing the model actually reasons
       * over - the last 10 user/assistant turns, no system intro, no error text - so widening the
       * screen's own record here never risks widening what is sent as context.
       */
      var chatModel = new JSONModel({ messages: [] });
      var messages = chatModel.getProperty("/messages");

      function pushMessage(role, sender, text) {
        messages.push({ role: role, sender: sender, text: text });
        chatModel.setProperty("/messages", messages);
        scrollToBottom();
      }

      // Removes the transient "Looking up..." placeholder once the real answer (or error) is in.
      function popMessage() {
        messages.pop();
        chatModel.setProperty("/messages", messages);
      }

      function scrollToBottom() {
        setTimeout(function () {
          var dom = chatList.getDomRef();
          if (dom) dom.scrollTop = dom.scrollHeight;
        }, 0);
      }

      var chatList = new List({
        showSeparators: "None",
        noDataText: " "
      }).addStyleClass("bpAssistantChat");
      chatList.setModel(chatModel);
      chatList.bindItems({
        path: "/messages",
        // A factory, not a static template: the style class - the colour - depends on which row
        // this is, and a template cannot vary per item the way a factory function can.
        factory: function (id, context) {
          var entry = context.getObject();
          var item = new FeedListItem({
            sender: entry.sender,
            text: entry.text,
            icon: entry.role === "user" ? "sap-icon://person-placeholder" : "sap-icon://discussion-2",
            iconDisplayShape: "Circle"
          });
          item.addStyleClass(entry.role === "user" ? "bpChatUser"
            : (entry.role === "system" ? "bpChatSystem" : "bpChatAssistant"));
          return item;
        }
      });

      pushMessage(
        "system", "Assistant",
        "Ask me a free-form question about Business Partners. I use the configured SAP AI Core "
        + "model with live S/4HANA data, check possible duplicates, and can prepare a reviewed "
        + "creation proposal when a company is not yet present."
      );

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
          // A single JSON blob, not flat key=value pairs: the suggestion can carry a TaxNumbers
          // row (from a VIES-confirmed registry lookup) alongside root fields and an Addresses row,
          // and a flat query string has no way to express a child-entity array.
          var draft = createSuggestionButton.data("draft") || {};
          var hasDraft = Object.keys(draft).length > 0;
          var query = hasDraft ? "?draft=" + encodeURIComponent(JSON.stringify(draft)) : "";
          dialog.close();
          HashChanger.getInstance().setHash("BusinessPartners/create" + query);
        }
      }).addStyleClass("sapUiSmallMarginTop");
      var dialog;
      var conversationHistory = [];

      var send = async function () {
        var value = question.getValue().trim();
        if (!value) return;

        pushMessage("user", "You", value);
        pushMessage("assistant", "Assistant", "Looking up live S/4HANA data...");
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
          popMessage();
          pushMessage("assistant", "Assistant (" + info.provider + ")", info.answer);
          conversationHistory.push(
            { role: "user", content: value },
            { role: "assistant", content: info.answer }
          );
          createSuggestionButton.data("draft", info.suggestedData);
          createSuggestionButton.setVisible(info.suggestedAction === "CREATE_BUSINESS_PARTNER");
        } catch (error) {
          popMessage();
          if (isSessionExpired(error)) {
            pushMessage(
              "assistant", "Assistant",
              "Your session expired, so the question was not sent. Reload the page to sign in again."
            );
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
            pushMessage("assistant", "Assistant", errorMessage(error));
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
        contentWidth: "60rem",
        contentHeight: "40rem",
        resizable: true,
        draggable: true,
        stretchOnPhone: true,
        content: new VBox({
          items: [
            new Text({
              text: "The assistant searches live S/4HANA Business Partner and address data, checks possible duplicates, and can use clearly sourced public company information to prepare a new Business Partner.",
              wrapping: true
            }).addStyleClass("sapUiSmallMarginBottom"),
            chatList,
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
