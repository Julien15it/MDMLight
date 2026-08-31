'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

/**
 * `XlsxCodec.js` (`app/mdmrules/webapp/ext/util/XlsxCodec.js`) is the hand-rolled ZIP/OOXML reader
 * and writer shared by all four rule pages' Export/Import to Excel (WorkflowRuleList first,
 * 2026-08-31, then DuplicateRuleList/ValidationRuleList/DerivationRuleList the same day). There is
 * exactly one copy of this code now, so there is exactly one place these tests need to load it from.
 *
 * Loaded via `new Function`, NOT `vm.createContext`/`runInContext`: a `vm` context is a genuinely
 * separate JS realm, so an array or object the module RETURNS (readWorkbook's rows, say) has a
 * foreign `Array.prototype` from this file's own point of view - `assert.deepEqual` then fails with
 * "same structure but are not reference-equal" even though the values are identical, found writing
 * this test, not assumed. `new Function` runs in the SAME realm as this file (it only creates a new
 * function, not a new global object), which sidesteps the whole problem and needs no browser globals
 * (`TextEncoder`, `DecompressionStream`, ...) injected by hand either - they are already the real,
 * ambient ones Node provides.
 */
const CODEC_PATH = path.join(
  __dirname, '..', 'app', 'mdmrules', 'webapp', 'ext', 'util', 'XlsxCodec.js'
);
const source = fs.readFileSync(CODEC_PATH, 'utf8');

function loadXlsxCodec() {
  const wrapped = source
    .replace(/^sap\.ui\.define\(\[\], function \(\) \{/u, 'return (function () {')
    .replace(/\}\);\s*$/u, '})();');
  // eslint-disable-next-line no-new-func
  return new Function(wrapped)();
}

const xlsx = loadXlsxCodec();

