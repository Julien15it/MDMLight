'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'mdmrules', 'webapp');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const view = (name) => read(APP, 'ext', 'view', `${name}.view.xml`);
const controller = (name) => read(APP, 'ext', 'controller', `${name}.controller.js`);

// Every tile that draws a table of rows a steward selects. Field Properties is in this list where it
// is not in the condition-column ones: it has rows to tick and columns to widen, it just has no
// conditions - see CLAUDE.md, "Rolled out to the other three rule tables".
const RULE_PAGES = [
  'DuplicateRuleList', 'ValidationRuleList', 'DerivationRuleList', 'WorkflowRuleList'
];
const ALL_PAGES = [...RULE_PAGES, 'FieldPropertyProfileList'];

/**
 * A checkbox as column 1, and the header's own checkbox selecting every loaded row (2026-09-02,
 * asked for). `sap.m.Table` draws both from `mode="MultiSelect"` alone, which is why no page
 * declares a column for it - and why the width arithmetic has to allow for one it cannot see.
 */
test('every rule table selects several rows at once', () => {
  for (const name of ALL_PAGES) {
    assert.match(view(name), /mode="MultiSelect"/u, `${name} is MultiSelect`);
    assert.equal(/mode="SingleSelectMaster"/u.test(view(name)), false, `${name} keeps no single-select`);
  }
});

test('Delete acts on every ticked row, and clears the selection it just destroyed', () => {
  for (const name of ALL_PAGES) {
    const source = controller(name);
    const start = source.indexOf(name === 'FieldPropertyProfileList' ? 'onDeleteProfile: function' : 'onDeleteRule: function');
    const body = source.slice(start, source.indexOf('\n    },', start));
    assert.match(body, /getSelectedItems\(\)/u, `${name} reads every selected row`);
    assert.equal(/getSelectedItem\(\)/u.test(body), false, `${name} no longer reads only one`);
    // Each context is deleted in the same update group, so one Save still writes them together.
    assert.match(body, /contexts\.forEach\(function \(context\) \{ context\.delete\(UPDATE_GROUP\); \}\)/u, name);
    assert.match(body, /removeSelections\(true\)/u, `${name} drops the stale selection`);
    // The confirmation says how many, or "delete these 7 rules" reads as one.
    assert.match(body, /contexts\.length === 1/u, `${name} counts what it is about to delete`);
  }
});

test('Duplicate copies every ticked row, not only the focused one', () => {
  for (const name of RULE_PAGES) {
    const source = controller(name);
    const start = source.indexOf('onDuplicateRule: function');
    const body = source.slice(start, source.indexOf('\n    },', start));
    assert.match(body, /getSelectedItems\(\)/u, name);
    assert.match(body, /STRIP_ON_COPY\.forEach/u, `${name} still strips identity from every copy`);
    assert.match(body, /binding\.create\(copy\)/u, name);
    assert.match(body, /removeSelections\(true\)/u, name);
  }
});

/**
 * Resizing a column by dragging the BORDER between two header cells (2026-09-02, asked for -
 * clarified the same day: the ask was never to move columns around). `sap.m.Table` has no resizing
 * of its own - that is `sap.ui.table.Table` - so this is a shared utility appending real DOM grips,
 * the same call XlsxCodec made: heavy machinery is extracted, per-page wiring is not.
 */
