sap.ui.define(["sap/m/Token"], function (Token) {
  "use strict";

  /**
   * The multi-value cells on the rule tables. Shared by all four pages rather than copied into
   * each: it is sixty lines of aggregation bookkeeping, and four copies of it drift the first time
   * one is fixed - the same reason the maintenance screen lives in app/reuse.
   *
   * A `MultiInput`'s `tokens` is an aggregation and the column behind it is one string, so the two
   * are kept in step by hand: `tokens` cannot be bound to a string and a formatter cannot create
   * controls. Rendered rows are filled from the stored value and every edit writes the whole list
   * back.
   *
   * Mirrors DELIMITER in srv/checks/value-lists.js. `workflowRuleOptions` reports the server's, so
   * a page can check the two agree rather than showing one token where three are saved.
   */
  var DELIMITER = "|";

  function parseList(raw) {
    return String(raw === null || raw === undefined ? "" : raw)
      .split(DELIMITER)
      .map(function (entry) { return entry.trim(); })
      .filter(function (entry, index, all) { return entry && all.indexOf(entry) === index; });
  }

  function formatList(values) {
    return parseList(Array.isArray(values) ? values.join(DELIMITER) : values).join(DELIMITER);
  }

  /**
   * Gives a controller the four handlers its view binds, over the table `getTable` returns.
   * `onChanged` is called after every write, which is how a page marks itself dirty.
   *
   * The handler NAMES are part of the contract: every rule view binds `.onRowsRendered`,
   * `.onListTokenUpdate`, `.onListSubmit` and `.onListChange`, so a cell moved between pages keeps
   * working.
   */
  function mixin(controller, options) {
    var getTable = options.getTable;
    var onChanged = options.onChanged || function () {};

    var listCells = function () {
      var table = getTable();
      if (!table) return [];
      var cells = [];
      table.getItems().forEach(function (item) {
        var context = item.getBindingContext("dc");
        if (!context) return;
        item.getCells().forEach(function (cell) {
          if (!cell.isA || !cell.isA("sap.m.MultiInput")) return;
          var path = cell.data("listPath");
          if (path) cells.push({ cell: cell, context: context, path: path });
        });
      });
      return cells;
    };

    var fillTokens = function (cell, context, path) {
      var stored = formatList(context.getProperty(path));
      // Nothing to redraw when the cell already shows what is stored - and re-templating a row
      // while someone is typing in it would take their half-typed value away.
      if (cell.data("shownList") === stored) return;
      cell.removeAllTokens();
      parseList(stored).forEach(function (value) {
        cell.addToken(new Token({ key: value, text: value }));
      });
      cell.data("shownList", stored);
    };

    var syncTokens = function () {
      listCells().forEach(function (entry) {
        fillTokens(entry.cell, entry.context, entry.path);
      });
    };

    /**
     * Writes the whole list back, then re-reads it. The round trip is what makes this
     * self-correcting: a token the control added itself for a value already in the list is
     * de-duplicated by `formatList`, so the cell ends up showing exactly what is saved.
     */
    var writeTokens = function (cell, tokens) {
      var context = cell.getBindingContext("dc");
      var path = cell.data("listPath");
      if (!context || !path) return;
      var stored = formatList((tokens || cell.getTokens()).map(function (token) {
        return token.getText();
      }));
      context.setProperty(path, stored);
      cell.data("shownList", null);
      fillTokens(cell, context, path);
      onChanged();
    };

    var takeTypedValue = function (cell, raw) {
      var values = parseList(raw);
      if (!values.length) return;
      var tokens = cell.getTokens().concat(values.map(function (value) {
        return new Token({ key: value, text: value });
      }));
      cell.setValue("");
      writeTokens(cell, tokens);
    };

    controller.onRowsRendered = syncTokens;

    // `tokenUpdate` fires BEFORE the aggregation is changed, so the new list is computed from the
    // added and removed tokens rather than read back off the control.
    controller.onListTokenUpdate = function (event) {
      var cell = event.getSource();
      var removed = event.getParameter("removedTokens") || [];
      var added = event.getParameter("addedTokens") || [];
      var tokens = cell.getTokens()
        .filter(function (token) { return removed.indexOf(token) < 0; })
        .concat(added);
      writeTokens(cell, tokens);
    };

    /** Enter. The value becomes a token, so a list is typed rather than assembled from a dialog. */
    controller.onListSubmit = function (event) {
      takeTypedValue(event.getSource(), event.getParameter("value"));
    };

    // Leaving the cell keeps what was typed, rather than making Enter the only way to commit a
    // value - a token silently dropped on the way out is a rule quietly missing a condition.
    controller.onListChange = function (event) {
      takeTypedValue(event.getSource(), event.getParameter("value"));
    };

    /**
     * Adds values to a cell from somewhere other than the keyboard - a value help, today. They are
     * ADDED to what is there rather than replacing it: a list is built up, and a dialog that wiped
     * what the cell already held would be a trap. Duplicates fall out in the round trip.
     */
    controller.addListValues = function (cell, values) {
      var tokens = cell.getTokens().concat((values || []).map(function (value) {
        return new Token({ key: value, text: value });
      }));
      writeTokens(cell, tokens);
    };

    // Discard leaves the cells showing the abandoned lists, and nothing else redraws them.
    controller.resetListCells = function () {
      listCells().forEach(function (entry) { entry.cell.data("shownList", null); });
      syncTokens();
    };
  }

  return {
    DELIMITER: DELIMITER,
    parseList: parseList,
    formatList: formatList,
    mixin: mixin
  };
});
