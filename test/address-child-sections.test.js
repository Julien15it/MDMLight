'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const controller = fs.readFileSync(
  path.join(
    ROOT, 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'controller',
    'BusinessPartnerMaintenance.controller.js'
  ),
  'utf8'
);

function extractFunctionSource(name) {
  const labelAt = controller.indexOf('function ' + name);
  const braceStart = controller.indexOf('{', labelAt);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < controller.length; i += 1) {
    if (controller[i] === '{') depth += 1;
    if (controller[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return controller.slice(labelAt, end);
}

function loadHelpers() {
  const source = extractFunctionSource('generateRowKey') + '\n' + extractFunctionSource('addressRowKey')
    + '\nreturn { generateRowKey, addressRowKey };';
  // eslint-disable-next-line no-new-func
  return new Function(source)();
}

const { generateRowKey, addressRowKey } = loadHelpers();

/**
 * Addresses is the one collection section whose own childSections (Email/Phone/Fax/Website/Tax
 * Number) are scoped to ONE specific row rather than shared flat across the whole BP the way
 * Customer/Supplier's children are - see "Address-owned children" in staging.md and
 * maintenance-screen.md. `generateRowKey`/`addressRowKey` are the two halves of that: a live
 * address already has a real AddressID and needs nothing generated; a staged or brand new one
 * carries `__rowKey` instead, until postToS4 backfills a real one.
 */
test('addressRowKey prefers a live AddressID over a generated __rowKey', () => {
  assert.equal(addressRowKey({ AddressID: '4711', __rowKey: 'abc' }), '4711');
  assert.equal(addressRowKey({ __rowKey: 'abc' }), 'abc');
  assert.equal(addressRowKey({}), null);
  assert.equal(addressRowKey(null), null);
});

test('generateRowKey produces a fresh, non-empty value every call', () => {
  const first = generateRowKey();
  const second = generateRowKey();
  assert.equal(typeof first, 'string');
  assert.ok(first.length > 0);
  assert.notEqual(first, second);
});

/**
 * _renderSection is not a pure function (it builds real sap.m.Table/Column/ColumnListItem
 * controls), so - like every other UI-heavy method in this controller - its contract is pinned
 * against the source rather than executed. What matters here: an address-owned child scopes by
 * the row it was opened from (never for a plain top-level section, where scopeKey is null and
 * every existing call site behaves exactly as before), and every index used to address a real
 * row (_openExistingRecord/_confirmDeleteRecord/rowMatches) stays a TRUE index into
 * state.sections[section.id], not a position in the filtered/visible subset.
 */
test('_renderSection scopes an address-owned child by trueIndex, never by filtered position', () => {
  const renderSection = controller.slice(controller.indexOf('_renderSection: function'));
  const body = renderSection.slice(0, renderSection.indexOf('_openNewRecord: function'));

  assert.match(body, /var scopeKey = parentRow \? addressRowKey\(parentRow\) : null;/u);
  assert.match(
    body,
    /var trueIndices = allRecords\s*\.map\(function \(_, index\) \{ return index; \}\)\s*\.filter\(function \(index\) \{ return !scopeKey \|\| allRecords\[index\]\.__addressKey === scopeKey; \}\);/u
  );
  assert.match(body, /var records = trueIndices\.map\(function \(index\) \{ return allRecords\[index\]; \}\);/u);
  // rowMatches is computed over EVERY row (allRecords), not the scoped subset, so rowMatches[trueIndex]
  // always finds the row it belongs to.
  assert.match(body, /matchSectionRows\(\s*allRecords,/u);
  assert.match(body, /trueIndices\.forEach\(function \(trueIndex\)/u);
  assert.match(body, /var record = allRecords\[trueIndex\];/u);
  assert.match(body, /var match = rowMatches\[trueIndex\];/u);
  assert.match(body, /_openExistingRecord\.bind\(this, section, trueIndex, parentRow\)/u);
  assert.match(body, /_confirmDeleteRecord\.bind\(this, section, trueIndex, parentRow\)/u);
  // The Add button carries the scoping forward too, so a brand new child lands under the right address.
  assert.match(body, /_openNewRecord\.bind\(this, section, parentRow\)/u);
});

test('_openNewRecord stamps an address-owned child with its parent, and a new Addresses row with its own key', () => {
  const openNewRecord = controller.slice(controller.indexOf('_openNewRecord: function'));
  const body = openNewRecord.slice(0, openNewRecord.indexOf('_openExistingRecord: function'));

  assert.match(body, /if \(parentRow\) \{/u);
  assert.match(body, /var scopeKey = addressRowKey\(parentRow\);/u);
  assert.match(body, /if \(parentRow\.AddressID\) record\.AddressID = parentRow\.AddressID;/u);
  assert.match(body, /if \(scopeKey\) record\.__addressKey = scopeKey;/u);
  assert.match(
    body,
    /if \(section\.id === "Addresses" && !record\.__rowKey\) record\.__rowKey = generateRowKey\(\);/u
  );
});

/**
 * The Details dialog's own childSections (Customer/Supplier's tax/company/sales-area blocks,
 * plus Addresses' new ones) - only the address-owned ones are scoped, and only they pass a
 * parentRow through to the child's own _renderSection call.
 */
test('a child section is only scoped, and only passed a parentRow, when it is address-owned', () => {
  const openRecordDialog = controller.slice(controller.indexOf('_openRecordDialog: function'));
  const hostedBlock = openRecordDialog.slice(
    openRecordDialog.indexOf('var hosted ='), openRecordDialog.indexOf('this._hostedSectionContainers =')
  );
  assert.match(hostedBlock, /var scoped = ADDRESS_CHILD_SECTIONS\[child\.id\];/u);
  assert.match(hostedBlock, /var scopeKey = scoped \? addressRowKey\(record\) : null;/u);
  assert.match(
    hostedBlock,
    /return \{ section: child, parentRow: scoped \? record : null, container: container \};/u
  );
  assert.match(
    openRecordDialog.slice(openRecordDialog.indexOf('dialog.open()'), openRecordDialog.indexOf('dialog.open()') + 120),
    /entry\.parentRow/u
  );
});
