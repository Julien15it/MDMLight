sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, UIComponent, Fragment, JSONModel, Filter, FilterOperator, MessageBox, MessageToast) {
  "use strict";

  var UPDATE_GROUP = "ruleChanges";

  // Identity/managed columns that must never travel back on a create - `binding.create` is a POST,
  // and sending an existing key or a server-assigned timestamp is either ignored or rejected
  // depending on the column, never something worth relying on either way. Shared by Duplicate and
  // by the Excel import, since both build a fresh row from data that already carries these.
  var STRIP_ON_COPY = ["ID", "@odata.etag", "createdAt", "createdBy", "modifiedAt", "modifiedBy"];

  // --- A real .xlsx, BRF+-style: header-row-driven fixed columns, one row per rule ------------------
  //
  // BRF+'s own decision-table Excel up/download is the model asked for: a plain worksheet with a
  // header row naming each column, one data row per rule, no packed cells or DSL - which is exactly
  // what "op basis van al die fixed velden" (based on those fixed fields, now that conditions are two
  // fixed slots again) describes. A real .xlsx is a ZIP of SpreadsheetML/OOXML parts; this repo has
  // never taken a dependency on a spreadsheet library (the CSV codec this replaces was the previous
  // answer to that), and the format is small enough to hand-roll once inline strings avoid needing
  // `xl/sharedStrings.xml` on WRITE and the ZIP container needs only STORE (uncompressed) entries on
  // write - which sidesteps implementing DEFLATE for export while still producing a file Excel opens
  // natively. READING still has to cope with whatever Excel itself saves, which always compresses
  // with DEFLATE and always rewrites inline strings into `xl/sharedStrings.xml` - so import decompresses
  // via the browser's own `DecompressionStream('deflate-raw')` (a Web Platform built-in, not a bundled
  // inflate implementation) and reads shared strings back by index.

  /** Standard, reflected CRC-32 (polynomial 0xEDB88320) - the ZIP format's own checksum, required in
   *  every local/central file header regardless of compression method. */
  function crc32(bytes) {
    if (!crc32.table) {
      var table = new Uint32Array(256);
      for (var n = 0; n < 256; n += 1) {
        var c = n;
        for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
      crc32.table = table;
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i += 1) crc = crc32.table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(str);
  }

  function xmlEscape(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
  }

  var COLUMN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  /** 0-based column index -> spreadsheet column letters ("A", "B", ..., "AA", ...). */
  function columnLetters(index) {
    var letters = "";
    var n = index + 1;
    while (n > 0) {
      var remainder = (n - 1) % 26;
      letters = COLUMN_LETTERS[remainder] + letters;
      n = Math.floor((n - 1) / 26);
    }
    return letters;
  }

  /** Spreadsheet column letters ("B", "AA", ...) -> 0-based column index. */
  function columnIndexOf(cellRef) {
    var letters = /^[A-Z]+/u.exec(cellRef)[0];
    var index = 0;
    for (var i = 0; i < letters.length; i += 1) index = index * 26 + (letters.charCodeAt(i) - 64);
    return index - 1;
  }

  // --- Building the ZIP container (STORE only - export never needs DEFLATE) -----------------------

  function writeUint32LE(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
  function writeUint16LE(view, offset, value) { view.setUint16(offset, value & 0xFFFF, true); }

  /** files: [{ name, data: Uint8Array }]. Every entry is stored uncompressed - valid per the ZIP
   *  spec, opens natively in Excel, and needs no DEFLATE implementation for the write side. */
  function zipStore(files) {
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    files.forEach(function (file) {
      var nameBytes = utf8Bytes(file.name);
      var data = file.data;
      var crc = crc32(data);

      var localHeader = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(localHeader.buffer);
      writeUint32LE(lv, 0, 0x04034b50);
      writeUint16LE(lv, 4, 20);
      writeUint16LE(lv, 6, 0x0800); // UTF-8 file names
      writeUint16LE(lv, 8, 0); // method: store
      writeUint16LE(lv, 10, 0); // DOS time - not meaningful for a generated export
      writeUint16LE(lv, 12, 0x0021); // DOS date: 1980-01-01
      writeUint32LE(lv, 14, crc);
      writeUint32LE(lv, 18, data.length);
      writeUint32LE(lv, 22, data.length);
      writeUint16LE(lv, 26, nameBytes.length);
      writeUint16LE(lv, 28, 0);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, data);

      var centralHeader = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(centralHeader.buffer);
      writeUint32LE(cv, 0, 0x02014b50);
      writeUint16LE(cv, 4, 20);
      writeUint16LE(cv, 6, 20);
      writeUint16LE(cv, 8, 0x0800);
      writeUint16LE(cv, 10, 0);
      writeUint16LE(cv, 12, 0);
      writeUint16LE(cv, 14, 0x0021);
      writeUint32LE(cv, 16, crc);
      writeUint32LE(cv, 20, data.length);
      writeUint32LE(cv, 24, data.length);
      writeUint16LE(cv, 28, nameBytes.length);
      writeUint32LE(cv, 42, offset);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + data.length;
    });

    var centralOffset = offset;
    var centralSize = centralParts.reduce(function (sum, part) { return sum + part.length; }, 0);

    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    writeUint32LE(ev, 0, 0x06054b50);
    writeUint16LE(ev, 8, files.length);
    writeUint16LE(ev, 10, files.length);
    writeUint32LE(ev, 12, centralSize);
    writeUint32LE(ev, 16, centralOffset);

    var out = new Uint8Array(offset + centralSize + end.length);
    var pos = 0;
    localParts.concat(centralParts, [end]).forEach(function (part) { out.set(part, pos); pos += part.length; });
    return out;
  }

  // --- Reading the ZIP container back (STORE from our own export, DEFLATE from Excel's own save) ---

  function readUint32LE(view, offset) { return view.getUint32(offset, true); }
  function readUint16LE(view, offset) { return view.getUint16(offset, true); }

  /** Scans backward for the end-of-central-directory signature, tolerating a short archive comment
   *  the way real ZIP readers do (Excel itself never writes one, but nothing guarantees that). */
  function findEndOfCentralDirectory(bytes) {
    var minLength = 22;
    if (bytes.length < minLength) return -1;
    var maxCommentLength = Math.min(bytes.length - minLength, 0xFFFF);
    for (var i = 0; i <= maxCommentLength; i += 1) {
      var pos = bytes.length - minLength - i;
      if (bytes[pos] === 0x50 && bytes[pos + 1] === 0x4b && bytes[pos + 2] === 0x05 && bytes[pos + 3] === 0x06) {
        return pos;
      }
    }
    return -1;
  }

  function readCentralDirectory(bytes) {
    var eocdOffset = findEndOfCentralDirectory(bytes);
    if (eocdOffset === -1) throw new Error("This is not a valid .xlsx file (no end-of-central-directory record).");
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var entryCount = readUint16LE(view, eocdOffset + 10);
    var pos = readUint32LE(view, eocdOffset + 16);
    var entries = [];
    for (var i = 0; i < entryCount; i += 1) {
      if (readUint32LE(view, pos) !== 0x02014b50) throw new Error("This .xlsx file's central directory is corrupt.");
      var method = readUint16LE(view, pos + 10);
      var compressedSize = readUint32LE(view, pos + 20);
      var nameLength = readUint16LE(view, pos + 28);
      var extraLength = readUint16LE(view, pos + 30);
      var commentLength = readUint16LE(view, pos + 32);
      var localHeaderOffset = readUint32LE(view, pos + 42);
      var name = new TextDecoder("utf-8").decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
      entries.push({ name: name, method: method, compressedSize: compressedSize, localHeaderOffset: localHeaderOffset });
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  /** method 0 (store) is returned as-is; method 8 (deflate) is decompressed through the browser's own
   *  `DecompressionStream` - real Excel always saves with DEFLATE, so import has to read it even
   *  though export never writes it. Any other method is refused by name rather than misread. */
  async function extractZipEntry(bytes, entry) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = entry.localHeaderOffset;
    if (readUint32LE(view, pos) !== 0x04034b50) throw new Error("This .xlsx file's local file header for \"" + entry.name + "\" is corrupt.");
    var nameLength = readUint16LE(view, pos + 26);
    var extraLength = readUint16LE(view, pos + 28);
    var dataStart = pos + 30 + nameLength + extraLength;
    var compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) {
      var stream = new Response(compressed).body.pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error("\"" + entry.name + "\" uses a compression method (" + entry.method + ") this reader does not support.");
  }

  // --- A tiny, targeted XML reader (not a general parser - just what our own worksheet XML needs) --
  //
  // DOMParser would do this too, but keeping the whole read path to plain string scanning - the same
  // choice this file's hand-rolled CSV codec already made over adding a dependency - keeps every one
  // of these functions runnable, and testable, outside a browser.

  function xmlUnescape(value) {
    return String(value)
      .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
  }

  function parseAttrs(attrString) {
    var attrs = {};
    var re = /([\w:]+)="([^"]*)"/gu;
    var match = re.exec(attrString || "");
    while (match !== null) {
      attrs[match[1]] = xmlUnescape(match[2]);
      match = re.exec(attrString || "");
    }
    return attrs;
  }

  /** Every `<tagName ...>...</tagName>` or self-closing `<tagName .../>` at the TOP level of `xml` -
   *  fine for OOXML's flat structure as long as callers only ever look one level down at a time
   *  (rows inside sheetData, cells inside a row, `is`/`t` inside a cell - none of which nest).
   *
   *  The attribute group MUST be lazy (`*?`), not greedy: real Excel writes an empty cell as a
   *  self-closing `<c r="D3" t="inlineStr" />` (note the space before `/>`), and a greedy `[^>]*`
   *  has no way to tell that trailing `/` apart from an ordinary attribute character - it swallows
   *  it, so `/>` never matches and the "self-closing" tag is read as open, consuming every cell up
   *  to the next `</c>` it can find and shifting an entire row's columns sideways. A lazy group
   *  expands one character at a time and stops the moment `/>` matches, which is exactly the point
   *  right before that slash - found by an openpyxl-written round trip, not by inspection. */
  function matchTags(xml, tagName) {
    var results = [];
    var re = new RegExp("<" + tagName + "(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</" + tagName + ">)", "gu");
    var match = re.exec(xml);
    while (match !== null) {
      results.push({ attrs: parseAttrs(match[1]), inner: match[2] || "" });
      match = re.exec(xml);
    }
    return results;
  }

  // `t` (and `v`, when it holds text rather than a bare number/boolean flag) are the only leaf text
  // nodes this reader ever descends into - unescaped exactly once, here, rather than inside
  // `matchTags` itself, which also returns markup (an `<is>`'s own inner XML, say) that must not be
  // entity-decoded a second time.
  function parseSharedStrings(xmlText) {
    if (!xmlText) return [];
    return matchTags(xmlText, "si").map(function (siTag) {
      return matchTags(siTag.inner, "t").map(function (t) { return xmlUnescape(t.inner); }).join("");
    });
  }

  function cellText(cell, sharedStrings) {
    if (cell.attrs.t === "s") {
      var shared = matchTags(cell.inner, "v")[0];
      var index = shared ? Number(shared.inner) : NaN;
      return Number.isNaN(index) ? "" : (sharedStrings[index] || "");
    }
    if (cell.attrs.t === "inlineStr") {
      var isTag = matchTags(cell.inner, "is")[0];
      var tTag = isTag ? matchTags(isTag.inner, "t")[0] : null;
      return tTag ? xmlUnescape(tTag.inner) : "";
    }
    if (cell.attrs.t === "b") {
      var boolValue = matchTags(cell.inner, "v")[0];
      return boolValue ? boolValue.inner === "1" : false;
    }
    var plain = matchTags(cell.inner, "v")[0];
    return plain ? plain.inner : "";
  }

  /** The worksheet as an array of rows, each an array of cell values in column order - gaps for a
   *  skipped column are left `undefined`, resolved from each cell's own `r="B2"` reference so a
   *  reordered or sparse row still lands in the right place. */
  function parseWorksheetTable(sheetXmlText, sharedStrings) {
    var sheetData = matchTags(sheetXmlText, "sheetData")[0];
    var rows = sheetData ? matchTags(sheetData.inner, "row") : [];
    return rows.map(function (rowTag) {
      var line = [];
      matchTags(rowTag.inner, "c").forEach(function (cellTag) {
        var index = cellTag.attrs.r ? columnIndexOf(cellTag.attrs.r) : line.length;
        line[index] = cellText(cellTag, sharedStrings);
      });
      return line;
    });
  }

  /** The workbook names its first sheet only by a relationship id; the actual part it points at
   *  (almost always `worksheets/sheet1.xml`, but never assumed) is resolved through
   *  `xl/_rels/workbook.xml.rels` the way a real reader has to. */
  function resolveFirstSheetPath(workbookXmlText, relsXmlText) {
    var sheetTag = matchTags(workbookXmlText, "sheet")[0];
    if (!sheetTag) return null;
    var relId = sheetTag.attrs["r:id"];
    var relationship = matchTags(relsXmlText || "", "Relationship").filter(function (rel) {
      return rel.attrs.Id === relId;
    })[0];
    if (!relationship) return null;
    return "xl/" + relationship.attrs.Target.replace(/^\/?xl\//u, "");
  }

  // --- The rule's own columns, and the sheet built/read from them ----------------------------------

  /** The rule's own fields, one column per fixed condition slot - "de structuur die ook zichtbaar is
   *  in de app" (asked for): this mirrors the table on screen exactly, now that conditions are two
   *  fixed slots again rather than a variable number needing a capped column count. */
  function xlsxColumns() {
    return [
      { key: "ID", label: "ID" },
      { key: "requestType", label: "CR Type" },
      { key: "step", label: "Step" },
      { key: "conditionField", label: "Condition 1 Field" },
      { key: "conditionOperator", label: "Condition 1 Operator" },
      { key: "conditionValues", label: "Condition 1 Value" },
      { key: "conditionLogic", label: "Logic" },
      { key: "conditionField2", label: "Condition 2 Field" },
      { key: "conditionOperator2", label: "Condition 2 Operator" },
      { key: "conditionValues2", label: "Condition 2 Value" },
      { key: "approvers", label: "Approvers" },
      { key: "isActive", label: "Active" }
    ];
  }

  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
    + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
    + '<fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '</cellXfs></styleSheet>';

  var CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>';

  var RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';

  var WORKBOOK_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="WorkflowRules" sheetId="1" r:id="rId1"/></sheets></workbook>';

  var WORKBOOK_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';

  /** Row 1 is the header, bold (style 1) and frozen (`pane ySplit="1"`) - BRF+'s own exports do the
   *  same, and it is what makes re-importing a reordered or trimmed copy possible: the header row is
   *  what `_applyImportedXlsx` matches on, never a fixed column position. */
  function sheetXml(columns, rows) {
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    parts.push('<sheetViews><sheetView workbookViewId="0">'
      + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      + '</sheetView></sheetViews>');
    parts.push("<cols>" + columns.map(function (_, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="20" customWidth="1"/>';
    }).join("") + "</cols>");
    parts.push("<sheetData>");
    parts.push('<row r="1">' + columns.map(function (column, i) {
      return '<c r="' + columnLetters(i) + '1" t="inlineStr" s="1"><is><t>' + xmlEscape(column.label) + "</t></is></c>";
    }).join("") + "</row>");
    rows.forEach(function (row, rowIndex) {
      var r = rowIndex + 2;
      parts.push('<row r="' + r + '">' + columns.map(function (column, i) {
        var ref = columnLetters(i) + r;
        var value = row[column.key];
        if (typeof value === "boolean") return '<c r="' + ref + '" t="b"><v>' + (value ? 1 : 0) + "</v></c>";
        return '<c r="' + ref + '" t="inlineStr"><is><t>' + xmlEscape(value) + "</t></is></c>";
      }).join("") + "</row>");
    });
    parts.push("</sheetData></worksheet>");
    return parts.join("");
  }

  /** Builds the .xlsx bytes for the current rules, one row per rule in the same shape `xlsxColumns`
   *  names - store-only ZIP, so this needs no async decompression step the way reading does. */
  function buildWorkflowRulesXlsx(rows) {
    var sheet = sheetXml(xlsxColumns(), rows);
    return zipStore([
      { name: "[Content_Types].xml", data: utf8Bytes(CONTENT_TYPES_XML) },
      { name: "_rels/.rels", data: utf8Bytes(RELS_XML) },
      { name: "xl/workbook.xml", data: utf8Bytes(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: utf8Bytes(WORKBOOK_RELS_XML) },
      { name: "xl/styles.xml", data: utf8Bytes(STYLES_XML) },
      { name: "xl/worksheets/sheet1.xml", data: utf8Bytes(sheet) }
    ]);
  }

  /** The reverse of `buildWorkflowRulesXlsx`, tolerant of a file Excel itself re-saved: DEFLATE
   *  entries, shared strings, and a first sheet resolved through the workbook's own relationships
   *  rather than assumed to be `sheet1.xml` by name. Returns the worksheet as an array of rows
   *  (row 0 is the header), the same shape `_applyImportedXlsx` reads. */
  async function readWorkflowRulesXlsx(bytes) {
    var entries = readCentralDirectory(bytes);
    var byName = {};
    entries.forEach(function (entry) { byName[entry.name] = entry; });
    var decoder = new TextDecoder("utf-8");

    async function textOf(name) {
      var entry = byName[name];
      if (!entry) return null;
      return decoder.decode(await extractZipEntry(bytes, entry));
    }

    var workbookXml = await textOf("xl/workbook.xml");
    if (!workbookXml) throw new Error("This does not look like a .xlsx file (no xl/workbook.xml inside it).");
    var relsXml = await textOf("xl/_rels/workbook.xml.rels");
    var sheetPath = resolveFirstSheetPath(workbookXml, relsXml);
    if (!sheetPath) throw new Error("Could not find this workbook's first worksheet.");

    var sharedStrings = parseSharedStrings(await textOf("xl/sharedStrings.xml"));
    var sheetXmlText = await textOf(sheetPath);
    if (!sheetXmlText) throw new Error("Could not read this workbook's first worksheet.");
    return parseWorksheetTable(sheetXmlText, sharedStrings);
  }

  /** Tolerant on purpose: a business user typing quickly in Excel writes "yes"/"Yes"/"TRUE"/"1"/"x"
   *  as often as the literal word, and a strict match would silently read every one of those as
   *  inactive. An already-boolean cell (Excel wrote `t="b"`, or our own export did) passes through. */
  function isTruthyCell(value) {
    if (typeof value === "boolean") return value;
    return /^(true|1|yes|x)$/iu.test(String(value === undefined ? "" : value).trim());
  }

  // Who approves what. Same page shape as the other three rule tables, because a steward should not
  // have to learn two: one value per cell, a field value help on the conditions and a role value
  // help on the approver. Several approvers means several rows.
  return Controller.extend("mdm.md.mdmrules.manage.ext.controller.WorkflowRuleList", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        busy: false,
        dirty: false,
        skipped: 0,
        skippedText: ""
      }), "view");
      this._router = UIComponent.getRouterFor(this);
      this._loadOptions();
    },

    onBackToHub: function () {
      if (this._model() && this._model().hasPendingChanges(UPDATE_GROUP)) {
        MessageBox.confirm("Leave without saving? Unsaved rule changes are discarded.", {
          onClose: function (action) {
            if (action === MessageBox.Action.OK) {
              this._model().resetChanges(UPDATE_GROUP);
              this._router.navTo("MDMRuleHub", {}, true);
            }
          }.bind(this)
        });
        return;
      }
      this._router.navTo("MDMRuleHub", {}, true);
    },

    // The component's model, not only the view's: a routed view is not in the control tree yet during
    // onInit, which is what left the duplicate page's dropdowns empty the first time round.
    _model: function () {
      var component = this.getOwnerComponent();
      return this.getView().getModel("dc") || (component && component.getModel("dc"));
    },

    _table: function () {
      return this.byId("ruleTable");
    },

    /** Payload fields from the staging model, the CR types and the steps from the engine. */
    _loadOptions: async function () {
      try {
        var options = await this._callAction("workflowRuleOptions", {});
        this.getView().setModel(new JSONModel(options || {}), "opt");
        this._reportSkipped(options);
        if (!options || !options.fields || !options.fields.length) {
          MessageBox.error("The field catalog came back empty, so no condition can be written. "
            + "The staging model could not be read.");
        }
      } catch (error) {
        MessageBox.error("The rule options could not be loaded: " + this._errorText(error));
      }
    },

    // A saved rule that would not run looks configured and does nothing, so the runnable count from
    // the service is compared against what is stored.
    _reportSkipped: function (options) {
      var view = this.getView().getModel("view");
      var runnable = options && options.ruleCount;
      var binding = this._table() && this._table().getBinding("items");
      var stored = binding ? binding.getLength() : 0;
      var skipped = (typeof runnable === "number" && stored > runnable) ? stored - runnable : 0;
      view.setProperty("/skipped", skipped);
      view.setProperty("/skippedText", skipped
        ? skipped + " of the " + stored + " saved rules are not running, because they are inactive or "
          + "incomplete. Those requests are routed as if the table said nothing about them."
        : "");
    },

    onAddRule: function () {
      var binding = this._table().getBinding("items");
      if (!binding) return;
      // The step is the only honest default: there is one, and it is what every row is for today.
      // Request type and approvers are left empty - a row arriving pre-pointed at a CR type would be
      // a routing rule nobody wrote.
      binding.create({
        step: "Approve",
        approvers: "",
        conditionLogic: "AND",
        isActive: true
      });
      this._markDirty();
    },

    onDeleteRule: function () {
      var item = this._table().getSelectedItem();
      if (!item) {
        MessageToast.show("Select the rule to delete.");
        return;
      }
      var context = item.getBindingContext("dc");
      if (!context) return;
      MessageBox.confirm("Delete this rule?", {
        onClose: function (action) {
          if (action !== MessageBox.Action.OK) return;
          context.delete(UPDATE_GROUP);
          this._markDirty();
        }.bind(this)
      });
    },

    /**
     * "Copy and paste" for a rule: the same fields as Add Rule, pre-filled from the selected row
     * rather than blank. Simpler again since the revert to two fixed condition slots (2026-08-31) -
     * every field, condition slots included, is a plain scalar on the rule itself now, so one
     * `binding.create(copy)` is the whole job; there is no child composition left to copy row by row.
     */
    onDuplicateRule: function () {
      var item = this._table().getSelectedItem();
      if (!item) {
        MessageToast.show("Select the rule to duplicate.");
        return;
      }
      var context = item.getBindingContext("dc");
      var binding = this._table().getBinding("items");
      if (!context || !binding) return;
      var copy = Object.assign({}, context.getObject());
      STRIP_ON_COPY.forEach(function (key) { delete copy[key]; });
      binding.create(copy);
      this._markDirty();
    },

    onCellChange: function () {
      this._markDirty();
    },

    _markDirty: function () {
      this.getView().getModel("view").setProperty("/dirty", true);
    },

    // --- Excel import / export - a real .xlsx (2026-08-31) -----------------------------------------
    //
    // Reverted from CSV the same day conditions reverted to two fixed slots: "op basis van al die
    // fixed velden ... de .xlsx file" (based on those fixed fields, make it a real .xlsx), modelled on
    // how BRF+'s own decision-table Excel up/download works - a plain header-row-driven worksheet, one
    // row per rule, no packed cells. See the zip/OOXML helpers above this controller for how the file
    // itself is built and read without a third-party spreadsheet library.

    /** Every row on the page, in the same shape Save already reads them in. */
    onExportExcel: function () {
      var rows = this._draftRules();
      if (!rows.length) {
        MessageToast.show("There is nothing to export yet.");
        return;
      }
      var bytes = buildWorkflowRulesXlsx(rows);
      var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "workflow-agent-determination.xlsx";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    },

    /** A hidden native file input, reused across presses rather than rebuilt each time. */
    onImportExcel: function () {
      if (!this._importInput) {
        this._importInput = document.createElement("input");
        this._importInput.type = "file";
        this._importInput.accept = ".xlsx";
        this._importInput.style.display = "none";
        this._importInput.addEventListener("change", this._onImportFileChosen.bind(this));
        document.body.appendChild(this._importInput);
      }
      // Cleared before opening, so re-importing the very same file still fires "change".
      this._importInput.value = "";
      this._importInput.click();
    },

    /** Reading a real workbook is async (DEFLATE decompression is a stream), unlike the plain-text
     *  CSV reader this replaced - `FileReader` is swapped for `File.arrayBuffer()` accordingly. */
    _onImportFileChosen: function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      var that = this;
      file.arrayBuffer().then(function (buffer) {
        return readWorkflowRulesXlsx(new Uint8Array(buffer));
      }).then(function (table) {
        that._applyImportedXlsx(table);
      }).catch(function (error) {
        MessageBox.error("This file could not be read as an Excel workbook: " + (error && error.message ? error.message : error));
      });
    },

    /**
     * Every row becomes either an update to an already-loaded rule (its ID column matches one on
     * screen) or a new one (blank or unrecognised ID) - so a steward can export, append new rows in
     * the same spreadsheet, and re-import the whole thing in one go. Nothing is saved here: like Add
     * Rule, this only populates the (now dirty) table, so the existing Save/Discard flow - and its
     * validation - still has the last word.
     *
     * Matched by HEADER LABEL, not by fixed column position - the same BRF+-style tolerance for a
     * reordered or trimmed copy that the frozen header row exists to make possible. A file missing
     * the "CR Type" column is refused outright: it does not look like this table's own export.
     */
    _applyImportedXlsx: function (table) {
      if (!table.length) {
        MessageBox.error("The file has no rows.");
        return;
      }
      var header = table[0].map(function (label) { return String(label === undefined ? "" : label).trim(); });
      var columns = xlsxColumns();
      var indexOfKey = {};
      columns.forEach(function (column) {
        var index = header.indexOf(column.label);
        if (index !== -1) indexOfKey[column.key] = index;
      });
      if (indexOfKey.requestType === undefined || indexOfKey.approvers === undefined) {
        MessageBox.error("This file's header row does not match the Workflow Agent Determination "
          + "export format. Export the current rules first and edit that file.");
        return;
      }

      var binding = this._table().getBinding("items");
      if (!binding) return;
      var byId = {};
      binding.getCurrentContexts().forEach(function (context) {
        var object = context.getObject();
        if (object && object.ID) byId[object.ID] = context;
      });

      var created = 0;
      var updated = 0;
      var skipped = 0;
      table.slice(1).forEach(function (row) {
        var isBlank = !row || row.every(function (cell) { return cell === undefined || cell === ""; });
        if (isBlank) return;
        var record = {};
        columns.forEach(function (column) {
          if (column.key === "ID") return;
          var index = indexOfKey[column.key];
          if (index === undefined) return;
          var value = row[index];
          record[column.key] = column.key === "isActive" ? isTruthyCell(value) : (value === undefined ? "" : value);
        });
        var idIndex = indexOfKey.ID;
        var id = idIndex !== undefined ? row[idIndex] : undefined;
        var existing = id && byId[id];
        if (existing) {
          Object.keys(record).forEach(function (key) { existing.setProperty(key, record[key]); });
          updated += 1;
        } else if (record.requestType || record.approvers) {
          binding.create(record);
          created += 1;
        } else {
          skipped += 1;
        }
      });
      this._markDirty();
      MessageToast.show(
        created + " rule(s) added, " + updated + " updated"
        + (skipped ? ", " + skipped + " blank row(s) skipped" : "")
        + ". Review and press Save."
      );
    },

    // --- The role value help -----------------------------------------------

    /**
     * The approver half of the cell. Typing an address is the other half and needs no dialog; a
     * role has to be spelled exactly as SBPA knows it, so it is picked rather than remembered - and
     * so is a user, since nobody should have to know how a colleague's e-mail is written.
     *
     * One entry, because the cell holds one approver: several approvers are several rows, which is
     * what the Add button is for and what the engine merges.
     */
    onRoleValueHelp: async function (event) {
      var input = event.getSource();
      var binding = input.getBinding("value");
      this._roleTarget = {
        context: input.getBindingContext("dc"),
        path: binding && binding.getPath()
      };
      if (!this._roleTarget.context || !this._roleTarget.path) return;
      if (!this._roleHelp) {
        this._roleFragmentId = this.getView().getId() + "-roles";
        this._roleHelp = await Fragment.load({
          id: this._roleFragmentId,
          name: "mdm.md.mdmrules.manage.ext.fragment.RoleValueHelp",
          controller: this
        });
        this.getView().addDependent(this._roleHelp);
      }
      // Cleared on the way IN, never on the way out - the same rule the field value help follows,
      // and for the same reason: resetting a filtered list re-templates its rows.
      var items = this._roleTable().getBinding("items");
      if (items) items.filter([]);
      this._roleHelp.open();
    },

    // A real Table, not a SelectDialog, so Type and Name/E-mail render as genuine columns - see the
    // fragment. Looked up by local id rather than kept as a field, the same way _table() looks up
    // the main table: the fragment owns its own control tree.
    _roleTable: function () {
      return Fragment.byId(this._roleFragmentId, "agentTable");
    },

    onRoleSearch: function (event) {
      // A plain sap.m.SearchField, unlike SelectDialog's own re-exposed search/liveChange, names its
      // parameter "newValue" on liveChange and "query" on search (Enter or the icon) - neither is
      // "value", which only ever existed on SelectDialog's own events.
      var query = event.getParameter("newValue") || event.getParameter("query") || "";
      var items = this._roleTable().getBinding("items");
      if (!items) return;
      items.filter(query ? new Filter({
        filters: [
          new Filter("value", FilterOperator.Contains, query),
          new Filter("type", FilterOperator.Contains, query)
        ],
        and: false
      }) : []);
    },

    // The value is read off its binding context before anything touches the list, for the reason
    // the field value help spells out - a reset re-binds the items to different rows.
    // (Written without naming that handler and a colon: these tests find a method by that exact
    // string, so a comment carrying it sends the slice to the wrong function.)
    onRolesChosen: function (event) {
      var listItem = event.getParameter("listItem");
      var context = listItem && listItem.getBindingContext("opt");
      var value = context && context.getProperty("value");
      if (value && this._roleTarget) {
        this._roleTarget.context.setProperty(this._roleTarget.path, value);
        this._markDirty();
      }
      this._roleHelp.close();
    },

    onRoleValueHelpCancel: function () {
      this._roleHelp.close();
    },

    // --- The field value help ----------------------------------------------

    // Opened from a condition's own Field cell. The cell is identified by its own binding rather than
    // custom data: `getBinding("value").getPath()` already knows what it writes - one bound Input per
    // condition again, the same as before conditions became a column of stacked text.
    onFieldValueHelp: async function (event) {
      var input = event.getSource();
      var binding = input.getBinding("value");
      this._target = {
        context: input.getBindingContext("dc"),
        path: binding && binding.getPath()
      };
      if (!this._target.context || !this._target.path) return;
      if (!this._valueHelp) {
        this._valueHelp = await Fragment.load({
          id: this.getView().getId(),
          name: "mdm.md.mdmrules.manage.ext.fragment.FieldValueHelp",
          controller: this
        });
        this.getView().addDependent(this._valueHelp);
      }
      // Cleared on the way IN, never on the way out: the dialog is shared, and clearing it while a
      // selection is still being read is what made the wrong field land (see onFieldChosen).
      var items = this._valueHelp.getBinding("items");
      if (items) items.filter([]);
      this._valueHelp.open("");
    },

    /** `contains` over both the label and the qualified name, so "Country" and "Addresses." work. */
    onFieldSearch: function (event) {
      var query = event.getParameter("value") || event.getParameter("newValue") || "";
      var items = event.getSource().getBinding("items");
      if (!items) return;
      items.filter(query ? new Filter({
        filters: [
          new Filter("text", FilterOperator.Contains, query),
          new Filter("code", FilterOperator.Contains, query)
        ],
        and: false
      }) : []);
    },

    // Read off the binding context, BEFORE anything touches the list. Clearing the filter first
    // re-templates the rows and re-binds the item to whatever now sits at its old position, which is
    // why searching "Country" used to write a General name field. The filter is reset on open instead.
    onFieldChosen: function (event) {
      var selected = event.getParameter("selectedItem");
      var context = selected && selected.getBindingContext("opt");
      // The qualified code is what is stored - the label is for reading, and storing it would make
      // a rule that no longer resolves the moment a label is reworded.
      var code = context && context.getProperty("code");
      if (!code || !this._target) return;
      this._target.context.setProperty(this._target.path, code);
      this._markDirty();
    },

    // --- Save --------------------------------------------------------------

    // The same checks the service makes, so a steward is told at the keyboard rather than by a
    // rejected batch. The service still validates: this is a courtesy, not the guard.
    _localProblems: function (rows) {
      var problems = [];
      rows.forEach(function (rule, index) {
        var label = "Row " + (index + 1) + ": ";
        if (!rule.requestType) problems.push(label + "choose the CR type this rule applies to.");
        if (!rule.step) problems.push(label + "choose the step.");
        // A step with nobody on it is the row that looks configured and stops a request dead.
        if (!rule.approvers) {
          problems.push(label + "name the approver — an e-mail address or a role.");
        }
        // Half a condition is the dangerous half: a field with no values would match everything -
        // unless the operator is one of the two that need no value at all ("is empty"/"is not
        // empty"). The two fixed slots also validate server-side (validateCondition, through
        // validateWorkflowRule); this is the same check done at the keyboard.
        [
          { field: "conditionField", operator: "conditionOperator", values: "conditionValues", name: "condition 1" },
          { field: "conditionField2", operator: "conditionOperator2", values: "conditionValues2", name: "condition 2" }
        ].forEach(function (slot) {
          var field = rule[slot.field];
          var values = rule[slot.values];
          var needsValue = rule[slot.operator] !== "empty" && rule[slot.operator] !== "notEmpty";
          if (field && needsValue && !values) problems.push(label + slot.name + " needs a value.");
          if (!field && values) problems.push(label + slot.name + " needs a field.");
        });
      });
      return problems;
    },

    // Rows the page is still holding on its own. `isTransient` is guarded because a persisted
    // context does not always carry it, depending on how the row got here.
    _transientRows: function () {
      var binding = this._table() && this._table().getBinding("items");
      if (!binding) return [];
      return (binding.getCurrentContexts() || []).filter(function (context) {
        return context && context.isTransient && context.isTransient();
      });
    },

    _draftRules: function () {
      var binding = this._table().getBinding("items");
      if (!binding) return [];
      return binding.getCurrentContexts().map(function (context) {
        var row = Object.assign({}, context.getObject());
        delete row["@odata.etag"];
        return row;
      });
    },

    onSave: async function () {
      var view = this.getView().getModel("view");
      var problems = this._localProblems(this._draftRules());
      if (problems.length) {
        MessageBox.error(problems.join("\n"));
        return;
      }
      view.setProperty("/busy", true);
      try {
        await this._model().submitBatch(UPDATE_GROUP);
        // A rejected row leaves its change pending rather than silently vanishing.
        if (this._model().hasPendingChanges(UPDATE_GROUP)) {
          MessageBox.error("The service rejected at least one rule. Check the messages and correct the row.");
          return;
        }
        // `hasPendingChanges` answers for ONE update group, so it cannot see a create that never
        // travelled - a row added outside this group would leave it false and the toast would claim
        // a save that never happened, which is indistinguishable from a rule clearing itself. So the
        // rows are asked directly: a context still transient after a submit was never written.
        var unsaved = this._transientRows();
        if (unsaved.length) {
          MessageBox.error(unsaved.length + " rule(s) were not saved: the service accepted nothing "
            + "for them and they are still local to this page. Reload before trying again — "
            + "leaving now loses them.");
          return;
        }
        view.setProperty("/dirty", false);
        // Re-read: what is running has changed, and the banner has to stop claiming otherwise.
        await this._loadOptions();
        MessageToast.show("Workflow rules saved.");
      } catch (error) {
        MessageBox.error("The rules could not be saved: " + this._errorText(error));
      } finally {
        view.setProperty("/busy", false);
      }
    },

    onDiscard: function () {
      this._model().resetChanges(UPDATE_GROUP);
      this.getView().getModel("view").setProperty("/dirty", false);
    },

    _callAction: async function (name, parameters) {
      var model = this._model();
      if (!model) throw new Error("The rule configuration service is not bound to this page.");
      var binding = model.bindContext("/" + name + "(...)");
      Object.keys(parameters).forEach(function (parameter) {
        binding.setParameter(parameter, parameters[parameter]);
      });
      await binding.execute("$direct");
      var context = binding.getBoundContext();
      var result = context ? context.getObject() : null;
      binding.destroy();
      // A function returning a primitive comes back wrapped in a `value` property.
      return result && result.value !== undefined ? result.value : result;
    },

    _errorText: function (error) {
      return (error && (error.message || error.toString())) || "unknown error";
    }
  });
});
