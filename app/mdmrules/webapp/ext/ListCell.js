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

    /**
     * Every token cell on the table, as `{ cell, sink, context, path }`.
     *
     * `sink` is the hidden `Input` beside the MultiInput, and it is the only thing that WRITES:
     * a `context.setProperty` write reached the client model and never the server, so the column
     * looked saved until the app was left and re-entered (2026-08-21). Everything on these pages
     * that does save is written by a two-way binding, so the list is too - the MultiInput is
     * display only.
     */
    var listCells = function () {
      var table = getTable();
      if (!table) return [];
      var cells = [];
      var walk = function (control, context, found) {
        if (!control || !control.isA) return;
        if (control.isA("sap.m.MultiInput") && control.data("listPath")) {
          found.cell = control;
          found.path = control.data("listPath");
        } else if (control.isA("sap.m.Input") && control.data("listSink")) {
          found.sink = control;
        }
        // The pair sits in a container, so one level of nesting is walked rather than assumed.
        if (control.getItems) control.getItems().forEach(function (child) {
          walk(child, context, found);
        });
      };
      table.getItems().forEach(function (item) {
        var context = item.getBindingContext("dc");
        if (!context) return;
        item.getCells().forEach(function (cell) {
          var found = {};
          walk(cell, context, found);
          if (found.cell && found.path) {
            cells.push({ cell: found.cell, sink: found.sink, context: context, path: found.path });
          }
        });
      });
      return cells;
    };

    /** The bound writer for one MultiInput, found through the row it belongs to. */
    var sinkFor = function (cell) {
      var match = listCells().filter(function (entry) { return entry.cell === cell; })[0];
      return match ? match.sink : null;
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
      var sink = sinkFor(cell);
      if (sink) {
        // A property change on a two-way bound control, which is how every column here that saves
        // gets written. `setValue` propagates through the binding; `setProperty` on the context did
        // not travel, and the value was lost the moment the app was left.
        sink.setValue(stored);
      } else {
        // A page that forgot its sink would silently stop saving, which is the bug this replaced.
        console.error("[ListCell] " + path + " has no bound writer, so it cannot be saved.");
        context.setProperty(path, stored);
      }
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
