'use strict';

/**
 * Every maintainable section must resolve to an exposed entity, or its writes are silently nonsense.
 *
 * Found 2026-08-28 from an activation failure: `CustomerTaxIndicators: enter required field(s)
 * Customer, SalesOrganization, DistributionChannel, Division, DepartureCountry,
 * CustomerTaxCategory` -- ALL SIX, including the two the derivation had filled. The cause was not
 * the data: `saveBusinessPartnerEntity` looked the entity up by SECTION ID, 18 of the 31 nodes are
 * projected under their S/4 name instead (`A_CustomerDunning`, not `CustomerDunning`), and
 * `scalarElements(undefined)` is `[]` -- so `sanitizeEntityPayload` returned {} and every required
 * field read as missing. The delete path was worse: no keys, so an empty `where`.
 *
 * Nothing checked this. `mdg-node-tree.test.js` covers staging, catalog and screen wiring; the post
 * path's own entity lookup was the one link with no test behind it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAINTENANCE_ENTITIES, maintenanceEntity
} = require('../srv/business-partner-service')._internals;

const serviceCds = fs.readFileSync(
  path.join(__dirname, '..', 'srv', 'business-partner-service.cds'), 'utf8'
);

// The names BusinessPartnerService actually exposes, read from the CDS rather than a hand-kept list.
const exposed = new Set(
  [...serviceCds.matchAll(/entity\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+projection/gu)].map((m) => m[1])
);

// A stand-in for the service: only `entities` is read.
const serviceWith = (names) => ({
  entities: Object.fromEntries(names.map((name) => [name, { elements: { X: {} } }]))
});

test('every maintainable section resolves to an entity the service exposes', () => {
  const unresolvable = Object.entries(MAINTENANCE_ENTITIES)
    .filter(([section, config]) => !exposed.has(section) && !exposed.has(config.remote))
    .map(([section]) => section);

  assert.deepEqual(
    unresolvable, [],
    'a section resolvable by neither its own id nor its remote name can never be written'
  );
});

test('the resolver accepts the section id and the S/4 name it is exposed under', () => {
  const config = { remote: 'A_CustomerDunning' };

  // The 13 nodes exposed under their section id.
  assert.ok(maintenanceEntity(serviceWith(['CustomerDunning']), 'CustomerDunning', config));
  // The 18 exposed under their S/4 name - the case that was broken.
  assert.ok(maintenanceEntity(serviceWith(['A_CustomerDunning']), 'CustomerDunning', config));
  // Section id wins when both exist, so a later rename takes effect without touching this.
  const both = serviceWith(['CustomerDunning', 'A_CustomerDunning']);
  assert.equal(
    maintenanceEntity(both, 'CustomerDunning', config), both.entities.CustomerDunning
  );
});

/**
 * Throwing is the point. Returning undefined is what produced an empty payload and an empty
 * `where` - both of which read as success right up to the moment S/4 refused, or did not.
 */
test('an unresolvable section throws instead of yielding an empty payload', () => {
  assert.throws(
    () => maintenanceEntity(serviceWith(['SomethingElse']), 'CustomerDunning', { remote: 'A_X' }),
    (error) => {
      assert.match(error.message, /CustomerDunning: no exposed entity/u);
      assert.match(error.message, /looked for CustomerDunning and A_X/u, 'it names both attempts');
      assert.equal(error.statusCode, 500, 'a wiring bug, not the requester\'s fault');
      return true;
    }
  );
});

// Both write paths go through the resolver, so neither can regress to a bare lookup.
test('the create and delete paths both resolve through it', () => {
  const serviceJs = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'business-partner-service.js'), 'utf8'
  );
  assert.equal(
    (serviceJs.match(/maintenanceEntity\(this, req\.data\.Entity, configuration\)/gu) || []).length,
    2,
    'saveBusinessPartnerEntity and deleteBusinessPartnerEntity'
  );
  assert.equal(
    /this\.entities\[req\.data\.Entity\]/u.test(serviceJs), false,
    'no bare lookup is left'
  );
});
