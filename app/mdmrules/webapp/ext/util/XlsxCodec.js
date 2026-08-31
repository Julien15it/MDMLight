sap.ui.define([], function () {
  "use strict";

  // --- A real .xlsx, BRF+-style: header-row-driven fixed columns, one row per rule ------------------
  //
  // Shared by all four rule pages (WorkflowRuleList, DuplicateRuleList, ValidationRuleList,
  // DerivationRuleList) - built for WorkflowRuleList first (2026-08-31, "op basis van al die fixed
  // velden ... ervoor te zorgen dat dit ook de .xlsx file wordt (baseer je op hoe BRF+ dit doet)") and
  // extracted here the same day so the other three pages reuse the identical codec rather than each
  // carrying their own copy - four copies of a hand-rolled ZIP/XML implementation is exactly the kind
  // of surface a bug (see the self-closing-tag fix below) would otherwise have to be fixed on four
  // times over.
  //
  // BRF+'s own decision-table Excel up/download is the model: a plain worksheet with a header row
  // naming each column, one data row per rule, no packed cells or DSL. A real `.xlsx` is a ZIP of
  // SpreadsheetML/OOXML parts; this repo has never taken a dependency on a spreadsheet library, and
  // the format is small enough to hand-roll once inline strings avoid needing `xl/sharedStrings.xml`
  // on WRITE and the ZIP container needs only STORE (uncompressed) entries on write - which
  // sidesteps implementing DEFLATE for export while still producing a file Excel opens natively.
  // READING still has to cope with whatever Excel itself saves, which always compresses with DEFLATE
  // and always rewrites inline strings into `xl/sharedStrings.xml` - so import decompresses via the
  // browser's own `DecompressionStream('deflate-raw')` (a Web Platform built-in, not a bundled
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
  // choice this codec's originally-CSV predecessor already made over adding a dependency - keeps
  // every one of these functions runnable, and testable, outside a browser.

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

  // --- The parts common to any single-sheet workbook this codec builds -----------------------------

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

  /** `sheetName` becomes the one worksheet's own name (the Excel tab label) - each rule page names it
   *  after its own table, so an exported file is recognisable once opened rather than always reading
   *  "Sheet1". */
  function workbookXml(sheetName) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="' + xmlEscape(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
  }

  var WORKBOOK_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';

  /** Row 1 is the header, bold (style 1) and frozen (`pane ySplit="1"`) - BRF+'s own exports do the
   *  same, and it is what makes re-importing a reordered or trimmed copy possible: the header row is
   *  what each page's own import handler matches on, never a fixed column position. */
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

  /** Builds a single-sheet .xlsx from `columns` (`[{ key, label }]`) and `rows` (plain objects keyed
   *  by `column.key`) - store-only ZIP, so this needs no async decompression step the way reading
   *  does. */
  function buildWorkbook(sheetName, columns, rows) {
    var sheet = sheetXml(columns, rows);
    return zipStore([
      { name: "[Content_Types].xml", data: utf8Bytes(CONTENT_TYPES_XML) },
      { name: "_rels/.rels", data: utf8Bytes(RELS_XML) },
      { name: "xl/workbook.xml", data: utf8Bytes(workbookXml(sheetName)) },
      { name: "xl/_rels/workbook.xml.rels", data: utf8Bytes(WORKBOOK_RELS_XML) },
      { name: "xl/styles.xml", data: utf8Bytes(STYLES_XML) },
      { name: "xl/worksheets/sheet1.xml", data: utf8Bytes(sheet) }
    ]);
  }

  /** The reverse of `buildWorkbook`, tolerant of a file Excel itself re-saved: DEFLATE entries,
   *  shared strings, and a first sheet resolved through the workbook's own relationships rather than
   *  assumed to be `sheet1.xml` by name. Returns the worksheet as an array of rows (row 0 is the
   *  header) - the same shape every page's own import handler reads. */
  async function readWorkbook(bytes) {
    var entries = readCentralDirectory(bytes);
    var byName = {};
    entries.forEach(function (entry) { byName[entry.name] = entry; });
    var decoder = new TextDecoder("utf-8");

    async function textOf(name) {
      var entry = byName[name];
      if (!entry) return null;
      return decoder.decode(await extractZipEntry(bytes, entry));
    }

    var workbook = await textOf("xl/workbook.xml");
    if (!workbook) throw new Error("This does not look like a .xlsx file (no xl/workbook.xml inside it).");
    var rels = await textOf("xl/_rels/workbook.xml.rels");
    var sheetPath = resolveFirstSheetPath(workbook, rels);
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

  return {
    buildWorkbook: buildWorkbook,
    readWorkbook: readWorkbook,
    isTruthyCell: isTruthyCell,
    // Exposed for direct, isolated testing of the codec (test/xlsx-codec.test.js) - not used by any
    // page controller, which only ever calls the three functions above.
    crc32: crc32,
    columnLetters: columnLetters,
    columnIndexOf: columnIndexOf,
    zipStore: zipStore,
    readCentralDirectory: readCentralDirectory,
    extractZipEntry: extractZipEntry,
    matchTags: matchTags,
    parseWorksheetTable: parseWorksheetTable
  };
});
