'use strict';

/**
 * The AI switch. Two things have to hold for it to be worth anything.
 *
 * It has to be enforced where the model is called, not only where the button is
 * drawn - so each of the three call sites is asserted to reach no client at all
 * when the switch is off, using the same injected-client seam the AI Core tests
 * use.
 *
 * And it has to fail towards "on". A missing settings row, an unreachable
 * database or a service too old to return the flag must all leave assistance
 * working: the alternative silently disables the assistant on every landscape
 * the moment this ships, which looks exactly like a bug and not like a setting.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  aiAssistanceEnabled, forgetCachedSettings, CACHE_TTL_MS, SINGLETON_ID
} = require('../srv/ai/availability');
const { askSapAiCore } = require('../srv/ai/business-partner-assistant');
const { parseIntent } = require('../srv/ai/intent');
const { proposeNormalisations } = require('../srv/checks/normalise');

/** A client whose use is a test failure: the switch is meant to stop us reaching it. */
const forbiddenClient = function () {
  throw new Error('a language model was contacted while AI assistance was off');
};

const withBinding = { AICORE_SERVICE_KEY: '{}' };

test('the settings row decides, and only an explicit false switches AI off', async (t) => {
  t.afterEach(forgetCachedSettings);

  forgetCachedSettings();
  assert.equal(await aiAssistanceEnabled({ read: async () => ({ aiAssistanceEnabled: false }) }), false);

  forgetCachedSettings();
  assert.equal(await aiAssistanceEnabled({ read: async () => ({ aiAssistanceEnabled: true }) }), true);

  // No row at all: an installation that never opened the settings page.
  forgetCachedSettings();
  assert.equal(await aiAssistanceEnabled({ read: async () => null }), true);

  // A row written before the column existed reads as undefined, not as off.
  forgetCachedSettings();
  assert.equal(await aiAssistanceEnabled({ read: async () => ({}) }), true);
});

test('an unreadable setting leaves AI on, and is retried rather than cached', async () => {
  forgetCachedSettings();
  let reads = 0;
  const failing = async () => {
    reads += 1;
    throw new Error('database is down');
  };

  assert.equal(await aiAssistanceEnabled({ read: failing }), true);
  assert.equal(await aiAssistanceEnabled({ read: failing }), true);
  // Cached, and the outage would look to the user like AI had been switched off.
  assert.equal(reads, 2, 'a failed read must not be remembered');
  forgetCachedSettings();
});

test('the setting is cached, and a write is visible immediately', async () => {
  forgetCachedSettings();
  let reads = 0;
  const read = async () => {
    reads += 1;
    return { aiAssistanceEnabled: false };
  };

  const start = 1_000_000;
  assert.equal(await aiAssistanceEnabled({ read, now: start }), false);
  assert.equal(await aiAssistanceEnabled({ read, now: start + CACHE_TTL_MS - 1 }), false);
  assert.equal(reads, 1, 'the hot path re-read a setting that changes a few times a year');

  // Past the TTL it is read again, so a change made elsewhere lands without a restart.
  assert.equal(await aiAssistanceEnabled({ read, now: start + CACHE_TTL_MS + 1 }), false);
  assert.equal(reads, 2);

  // And dropping the cache is what makes the steward's own next request see the change.
  forgetCachedSettings();
  assert.equal(await aiAssistanceEnabled({ read, now: start + CACHE_TTL_MS + 2 }), false);
  assert.equal(reads, 3);
  forgetCachedSettings();
});

test('with AI off the assistant answers from S/4 and contacts no model', async () => {
  const answer = await askSapAiCore({
    question: 'How many partners are in Belgium?',
    partners: [],
    addresses: [],
    fallbackAnswer: 'Two Business Partners are in Belgium.',
    externalResearch: null,
    duplicateCandidates: [],
    conversationHistory: [],
    totalBusinessPartners: 2,
    aiEnabled: false,
    // The binding exists: it is the switch that has to stop this, not a missing service.
    env: withBinding,
    Client: forbiddenClient
  });

  assert.equal(answer.Answer, 'Two Business Partners are in Belgium.');
  assert.equal(answer.Provider, 'S/4HANA search');
});

test('the switch is enforced on the server, not only drawn in the UI', () => {
  const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  // Each model call site consults the flag alongside the binding check.
  for (const file of [
    'srv/ai/business-partner-assistant.js', 'srv/ai/intent.js', 'srv/checks/normalise.js'
  ]) {
    assert.match(
      source(file), /!aiEnabled \|\| !hasAiCoreBinding\(env\)/u,
      `${file} calls a model without consulting the switch`
    );
  }

  // And the flag reaches them from the service layer rather than defaulting to true there.
  // Asserted on the call, not just the import: aiEnabled defaults to true inside
  // askSapAiCore, so a merge that drops the argument leaves AI quietly on with no
  // other symptom.
  const bpService = source('srv/business-partner-service.js');
  assert.match(bpService, /const aiEnabled = await aiAssistanceEnabled\(\);/u);
  assert.match(
    bpService, /await askSapAiCore\(\{[\s\S]*?aiEnabled\s*\}\);/u,
    'the assistant call does not pass aiEnabled'
  );
  assert.match(bpService, /aiAssistanceEnabled: await aiAssistanceEnabled\(\)/u);
  assert.match(source('srv/change-request-service.js'), /aiEnabled: await aiAssistanceEnabled\(\)/u);

  // Writing it needs the Admin scope the config service requires (it was Steward until
  // 2026-09-03); the main service only reports it.
  const configService = source('srv/duplicate-config-service.cds');
  assert.match(configService, /action setAiAssistanceEnabled/u);
  assert.doesNotMatch(
    source('srv/business-partner-service.cds'), /setAiAssistanceEnabled/u,
    'the unrestricted service must not be able to flip the switch'
  );
});

