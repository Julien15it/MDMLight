'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readDestinationInstanceGuid } = require('../srv/ui-prefix')._internals;

const GUID = '5db4d34d-4f01-4e6c-9b54-2f2350a5d153';

function withVcap(value, run) {
  const before = process.env.VCAP_SERVICES;
  if (value === undefined) delete process.env.VCAP_SERVICES;
  else process.env.VCAP_SERVICES = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.VCAP_SERVICES;
    else process.env.VCAP_SERVICES = before;
  }
}

// The one fact this module exists for: the approuter needs the destination service INSTANCE, not
// the app-host and not a Work Zone content provider. See CLAUDE.md, "The task app".
test('the destination binding instance guid is what is read', () => {
  const vcap = JSON.stringify({
    'html5-apps-repo': [{ instance_guid: '6a0335a0-12e5-4c1f-a910-114c262314ff' }],
    destination: [{ label: 'destination', name: 'mdm-businesspartner-destination-service', instance_guid: GUID }]
  });
  assert.equal(withVcap(vcap, readDestinationInstanceGuid), GUID);
});

// A bound instance carries its own label, so the group key is not the only way in.
test('a binding labelled destination is found under any group key', () => {
  const vcap = JSON.stringify({
    'user-provided': [{ label: 'destination', instance_guid: GUID }]
  });
  assert.equal(withVcap(vcap, readDestinationInstanceGuid), GUID);
});

// Empty is a legitimate answer - every local run - and the task app reports it rather than
// building a path that 404s. What must never happen is a guess.
test('no destination binding, no VCAP and unreadable VCAP all yield empty', () => {
  assert.equal(withVcap(JSON.stringify({ xsuaa: [{ instance_guid: GUID }] }), readDestinationInstanceGuid), '');
  assert.equal(withVcap(undefined, readDestinationInstanceGuid), '');
  assert.equal(withVcap('not json', readDestinationInstanceGuid), '');
});

test('a destination entry with no instance guid is skipped, not returned as empty', () => {
  const vcap = JSON.stringify({
    destination: [{ label: 'destination' }, { label: 'destination', instance_guid: GUID }]
  });
  assert.equal(withVcap(vcap, readDestinationInstanceGuid), GUID);
});

// Non-array groups appear in VCAP_SERVICES in some runtimes; they must not throw the lookup.
test('a malformed group does not throw', () => {
  const vcap = JSON.stringify({ destination: { label: 'destination', instance_guid: GUID } });
  assert.equal(withVcap(vcap, readDestinationInstanceGuid), '');
});