test('the codec is a real sap.ui.define AMD module with no dependencies of its own', () => {
  assert.match(source, /^sap\.ui\.define\(\[\], function \(\) \{/u);
  assert.equal(typeof xlsx.buildWorkbook, 'function');
  assert.equal(typeof xlsx.readWorkbook, 'function');
  assert.equal(typeof xlsx.isTruthyCell, 'function');
});

// No third-party spreadsheet library anywhere in the codec - the ZIP/OOXML/DEFLATE handling is
// entirely hand-rolled.
test('no spreadsheet library dependency', () => {
  assert.equal(/require\(["'](xlsx|exceljs|jszip|pako)["']/iu.test(source), false);
  assert.equal(/sap\/ui\/export\/Spreadsheet/u.test(source), false);
  // DEFLATE decompression on import is a browser built-in, not a bundled inflate implementation.
  assert.match(source, /new DecompressionStream\("deflate-raw"\)/u);
});

// The ZIP format's own checksum - a standard check value, so a subtly wrong polynomial or a
// reversed bit order is caught immediately rather than only once a file fails to open.
test('crc32 matches the standard CRC-32 check values', () => {
  assert.equal(xlsx.crc32(new TextEncoder().encode('')), 0);
  assert.equal(xlsx.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('columnLetters/columnIndexOf round-trip through the double-letter boundary', () => {
  assert.equal(xlsx.columnLetters(0), 'A');
  assert.equal(xlsx.columnLetters(25), 'Z');
  assert.equal(xlsx.columnLetters(26), 'AA');
  assert.equal(xlsx.columnIndexOf('AA7'), 26);
  assert.equal(xlsx.columnIndexOf('B12'), 1);
});

const COLUMNS = [
  { key: 'ID', label: 'ID' },
  { key: 'field', label: 'Field' },
  { key: 'isActive', label: 'Active' }
];

test('a rule with every field filled in round-trips through build and read', async () => {
  const rows = [{ ID: '1', field: 'Name', isActive: true }];
  const bytes = xlsx.buildWorkbook('TestRules', COLUMNS, rows);
  const table = await xlsx.readWorkbook(bytes);
  assert.deepEqual(table[0], ['ID', 'Field', 'Active']);
  assert.deepEqual(table[1], ['1', 'Name', true]);
});

// Entity-escaped characters in a value - a comma, a quote, an ampersand, angle brackets - must come
// back exactly as typed, not still XML-escaped.
test('special characters in a value survive the round trip unescaped', async () => {
  const rows = [{ ID: '2', field: 'Acme, "big" corp <x@y.com> & Co', isActive: false }];
  const bytes = xlsx.buildWorkbook('TestRules', COLUMNS, rows);
  const table = await xlsx.readWorkbook(bytes);
  assert.equal(table[1][1], 'Acme, "big" corp <x@y.com> & Co');
  assert.equal(table[1][2], false);
});

// The one worksheet is named after its own table, so an exported file is recognisable once opened
// in Excel rather than always reading "Sheet1".
test('buildWorkbook names its one worksheet after the given sheetName', async () => {
  const bytes = xlsx.buildWorkbook('MyRuleTable', COLUMNS, []);
  const entries = xlsx.readCentralDirectory(bytes);
  const workbookEntry = entries.find((entry) => entry.name === 'xl/workbook.xml');
  const workbookXml = new TextDecoder().decode(await xlsx.extractZipEntry(bytes, workbookEntry));
  assert.match(workbookXml, /<sheet name="MyRuleTable"/u);
});

/**
 * The regression this whole reading path was rewritten around: real Excel (and any conforming
 * writer - openpyxl reproduced it in a live round trip while writing this) represents an EMPTY
 * inlineStr cell as a self-closing tag WITH A SPACE before the slash: `<c r="D3" t="inlineStr" />`.
 * A naive "greedy attributes, then look for `/>`" regex reads that trailing `/` as part of the
 * attribute string, so `/>` never matches, the tag reads as OPEN, and everything up to the next
 * `</c>` it can find - typically the FOLLOWING cell's own closing tag - is swallowed as this cell's
 * content. Every column after the empty one then lands one position too far left for the rest of
 * the row. Fixed by making the attribute group lazy so it stops expanding the moment `/>` matches.
 */
test('a self-closing empty cell does not shift the columns after it', () => {
  const sheetXmlText = '<?xml version="1.0"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>ID</t></is></c>'
    + '<c r="B1" t="inlineStr"><is><t>Field</t></is></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>1</t></is></c>'
    + '<c r="B2" t="inlineStr" />'
    + '<c r="C2" t="inlineStr"><is><t>Active</t></is></c></row>'
    + '</sheetData></worksheet>';
  const table = xlsx.parseWorksheetTable(sheetXmlText, []);
  assert.deepEqual(table[0], ['ID', 'Field']);
  assert.deepEqual(table[1], ['1', '', 'Active']);
});

test('isTruthyCell is tolerant of how a business user writes "yes" in Excel', () => {
  assert.equal(xlsx.isTruthyCell(true), true);
  assert.equal(xlsx.isTruthyCell(false), false);
  for (const truthy of ['true', 'TRUE', '1', 'yes', 'Yes', 'x', 'X', ' x ']) {
    assert.equal(xlsx.isTruthyCell(truthy), true, `"${truthy}" reads as active`);
  }
  for (const falsy of ['', 'no', 'false', '0', undefined]) {
    assert.equal(xlsx.isTruthyCell(falsy), false, `"${falsy}" reads as inactive`);
  }
});

/**
 * The container-level round trip, independent of the worksheet's own XML: build a ZIP with
 * `zipStore` (what export writes - STORE only), then read it back through
 * `readCentralDirectory`/`extractZipEntry` (what import reads).
 */
test('zipStore/readCentralDirectory/extractZipEntry round-trip a STORE-only archive', async () => {
  const files = [
    { name: 'a.txt', data: new TextEncoder().encode('hello world') },
    { name: 'dir/b.txt', data: new TextEncoder().encode('') }
  ];
  const bytes = xlsx.zipStore(files);
  const entries = xlsx.readCentralDirectory(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'dir/b.txt']);
  assert.deepEqual([...entries.map((entry) => entry.method)], [0, 0]);
  const first = await xlsx.extractZipEntry(bytes, entries[0]);
  assert.equal(new TextDecoder().decode(first), 'hello world');
  const second = await xlsx.extractZipEntry(bytes, entries[1]);
  assert.equal(second.length, 0);
});

/**
 * Real Excel always DEFLATEs on save, which export never does but import has to read - proven with
 * Node's own `zlib.deflateRawSync` standing in for "whatever Excel's own compressor produced",
 * decompressed here through the identical `DecompressionStream('deflate-raw')` the codec uses.
 */
test('extractZipEntry decompresses a DEFLATE (method 8) entry via DecompressionStream', async () => {
  const uncompressed = Buffer.from('a value only real Excel would have compressed this way');
  const compressed = zlib.deflateRawSync(uncompressed);
  const entry = { name: 'xl/worksheets/sheet1.xml', method: 8, compressedSize: compressed.length, localHeaderOffset: 0 };
  const local = Buffer.alloc(30 + 'xl/worksheets/sheet1.xml'.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE('xl/worksheets/sheet1.xml'.length, 26);
  Buffer.from('xl/worksheets/sheet1.xml').copy(local, 30);
  const bytes = new Uint8Array(Buffer.concat([local, compressed]));
  const result = await xlsx.extractZipEntry(bytes, entry);
  assert.equal(new TextDecoder().decode(result), uncompressed.toString());
});

module.exports = { loadXlsxCodec };