test('with AI off the assistant is withdrawn, not quietly answered without a model', () => {
  const reuse = path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');
  const readApp = (...parts) => fs.readFileSync(path.join(reuse, ...parts), 'utf8');
  // The manifest and the Fiori Elements actions stayed in the app; only the screen moved.
  const bpApp = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
  const readBp = (...parts) => fs.readFileSync(path.join(bpApp, ...parts), 'utf8');

  // Every way in is bound to the flag: the object page button and both Fiori Elements
  // actions. One left hardcoded visible is a button an installation may not use.
  assert.match(
    readApp('view', 'BusinessPartnerMaintenance.view.xml'),
    /text="Ask Assistant"[\s\S]*?visible="\{perm>\/aiAssistanceEnabled\}"/u
  );
  const manifest = JSON.parse(readBp('manifest.json'));
  const actions = [
    manifest['sap.ui5'].routing.targets.BusinessPartnersList
      .options.settings.controlConfiguration['@com.sap.vocabularies.UI.v1.LineItem']
      .actions.BusinessPartnerAssistant,
    manifest['sap.ui5'].routing.targets.BusinessPartnersObjectPage
      .options.settings.content.header.actions.BusinessPartnerAssistantHeader
  ];
  for (const action of actions) {
    // A plain property binding, not an expression binding: `visible` on a Fiori Elements
    // custom action does not reliably evaluate `{= ... }`, which is why the button stayed
    // on screen the first time. The Change Requests action in this same manifest has been
    // using the plain form against this very model all along.
    assert.equal(action.visible, '{perm>/aiAssistanceEnabled}');
  }

  // And both launchers ask before opening, for a binding that never evaluated.
  assert.match(readApp('BusinessPartnerAssistant.js'), /isAvailable: function \(view\)/u);
  assert.match(readBp('ext', 'CustomActions.js'), /if \(!BusinessPartnerAssistant\.isAvailable\(/u);
  assert.match(
    readApp('controller', 'BusinessPartnerMaintenance.controller.js'),
    /if \(!BusinessPartnerAssistant\.isAvailable\(this\.getView\(\)\)\) return;/u
  );

  // The lock behind all of that: the action is callable by anything holding the URL.
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'srv', 'business-partner-service.js'), 'utf8'),
    /if \(!await aiAssistanceEnabled\(\)\) \{\s*\n\s*return req\.reject\(403/u
  );

  // Both apps start the flag false, so no load ever briefly offers an assistant the
  // installation may not use. It appears a moment later where AI is on, which is the
  // harmless direction - the same call isDataSteward already makes for its own button.
  // The gating flag differs per app: the partner app reports the workflow's data steward, the
  // configuration panel moved to this app's own Admin role (2026-09-03). What is pinned is that
  // BOTH start false, which is the thing that matters here.
  for (const [app, gate] of [['businesspartner', 'isDataSteward'], ['mdmrules', 'isAdmin']]) {
    const component = fs.readFileSync(
      path.join(__dirname, '..', 'app', app, 'webapp', 'Component.js'), 'utf8'
    );
    assert.match(
      component, new RegExp(`${gate}: false, aiAssistanceEnabled: false`, 'u'),
      `${app} offers the assistant before it knows whether it may`
    );
    // But only an explicit false from the service keeps it off, so a service too old to
    // report the flag does not disable the assistant everywhere.
    assert.match(component, /result\.aiAssistanceEnabled !== false/u);
  }
});

test('the settings row is a singleton', async () => {
  const cds = require('@sap/cds');
  const model = cds.linked(await cds.load(path.join(__dirname, '..', 'db')));
  const entity = model.definitions['mdmlight.config.FeatureSettings'];

  assert.ok(entity, 'FeatureSettings is not in the model');
  const keys = Object.entries(entity.elements)
    .filter(([, element]) => element.key)
    .map(([name]) => name);
  assert.deepEqual(keys, ['ID']);
  assert.equal(entity.elements.aiAssistanceEnabled.type, 'cds.Boolean');
  // The default has to be permissive on the column too: a row inserted by anything
  // other than the action must not read as "AI off".
  assert.equal(entity.elements.aiAssistanceEnabled.default.val, true);
  assert.equal(SINGLETON_ID, 'SINGLETON');
});