test('every rule table resizes its columns from the one shared utility', () => {
  for (const name of ALL_PAGES) {
    const source = controller(name);
    assert.match(source, /mdm\/md\/mdmrules\/manage\/ext\/util\/ColumnResizer/u, `${name} loads it`);
    assert.match(source, /ColumnResizer\.enable\(this\._table\(\)/u, `${name} enables it on its table`);
  }
});

test('the resizer writes the width back onto the column, and survives a re-render', () => {
  const source = read(APP, 'ext', 'util', 'ColumnResizer.js');
  // Onto the control, not onto the DOM: every keystroke in a bound cell can re-render the table,
  // and an inline style would go with it.
  assert.match(source, /column\.setWidth\(width \+ "px"\)/u);
  assert.match(source, /onAfterRendering: function \(\) \{ install\(table, onResize\); \}/u);
  // The header cell carries its column's own id, so hidden columns cannot shift the mapping.
  assert.match(source, /Element\.getElementById\(header\.id\)/u);
  assert.match(source, /var MIN_WIDTH_PX = \d+;/u, 'a column cannot be dragged away entirely');
  // The grip sits on the right-hand border of the cell, which is the line a person reaches for -
  // and it is the ONLY thing a drag touches. A column is never moved: nothing here, and nothing on
  // any of the five tables, configures drag-and-drop reordering.
  assert.match(read(APP, 'css', 'style.css'), /right: 0;/u);
  assert.match(read(APP, 'css', 'style.css'), /cursor: col-resize;/u);
  for (const name of ALL_PAGES) {
    assert.equal(/dragDropConfig|DragDropInfo/u.test(view(name)), false, `${name} never reorders columns`);
  }
  // The stylesheet the handle needs has to be declared, or it is an invisible zero-size div.
  const manifest = JSON.parse(read(APP, 'manifest.json'));
  assert.deepEqual(manifest['sap.ui5'].resources.css, [{ uri: 'css/style.css' }]);
  assert.match(read(APP, 'css', 'style.css'), /\.mdmColumnResizer/u);
});

test('a resized column widens the table rather than stealing from its neighbour', () => {
  for (const name of RULE_PAGES) {
    const source = controller(name);
    assert.match(source, /widthAdjust: 0/u, `${name} tracks the pixels a drag added`);
    assert.match(source, /_onColumnResized: function \(delta\)/u, name);
    // One setter for the width, so revealing a condition cannot silently undo a resize.
    assert.match(source, /_applyTableWidth: function/u, name);
    assert.match(source, /"calc\(" \+ rem/u, `${name} keeps the rem half of the width`);
  }
});

/**
 * "Check Current Data" on the Validation Rules page - the duplicate tile's "Test Against Current
 * BPs" for validations, and the open item CLAUDE.md has carried since 2026-08-19. Derivation
 * deliberately does NOT get one: it fills empty fields on the request in front of you, so there is
 * no population-wide verdict to preview.
 */
test('only the validation page offers a check against the current data', () => {
  const validation = view('ValidationRuleList');
  const button = validation.slice(validation.indexOf('text="Check Current Data"'));
  assert.match(button.slice(0, button.indexOf('/>')), /press="\.onCheckCurrentData"/u);
  assert.equal(/Check Current Data/u.test(view('DerivationRuleList')), false, 'not on Derivation');
});

test('the check runs the rules on screen, unsaved ones included', () => {
  const source = controller('ValidationRuleList');
  const start = source.indexOf('onCheckCurrentData: async function');
  const body = source.slice(start, source.indexOf('\n    },', start));
  // `_draftRules` is the grid as it stands, which is the whole point - the duplicate page's own
  // test button reads its rules the same way.
  assert.match(body, /this\._draftRules\(\)/u);
  assert.match(body, /_callAction\("testValidationRuleset"/u);
  // Half a rule cannot be run against anything; saying so at the keyboard beats a report that
  // quietly left it out.
  assert.match(body, /this\._localProblems\(rules\)/u);
});

test('a section that could not be read is reported, never read as a clean bill of health', () => {
  const source = controller('ValidationRuleList');
  const start = source.indexOf('_showDataReport: function');
  const body = source.slice(start, source.indexOf('\n    },', start));
  assert.match(body, /report\.unavailable/u);
  assert.match(body, /report\.skipped/u);
  assert.match(body, /report\.tooLarge/u);
});

test('the action is declared on both services, and the config service delegates it', () => {
  const bpCds = read(ROOT, 'srv', 'business-partner-service.cds');
  const configCds = read(ROOT, 'srv', 'duplicate-config-service.cds');
  const configJs = read(ROOT, 'srv', 'duplicate-config-service.js');
  for (const source of [bpCds, configCds]) {
    assert.match(source, /action testValidationRuleset\(\s*RulesJson\s*:\s*LargeString,\s*SampleSize\s*:\s*Integer\s*\) returns LargeString;/u);
  }
  // Delegated, not re-implemented: BusinessPartnerService owns the S/4 connection, the same
  // reasoning testRuleset already follows for the duplicate check.
  const handler = configJs.slice(configJs.indexOf("this.on('testValidationRuleset'"));
  assert.match(handler, /cds\.connect\.to\('BusinessPartnerService'\)/u);
  assert.match(handler, /bp\.send\('testValidationRuleset'/u);
});

test('the scan reads only what the ruleset needs, and never a projection of General', () => {
  const source = read(ROOT, 'srv', 'business-partner-service.js');
  const handler = source.slice(source.indexOf("this.on('testValidationRuleset'"));
  const body = handler.slice(0, handler.indexOf('\n    });'));
  // With no RulesJson it runs what is stored, so the button answers on a page nobody has edited.
  assert.match(body, /mdmlight\.config\.ValidationRules/u);
  assert.match(body, /scanValidationRules\(/u);

  // Every column of A_BusinessPartner: a rule may name any General field, and a fixed column list
  // would silently make those rules report nothing.
  const reader = source.slice(source.indexOf('function readScanPartners'));
  assert.equal(/\.columns\(/u.test(reader.slice(0, reader.indexOf('\n}'))), false);

  // The customer/supplier tree is read by the number A_BusinessPartner carries, never by the
  // partner number - CVI does not guarantee the two are the same.
  assert.match(source, /Customers: 'Customer', Suppliers: 'Supplier'/u);
  assert.match(source, /parentKey === 'Customer' \|\| parentKey === 'Supplier'/u);
});
