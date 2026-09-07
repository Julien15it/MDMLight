'use strict';

/**
 * How an address-owned child finds the address it belongs to when the client-side key is missing.
 *
 * The chain is: the client stamps every `Addresses` row with a `__rowKey` and every child with the
 * `__addressKey` it belongs to; `writeStagedNodes` maps one onto the other's real staged row id;
 * `postToS4` backfills the S/4 `AddressID` through it. The client key is the weak link, and every
 * way of losing it lands in the same place.
 *
 * Reported live 2026-09-07 twice (BP 639, then BP 642). The `[stage]` warning that shipped with the
 * first fix answered it: `__addressKey=(absent)` on ALL FIVE child sections, with exactly one known
 * address key - a **UUID**, which `generateRowKey()` (`Date.now().toString(36)` plus random) cannot
 * produce and only `cleanStagedRow`'s `__rowKey = ID` can. So the rows came from a staged RELOAD,
 * where a child is handed back `__addressKey = address_ID || null` - and once a request has staged
 * an unlinked child, null is all it can ever offer again. The link was unrecoverable by resubmitting.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(ROOT, 'srv', 'change-request-service.js'), 'utf8');
const controller = fs.readFileSync(
  path.join(
    ROOT, 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'controller',
    'BusinessPartnerMaintenance.controller.js'
  ),
  'utf8'
);

/** The staging write, so a match cannot come from postToS4's own loop further down. */
const writeStagedNodes = (() => {
  const start = service.indexOf('const writeStagedNodes = async');
  assert.ok(start > -1, 'writeStagedNodes moved');
  return service.slice(start, service.indexOf('/** Upserts the header', start));
})();

test('the fallback turns on exactly one address, and counts rows rather than keys', () => {
  // addressIdByRowKey cannot answer "how many addresses" - an unkeyed row is absent from it.
  assert.match(writeStagedNodes, /const stagedAddressIds = \[\];/u);
  assert.match(writeStagedNodes, /stagedAddressIds\.push\(row\.ID\);/u);
  assert.match(writeStagedNodes, /isAddressChild && stagedAddressIds\.length === 1/u);
  assert.match(writeStagedNodes, /row\.address_ID = stagedAddressIds\[0\];/u);
});

test('the stamped key still wins, and is tried first', () => {
  const stamped = writeStagedNodes.indexOf('addressIdByRowKey[record.__addressKey]');
  const fallback = writeStagedNodes.indexOf('stagedAddressIds.length === 1');
  assert.ok(stamped > -1 && fallback > stamped, 'the real key is checked before the fallback');
});

/**
 * With two addresses, picking one would attach an email to an address nobody chose. Staging the
 * wrong link is worse than refusing to post, so that case keeps the warning and stays unlinked.
 */
test('several addresses fall through to the warning, never to a pick', () => {
  const fallbackAt = writeStagedNodes.indexOf('stagedAddressIds.length === 1');
  const rest = writeStagedNodes.slice(fallbackAt);
  assert.match(rest, /\} else if \(isAddressChild\) \{/u, 'the unlinked branch is still there');
  assert.match(rest, /is not linked to any staged address/u);
  // Nothing indexes stagedAddressIds outside the ===1 branch, so no other row can be chosen.
  assert.equal(
    (writeStagedNodes.match(/stagedAddressIds\[/gu) || []).length, 1,
    'exactly one place reads an address out of the list'
  );
});

/**
 * A row read back FROM S/4 already carries the real AddressID, so it needs no link at all - which
 * is what makes changing or deleting an existing email work even on a request whose staged link was
 * never made. The resolved link still wins: on a create it is the id S/4 just assigned, and the
 * staged column is blank.
 */
test('postToS4 falls back to the AddressID the row already carries', () => {
  const start = service.indexOf('const resolvedAddressId =');
  assert.ok(start > -1);
  const expression = service.slice(start, service.indexOf(';', start));
  assert.match(expression, /addressIdByStagedRow\[data\.address_ID\]/u, 'the link is tried first');
  assert.match(expression, /hasKeyValue\(data\.AddressID\) \? data\.AddressID : null/u);
  assert.ok(
    expression.indexOf('addressIdByStagedRow') < expression.indexOf('hasKeyValue'),
    'the freshly created id takes precedence over the staged one'
  );
});

test('_renderAll passes a section, never the forEach index, as the parent row', () => {
  // forEach hands the callback (element, index, array) - bound as the second argument, the index
  // landed in _renderSection's `parentRow`, where a row object belongs.
  assert.doesNotMatch(
    controller, /\.forEach\(this\._renderSection\.bind\(this\)\)/u,
    'the bound-callback form is gone'
  );
  assert.match(
    controller, /\.forEach\(function \(section\) \{ this\._renderSection\(section\); \}, this\);/u
  );
});

/**
 * A draft's address-owned child had no `__addressKey` for the same reason its address had no
 * `__rowKey`. Worse than unlinked at submit: `_renderSection` scopes an address's child table BY
 * `__addressKey`, so the row was invisible in the very dialog it would have to be fixed in.
 */
test('an assistant draft stamps its address-owned children, in a second pass', () => {
  const start = controller.indexOf('var draftSections = draft.sections || {};');
  assert.ok(start > -1);
  const block = controller.slice(start, controller.indexOf('this.getView().getModel("maintenance").refresh(true);', start));

  // The second pass runs AFTER every section is applied - the draft lists them in any order, so the
  // address may not have had its own key when its children were mapped.
  assert.ok(
    block.indexOf('staged.__rowKey = generateRowKey()') < block.indexOf('draftAddresses.length === 1'),
    'the addresses are keyed before the children are linked to them'
  );
  assert.match(block, /var onlyAddressKey = addressRowKey\(draftAddresses\[0\]\);/u);
  assert.match(block, /if \(!row\.__addressKey && onlyAddressKey\) row\.__addressKey = onlyAddressKey;/u);
  // Same rule as the server end: one address is one candidate, and two is not a choice to make.
  assert.match(block, /draftAddresses\.length === 1/u);
});
