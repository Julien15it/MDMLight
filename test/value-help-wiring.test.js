'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { VALUE_HELP_ENTITIES } = require('../srv/business-partner-service')._internals;

const ROOT = path.join(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

const serviceCds = read('srv', 'business-partner-service.cds');
const annotations = read('srv', 'annotations.cds');
const importedModel = read('srv', 'external', 'ZSRVB_MDMLIGHT_VH.cds');
const maintenanceController = read(
  'app', 'businesspartner', '..', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'controller', 'BusinessPartnerMaintenance.controller.js'
);

// Adding a lookup means touching four files, and until now the only thing holding them together
// was a comment. Each of these has a way of failing that looks like something else: a missing
// projection is a 404, a missing VALUE_HELP_ENTITIES entry silently forwards the read to S/4,
// where the entity does not exist.
const projections = [...serviceCds.matchAll(/entity\s+(\w+)\s+as projection on VH\.(\w+)/gu)]
  .map(([, local, remote]) => ({ local, remote }));

test('every value-help projection is registered, and every registration is projected', () => {
  assert.ok(projections.length >= 18, 'the projections are no longer recognisable in the CDS');
  assert.deepEqual(
    projections.map((entry) => entry.local).sort(),
    [...VALUE_HELP_ENTITIES].sort(),
    'business-partner-service.cds and VALUE_HELP_ENTITIES disagree'
  );
});

// A read of an entity missing from the array is forwarded to API_BUSINESS_PARTNER, which exposes
// none of these — so the failure lands nowhere near the line that caused it.
test('every registered entity has a READ handler routing it to the value-help service', () => {
  const service = read('srv', 'business-partner-service.js');
  assert.match(
    service,
    /for \(const entity of VALUE_HELP_ENTITIES\)[\s\S]{0,300}valueHelp\.run\(req\.query\)/u,
    'the routing loop is gone'
  );
});

test('every projected entity exists in the imported metadata', () => {
  for (const { remote } of projections) {
    assert.ok(
      new RegExp(`^entity ZSRVB_MDMLIGHT_VH\\.${remote} \\{`, 'mu').test(importedModel),
      `VH.${remote} is projected but not in srv/external/ZSRVB_MDMLIGHT_VH.cds — re-run npm run import:valuehelp`
    );
  }
});

// The UI reaches the lookups by collection name over OData. A typo here is an empty F4 dialog,
// which is exactly the failure this page shipped with once already.
test('every collectionPath the maintenance UI asks for is an exposed entity', () => {
  const paths = [...maintenanceController.matchAll(/collectionPath:\s*"(\w+)"/gu)].map(([, name]) => name);
  assert.ok(paths.length > 0, 'VALUE_HELP_FIELDS no longer declares collection paths');
  for (const collectionPath of new Set(paths)) {
    assert.ok(
      VALUE_HELP_ENTITIES.includes(collectionPath),
      `${collectionPath} is used by the UI but not exposed by the service`
    );
  }
});

test('every @Common.ValueList points at an exposed entity', () => {
  const paths = [...annotations.matchAll(/CollectionPath:\s*'(\w+)'/gu)].map(([, name]) => name);
  assert.ok(paths.length > 0, 'the value-list annotations are gone');
  for (const collectionPath of new Set(paths)) {
    assert.ok(
      VALUE_HELP_ENTITIES.includes(collectionPath),
      `${collectionPath} is annotated but not exposed by the service`
    );
  }
});

// The clash it exists to avoid: BusinessPartnerRoles is already the S/4 child entity.
test('the role code list keeps its renamed projection', () => {
  assert.match(serviceCds, /entity BusinessPartnerRoleCodes\s+as projection on VH\.BusinessPartnerRoles/u);
  assert.ok(VALUE_HELP_ENTITIES.includes('BusinessPartnerRoleCodes'));
});
