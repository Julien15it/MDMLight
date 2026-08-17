'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalisableFields, proposeNormalisations } = require('../srv/checks/normalise');

const PAYLOAD = {
  root: { OrganizationBPName1: 'alluvion bv' },
  sections: {
    addresses: [{ StreetName: 'koedreef 12', CityName: 'brasschaat', Country: 'be' }],
    taxNumbers: [{ BPTaxNumber: 'BE0404616494' }]
  }
};

// A section trigger must ask the model about the section the requester just left, not the whole
// record: the point of scoping is fewer tokens and no proposals for untouched sections.
test('an unscoped call offers every populated field, a scoped one only its target', () => {
  const all = normalisableFields(PAYLOAD).map((f) => `${f.target}.${f.field}`);
  assert.ok(all.includes('root.OrganizationBPName1'));
  assert.ok(all.some((k) => k.startsWith('addresses.')));

  const addresses = normalisableFields(PAYLOAD, 'addresses');
  assert.ok(addresses.length > 0, 'the address fields are still offered');
  assert.ok(addresses.every((f) => f.target === 'addresses'), 'and nothing else is');

  const root = normalisableFields(PAYLOAD, 'root');
  assert.ok(root.every((f) => f.target === 'root'));
});

test('a scope that matches nothing offers nothing rather than falling back to everything', () => {
  assert.deepEqual(normalisableFields(PAYLOAD, 'bankDetails'), []);
});

// Country/Region casing is deterministic, so it survives an AI Core outage - but it must respect
// the scope too, or a name-section trigger would report an address field.
test('the deterministic proposals are scoped as well', async () => {
  const scoped = await proposeNormalisations({ payload: PAYLOAD, scope: 'root', env: {} });
  assert.ok(scoped.every((p) => p.target === 'root'), 'no address casing from a root trigger');

  const addresses = await proposeNormalisations({ payload: PAYLOAD, scope: 'addresses', env: {} });
  assert.ok(addresses.some((p) => p.field === 'Country'), 'be -> BE is still proposed in scope');
});

// Propose:false is what a tax-number trigger sends: it wants the register, not an LLM call.
test('the action declares Propose and Scope, and the runner threads both', () => {
  const cds = fs.readFileSync(path.join(__dirname, '..', 'srv', 'change-request-service.cds'), 'utf8');
  const checkAction = cds.slice(cds.indexOf('action checkRequest('), cds.indexOf('action duplicateCheckRequest('));
  assert.match(checkAction, /Propose\s+:\s+Boolean/u);
  assert.match(checkAction, /Scope\s+:\s+String\(40\)/u);

  const js = fs.readFileSync(path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8');
  assert.match(js, /runRequestChecks = async \(req, \{ propose, duplicates, scope = null \}\)/u);
  assert.match(js, /proposeNormalisations\(\{ payload: derived, scope: scope \|\| null \}\)/u);
  // Omitting Propose must keep the button's behaviour: propose everything.
  assert.match(js, /propose: req\.data\.Propose !== false/u);
  // The duplicate check never proposes, trigger or not.
  assert.match(js, /runRequestChecks\(req, \{ propose: false, duplicates: true \}\)/u);
});

const CONTROLLER = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'businesspartner', 'webapp', 'ext', 'controller',
    'BusinessPartnerMaintenance.controller.js'),
  'utf8'
);

// A tax number earns a register lookup on its own. Nothing else does - everything else waits for
// the requester to leave the scope, so one address block is one AI Core call, not four.
test('only the tax number triggers on its own, and it never asks for a proposal', () => {
  assert.match(CONTROLLER, /REGISTRY_TRIGGER_FIELDS = \{ BPTaxNumber: true \}/u);
  const handler = CONTROLLER.slice(
    CONTROLLER.indexOf('_onFieldCommitted: function'),
    CONTROLLER.indexOf('_flushPendingScope: function')
  );
  assert.match(handler, /_scheduleTrigger\(\{ propose: false, scope: null \}\)/u, 'register only');
  assert.match(handler, /section\.kind === "root" \? "root" : section\.id/u, 'scope is the section id');
});

// liveChange fires per keystroke; the trigger must hang off the committed value only.
test('the commit hook is a change handler on text inputs, not a liveChange', () => {
  assert.match(CONTROLLER, /if \(control instanceof Input\) this\._attachCommitTrigger\(/u);
  const attach = CONTROLLER.slice(
    CONTROLLER.indexOf('_attachCommitTrigger: function'),
    CONTROLLER.indexOf('_onFieldCommitted: function')
  );
  assert.match(attach, /control\.attachChange\(/u);
  assert.equal(/attachLiveChange/u.test(attach), false, 'never per keystroke');
});

// The requester is still typing: a trigger that popped a MessageBox or blocked the form would be
// worse than no trigger at all.
test('a triggered check is quiet, guarded and de-duplicated', () => {
  const run = CONTROLLER.slice(
    CONTROLLER.indexOf('_runTriggeredCheck: async function'),
    CONTROLLER.indexOf('onCheck: async function')
  );
  assert.equal(/MessageBox/u.test(run), false, 'no modal from a trigger');
  assert.equal(/state\.busy = true/u.test(run), false, 'never blocks the form');
  assert.match(run, /if \(state\.busy \|\| this\._triggerInFlight\) return/u, 'one at a time');
  assert.match(run, /if \(key === this\._lastTriggerKey\) return/u, 'unchanged data costs nothing');
  assert.match(run, /Propose: options\.propose/u);
  assert.match(run, /Scope: options\.scope \|\| null/u);
  // Proposals go through the same vetted dialog, so nothing is written without a tick.
  assert.match(run, /if \(proposals\.length\) this\._offerProposals\(proposals\)/u);
  assert.equal(/_applyProposals/u.test(run), false, 'a trigger never applies anything itself');
  assert.match(run, /catch \(error\)[\s\S]{0,200}console\.warn/u, 'a failed trigger never interrupts');
});
