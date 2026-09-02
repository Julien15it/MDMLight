'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRegistryStages } = require('../srv/checks/registry-checks');
const { runChecks } = require('../srv/checks/pipeline');
const fieldPropertyStore = require('../srv/checks/field-property-store');
const { fieldState } = require('../srv/checks/field-properties');

/**
 * Pins the exact mechanism `runRequestChecks` (srv/change-request-service.js) builds for every
 * Check/Duplicate Check call: `fieldEditable(target, field) = fieldState(resolvedProperties(...),
 * target, field).editable`. This reproduces those two lines against a real Field Property Profile
 * fixture, so a change to either module that breaks the wiring fails here even though neither
 * module's own unit tests would notice.
 *
 * CLAUDE.md: "Derivations never run on approve" is guaranteed structurally (the approve action never
 * calls runRequestChecks at all) - but Check/Duplicate Check are still offered on the approve screen,
 * and rely on an Approver-scoped profile marking the relevant entities hidden or read-only for THIS
 * second layer to suppress proposals. Without such a profile, fieldEditable defaults to true.
 */

const payload = (root = {}, sections = {}) => ({ root, sections });

// Same VIES fixture as test/registry-checks.test.js: an empty address row that VIES fills in.
const registryStages = () => createRegistryStages({
  enrich: async () => ({
    findings: [],
    facts: { vies: [{ address: { StreetName: 'Kerkstraat', HouseNumber: '12', CityName: 'Gent', Country: 'BE' } }], gleif: [] },
    provenance: []
  })
});

async function fieldEditableFor(role, { profiles, settings }) {
  fieldPropertyStore.reset();
  const resolved = await fieldPropertyStore.resolvedProperties(
    { requestType: 'create', role },
    { readRows: async () => ({ profiles, settings }) }
  );
  fieldPropertyStore.reset();
  return (target, field) => fieldState(resolved, target, field).editable;
}

test('an address derivation fires for a role no profile restricts', async () => {
  const registry = registryStages();
  const fieldEditable = await fieldEditableFor('Requester', { profiles: [], settings: [] });

  const result = await runChecks(
    payload({}, { Addresses: [{ StreetName: '', HouseNumber: '', CityName: 'Gent' }] }),
    { validations: registry.validations, derivations: registry.derivations, checkDuplicates: async () => [], fieldEditable }
  );

  assert.ok(result.derivations.some((entry) => entry.target === 'Addresses' && entry.field === 'StreetName'));
  assert.equal(result.derived.sections.Addresses[0].StreetName, 'Kerkstraat');
});

test('an Approver profile hiding Addresses suppresses the same derivation entirely', async () => {
  const profiles = [{ ID: 'p1', requestType: '*', role: 'Approver', isActive: true }];
  // Entity-level row (no `element`) - only hidden/readOnly cascade from an entity to its fields.
  const settings = [{ profile_ID: 'p1', section: 'Addresses', element: null, property: 'hidden' }];

  const registry = registryStages();
  const fieldEditable = await fieldEditableFor('Approver', { profiles, settings });

  const result = await runChecks(
    payload({}, { Addresses: [{ StreetName: '', HouseNumber: '', CityName: 'Gent' }] }),
    { validations: registry.validations, derivations: registry.derivations, checkDuplicates: async () => [], fieldEditable }
  );

  assert.deepEqual(result.derivations, []);
  assert.equal(result.derived.sections.Addresses[0].StreetName, '', 'nothing is filled for a field the role cannot see');
});

test('a profile scoped to a different role does not suppress the derivation', async () => {
  const profiles = [{ ID: 'p1', requestType: '*', role: 'DataSteward', isActive: true }];
  const settings = [{ profile_ID: 'p1', section: 'Addresses', element: null, property: 'hidden' }];

  const registry = registryStages();
  const fieldEditable = await fieldEditableFor('Approver', { profiles, settings });

  const result = await runChecks(
    payload({}, { Addresses: [{ StreetName: '', HouseNumber: '', CityName: 'Gent' }] }),
    { validations: registry.validations, derivations: registry.derivations, checkDuplicates: async () => [], fieldEditable }
  );

  assert.ok(result.derivations.some((entry) => entry.target === 'Addresses' && entry.field === 'StreetName'));
});
