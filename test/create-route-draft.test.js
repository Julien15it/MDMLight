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

/**
 * `_onCreateRoute` and `ROOT_DRAFT_FIELDS`, extracted and run for real - like `matchSectionRows` in
 * change-highlighting.test.js, this earns the extra ceremony because it is exactly what a real,
 * reported bug (2026-09-04, "the address is correctly retrieved by the assistant but never applied
 * when I press Create") turned out to be wrong inside: `_onCreateRoute` parsed `query.draft` with a
 * bare `JSON.parse`, but the router hands the value back exactly as it arrived in the hash - still
 * percent-encoded, since BusinessPartnerAssistant.js builds it with `encodeURIComponent` - and SAPUI5
 * documents that its router never decodes a route/query parameter for the app. So `JSON.parse` threw
 * on every single suggestion and silently fell into `draft = {}`, dropping the WHOLE draft: root
 * fields (company name, category, search term) and every section (Addresses included), not only the
 * address - the address was just the one field someone was watching for.
 */
function extractConst(name) {
  const match = controller.match(new RegExp('var ' + name + ' = (\\[[\\s\\S]*?\\]);'));
  if (!match) throw new Error(name + ' not found');
  // eslint-disable-next-line no-eval
  return eval(match[1]);
}

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

function extractOnCreateRoute() {
  const labelAt = controller.indexOf('_onCreateRoute:');
  const braceStart = controller.indexOf('{', controller.indexOf('(event)', labelAt));
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < controller.length; i += 1) {
    if (controller[i] === '{') depth += 1;
    if (controller[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const body = controller.slice(controller.indexOf('(event)', labelAt), end);
  // generateRowKey is called on a new Addresses draft row - a real module-level helper, not a
  // stub, so a malformed key would show up here the same way it would in the real app.
  // eslint-disable-next-line no-new-func
  return new Function(
    'ROOT_DRAFT_FIELDS',
    extractFunctionSource('generateRowKey') + '\nreturn (async function ' + body + ')'
  )(extractConst('ROOT_DRAFT_FIELDS'));
}

/** A minimal stand-in for the "maintenance" JSONModel/view/component `_onCreateRoute` touches. */
function fakeContext() {
  const model = {
    setData(data) { this._data = data; },
    getData() { return this._data; },
    refresh() {}
  };
  return {
    model,
    ctx: {
      _emptyState: () => ({ root: { BusinessPartnerCategory: '2', BusinessPartnerGrouping: '' }, sections: {} }),
      _metadata: [
        { id: 'BusinessPartners', kind: 'root' },
        { id: 'Addresses', kind: 'collection' },
        { id: 'BankDetails', kind: 'collection' }
      ],
      getView: () => ({ getModel: () => model }),
      _refreshFullName: () => {},
      _updatePreview: () => {},
      _loadFieldProperties: async () => {},
      _renderAll: () => {}
    }
  };
}

// The exact shape BusinessPartnerAssistant.js hands _onCreateRoute via HashChanger.setHash -
// encodeURIComponent(JSON.stringify(draft)) - and the exact shape the router hands back: unchanged.
function routeEventFor(draft) {
  return { getParameter: () => ({ '?query': { draft: encodeURIComponent(JSON.stringify(draft)) } }) };
}

test('a Business Partner Assistant draft is decoded before being parsed, address included', async () => {
  const onCreateRoute = extractOnCreateRoute();
  const { model, ctx } = fakeContext();
  const draft = {
    root: { OrganizationBPName1: 'Alluvion B.V.', SearchTerm1: 'Alluvion', CorrespondenceLanguage: 'NL' },
    sections: {
      Addresses: [{ StreetName: 'Herengracht 2A', PostalCode: '2312LD', CityName: 'Leiden', Country: 'NL' }]
    }
  };

  await onCreateRoute.call(ctx, routeEventFor(draft));

  assert.equal(model.getData().root.OrganizationBPName1, 'Alluvion B.V.');
  assert.equal(model.getData().root.SearchTerm1, 'Alluvion');
  const address = model.getData().sections.Addresses[0];
  // __rowKey is a fresh random value every run (generateRowKey) - a suggestion never carries one,
  // since the server that built it has no concept of the client's own row keys, and it is what
  // lets an Address's own Email/Phone/Fax/Website/Tax Number children (added in the same request,
  // before S/4 has assigned a real AddressID) be linked to the right one.
  assert.equal(typeof address.__rowKey, 'string');
  assert.ok(address.__rowKey.length > 0);
  const { __rowKey, ...rest } = address;
  assert.deepEqual(rest, {
    StreetName: 'Herengracht 2A', PostalCode: '2312LD', CityName: 'Leiden', Country: 'NL', __state: 'new'
  });
});

test('a create route with no draft still renders the plain empty-create state', async () => {
  const onCreateRoute = extractOnCreateRoute();
  const { model, ctx } = fakeContext();

  await onCreateRoute.call(ctx, { getParameter: () => ({}) });

  assert.deepEqual(model.getData().root, { BusinessPartnerCategory: '2', BusinessPartnerGrouping: '' });
  assert.deepEqual(model.getData().sections.Addresses, []);
});

test('a malformed draft is refused rather than thrown, and still renders the empty-create state', async () => {
  const onCreateRoute = extractOnCreateRoute();
  const { model, ctx } = fakeContext();

  await onCreateRoute.call(ctx, { getParameter: () => ({ '?query': { draft: 'not%20json%at%all' } }) });

  assert.deepEqual(model.getData().root, { BusinessPartnerCategory: '2', BusinessPartnerGrouping: '' });
});
