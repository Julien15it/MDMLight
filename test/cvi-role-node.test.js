'use strict';

/**
 * How postToS4 treats the Customer and Supplier nodes, which is where CVI meets this app.
 *
 * Those two nodes ARE the record the relation field names; everything else hangs off it. Once
 * CVI is configured, adding the role is what creates the customer - so by the time the node is
 * reached S/4 already has one and a POST would be refused. Without CVI nothing else creates it
 * and the same node has to post. Whether the record is there decides it, not what the requester
 * did on screen.
 *
 * Asserted against the source rather than a running service: postToS4 needs a database, an S/4
 * destination and a workflow to reach, and what is worth pinning here is the decision, not the
 * plumbing around it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
);

/** The node loop of postToS4, so a match cannot come from somewhere else in the file. */
const loop = (() => {
  const start = source.indexOf('for (const [section, config] of Object.entries(NODES))');
  assert.ok(start > -1, 'the node loop moved');
  return source.slice(start, source.indexOf('return businessPartner;', start));
})();

test('only Customers and Suppliers are the record itself', () => {
  assert.match(source, /const ROLE_NODES = new Set\(\['Customers', 'Suppliers'\]\)/u);
  const { PAYLOAD_NODES } = require('../srv/checks/payload-fields');
  // Both are single-cardinality: one customer per partner, which is what makes them the record
  // rather than a list hanging off it.
  assert.equal(PAYLOAD_NODES.Customers.many, false);
  assert.equal(PAYLOAD_NODES.Suppliers.many, false);
});

test('a missing relation number creates the role node and blocks a child', () => {
  // The child case: nothing to hang it on, so it is refused rather than posted somewhere else.
  assert.match(loop, /if \(relationValue == null && !isRoleNode\) \{/u);
  assert.match(loop, /has no \$\{relationField\} record yet/u);
  // The role case: absent means "not created yet", which is what create is for.
  assert.match(loop, /const isCreate = isRoleNode \? relationValue == null : action !== 'U'/u);
});

test('a create of the role node carries the business partner it hangs off', () => {
  // to_Customer is a navigation off A_BusinessPartner, so the payload needs that key or
  // businessPartnerNavigationPath refuses with "Enter a BusinessPartner number".
  assert.match(loop, /if \(isRoleNode\) data\.BusinessPartner = businessPartner;/u);

  const { MAINTENANCE_ENTITIES } = require('../srv/business-partner-service')._internals;
  for (const section of ['Customers', 'Suppliers']) {
    const configuration = MAINTENANCE_ENTITIES[section];
    assert.equal(configuration.creatable, true);
    // No parentEntity, so it defaults to A_BusinessPartner keyed on BusinessPartner.
    assert.equal(configuration.parentEntity, undefined);
    assert.equal(configuration.parentKeyField, undefined);
  }
});

test('an update sends its keys, so it can address a row at all', () => {
  // Sent as `{}` until 2026-08-21, which made every update fail on "Missing key field(s)"
  // rather than update anything. The keys are in `data`: the relation field plus what the row
  // staged, which is the same object the delete path has always passed.
  assert.match(loop, /KeyJson: JSON\.stringify\(data\),\s*\n\s*DataJson: JSON\.stringify\(data\)/u);
  assert.equal(/KeyJson: JSON\.stringify\(\{\}\)/u.test(loop), false, 'no empty key payload left');
});

test('the keys an update needs are staged, for every node that has any', async () => {
  const cds = require('@sap/cds');
  const model = cds.linked(await cds.load(path.join(__dirname, '..', 'db')));
  const { PAYLOAD_NODES, ROOT_SECTION } = require('../srv/checks/payload-fields');
  const { MAINTENANCE_ENTITIES } = require('../srv/business-partner-service')._internals;

  for (const [section, node] of Object.entries(PAYLOAD_NODES)) {
    if (section === ROOT_SECTION) continue;
    const configuration = MAINTENANCE_ENTITIES[section];
    if (!configuration) continue;

    const staged = model.definitions[node.entity].elements;
    // requiredCreateFields names the row's own keys, and postToS4 supplies the relation field
    // itself - so everything else has to come out of the staged row or the update cannot
    // address anything.
    const relationField = configuration.parentKeyField
      || (configuration.parentKeyFields || [])[0]
      || 'BusinessPartner';
    const missing = (configuration.requiredCreateFields || [])
      .filter((field) => field !== relationField && field !== 'BusinessPartner')
      .filter((field) => !staged[field]);
    assert.deepEqual(missing, [], `${node.entity} cannot hold its own key: ${missing.join(', ')}`);
  }
});
