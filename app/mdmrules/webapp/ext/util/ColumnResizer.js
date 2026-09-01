sap.ui.define([
  "sap/ui/core/Element"
], function (Element) {
  "use strict";

  /**
   * Resize a `sap.m.Table`'s columns by dragging the BORDER between two header cells
   * (2026-09-02, asked for on every rule tile). Columns are never MOVED - there is no reordering
   * here and no `dragDropConfig` anywhere on these tables; the only thing a drag changes is how
   * wide a column is.
   *
   * `sap.m.Table` has no resizing of its own - that is `sap.ui.table.Table` - so the grip is a
   * real DOM element on the right-hand edge of each `<th>`, and the drag ends in `Column#setWidth`.
   * Writing the
   * width back onto the control rather than onto the DOM is what makes it survive the next
   * re-render, which every keystroke in a bound cell can cause.
   *
   * Shared by all five rule pages, the same way XlsxCodec is: the mechanics are identical and only
   * the table differs.
   */

  var HANDLE_CLASS = "mdmColumnResizer";

  // Narrower than this and the header text is gone, which is not a width anyone chose on purpose.
  var MIN_WIDTH_PX = 48;

  // The renderer stamps the column's own id onto its `<th>`, which is the mapping that cannot be
  // thrown off by a hidden column. `install` falls back to position where it does not.
  function columnOf(header) {
    var control = header && header.id ? Element.getElementById(header.id) : null;
    return control && control.isA && control.isA("sap.m.Column") ? control : null;
  }

  function stopDrag(state) {
    document.removeEventListener("mousemove", state.move);
    document.removeEventListener("mouseup", state.up);
    document.body.classList.remove("mdmColumnResizing");
  }

  /**
   * One grip per header cell, on its right-hand border - the line between this column and the next,
   * which is what a person reaches for to make one narrower. `onResize` is told the DELTA in
   * pixels, because the pages
   * that scroll sideways carry their own table width and have to widen by exactly what a column
   * gained - see `_applyTableWidth` in the rule controllers.
   */
  function attachHandle(header, column, onResize) {
    if (header.querySelector("." + HANDLE_CLASS)) return;
    // Set here rather than in the stylesheet: the handle is absolutely positioned against the cell,
    // and matching the header cell by its theme class would be a guess about a private class name.
    header.style.position = "relative";
    var handle = document.createElement("div");
    handle.className = HANDLE_CLASS;
    header.appendChild(handle);

    handle.addEventListener("mousedown", function (event) {
      // Both are load-bearing: the header cell is itself a press target (column menus, sorting),
      // and a drag that starts a text selection leaves the whole page highlighted.
      event.preventDefault();
      event.stopPropagation();

      var startX = event.clientX;
      var startWidth = header.offsetWidth;
      var width = startWidth;
      var state = {};

      state.move = function (moveEvent) {
        width = Math.max(MIN_WIDTH_PX, startWidth + (moveEvent.clientX - startX));
        // Live feedback only - the control is written on mouseup, which is what actually persists.
        header.style.width = width + "px";
      };
      state.up = function () {
        stopDrag(state);
        if (width === startWidth) return;
        column.setWidth(width + "px");
        if (onResize) onResize(width - startWidth);
      };

      document.body.classList.add("mdmColumnResizing");
      document.addEventListener("mousemove", state.move);
      document.addEventListener("mouseup", state.up);
    });
  }

  // The header cells that stand for a real column: not the MultiSelect checkbox, the navigation
  // arrow or the trailing filler, none of which is anything to resize.
  var NOT_A_COLUMN = ["sapMListTblSelCol", "sapMListTblNavCol", "sapMListTblDummyCell", "sapMListTblHighlightCol"];

  function isColumnCell(header) {
    return !NOT_A_COLUMN.some(function (name) { return header.classList.contains(name); });
  }

  /**
   * Header cell -> column. The id is tried first because it survives a hidden column; falling back
   * to POSITION is what makes this independent of whether the renderer stamps the column's id onto
   * the `<th>` at all, and the visible columns are what the positions line up with - a hidden
   * column renders no cell.
   */
  function install(table, onResize) {
    var dom = table.getDomRef();
    if (!dom) return;
    var headers = Array.prototype.filter.call(dom.querySelectorAll("thead > tr > th"), isColumnCell);
    var visible = table.getColumns().filter(function (column) { return column.getVisible(); });
    headers.forEach(function (header, index) {
      var column = columnOf(header) || visible[index];
      if (column) attachHandle(header, column, onResize);
    });
  }

  return {
    MIN_WIDTH_PX: MIN_WIDTH_PX,

    /**
     * Puts a resize grip on the right-hand border of every header cell of `table`. Re-installed
     * after each render, because re-rendering throws the grips away with the rest of the DOM.
     */
    enable: function (table, options) {
      if (!table) return;
      var onResize = (options || {}).onResize;
      table.addEventDelegate({
        onAfterRendering: function () { install(table, onResize); }
      });
      install(table, onResize);
    }
  };
});
