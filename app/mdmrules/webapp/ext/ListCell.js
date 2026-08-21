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
     * Set while THIS module is redrawing a cell's tokens, and checked by every handler that writes.
     *
     * Without it the module destroys data. `applyTokens` calls `removeAllTokens()` to redraw, the
     * control reports those tokens as removed, `onListTokenUpdate` computes the resulting list as
     * empty and writes `""` back - through the bound sink, so it is a real change. Opening a page
     * therefore blanked every stored condition value, and typing one in re-entered the same loop
     * (reported 2026-08-21).
     *
     * A counter rather than a boolean because a redraw can be reached from inside a write, and the
     * inner one must not clear the outer one's guard.
     */
    var redrawing = 0;

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

    /**
     * Draws exactly the list it is given. Separate from reading the model on purpose: the write
     * path must NOT read back what it just wrote.
     *
     * That read-back is what stopped a typed address from sticking (2026-08-21). While the write
     * went through `context.setProperty` the client cache updated synchronously, so re-reading saw
     * the new value; through a two-way binding it does not reliably, so the read returned the
     * PREVIOUS value and the token the requester had just typed was removed again a line later.
     */
    var applyTokens = function (cell, stored) {
      // Nothing to redraw when the cell already SHOWS this - and re-templating a row while someone
      // is typing in it would take their half-typed value away. Compared against the tokens on
      // screen as well as the cached answer, which is what keeps this self-correcting: if the
      // control added a token of its own for a value already in the list, the two disagree and the
      // cell is rebuilt from the list that was actually stored.
      var shown = formatList(cell.getTokens().map(function (token) { return token.getText(); }));
      if (shown === stored && cell.data("shownList") === stored) return;
      redrawing += 1;
      try {
        cell.removeAllTokens();
        parseList(stored).forEach(function (value) {
          cell.addToken(new Token({ key: value, text: value }));
        });
      } finally {
        // `finally`, or one throwing token leaves the guard up and the cell silently read-only.
        redrawing -= 1;
      }
      cell.data("shownList", stored);
    };

    /** The render path: what the model holds is what the cell should show. */
    var fillTokens = function (cell, context, path) {
      applyTokens(cell, formatList(context.getProperty(path)));
    };

    var syncTokens = function () {
      listCells().forEach(function (entry) {
        fillTokens(entry.cell, entry.context, entry.path);
      });
    };

    /**
     * Writes the whole list back and draws that same list. `formatList` de-duplicates on the way
     * through, so a token the control added itself for a value already in the list collapses - and
     * `applyTokens` compares against the tokens on screen, so the stray one is cleaned up.
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
      // Drawn from what was just written, never re-read from the model: the binding may not have
      // published it yet, and a read that came back with the previous value used to delete the
      // token the requester had only just typed.
      applyTokens(cell, stored);
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
      // Our own redraw reports every token as removed. Acting on that is what emptied the column.
      if (redrawing) return;
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
      if (redrawing) return;
      takeTypedValue(event.getSource(), event.getParameter("value"));
    };

    // Leaving the cell keeps what was typed, rather than making Enter the only way to commit a
    // value - a token silently dropped on the way out is a rule quietly missing a condition.
    controller.onListChange = function (event) {
      if (redrawing) return;
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
