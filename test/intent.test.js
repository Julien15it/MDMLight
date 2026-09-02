'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  intentConfig,
  intentModelName,
  parseIntent,
  parseIntentJson,
  sanitizeIntent,
  useModelIntent
} = require('../srv/ai/intent');
const BusinessPartnerService = require('../srv/business-partner-service');

const { resolveQuestionIntent, companyNameFromHistory } = BusinessPartnerService._internals;

const BOUND = { AICORE_SERVICE_KEY: '{}', AICORE_RESOURCE_GROUP: 'default' };

const answering = (content) => class {
  async chatCompletion() {
    return { getContent: () => content };
  }
};

const VALID = JSON.stringify({
  intent: 'duplicate_check',
  companyName: 'Alluvion',
  searchTerms: ['alluvion'],
  referencesPriorTurn: false
});

test('the model path is off unless it is switched on', () => {
  assert.equal(useModelIntent({}), false);
  assert.equal(useModelIntent({ ASSISTANT_INTENT_SOURCE: 'regex' }), false);
  assert.equal(useModelIntent({ ASSISTANT_INTENT_SOURCE: 'model' }), true);
  assert.equal(useModelIntent({ ASSISTANT_INTENT_SOURCE: 'MODEL' }), true);
});

// A small model keeps the extra call cheap; a reasoning model would spend the budget before answering.
test('intent parsing asks a small model for schema-enforced JSON', () => {
  assert.equal(intentModelName({}), 'anthropic--claude-4.5-haiku');
  assert.equal(intentModelName({ AICORE_INTENT_MODEL: 'gpt-5-mini' }), 'gpt-5-mini');

  const { prompt, model } = intentConfig('anthropic--claude-4.5-haiku', 600).promptTemplating;
  assert.equal(prompt.response_format.type, 'json_schema');
  assert.equal(prompt.response_format.json_schema.strict, true);
  assert.deepEqual(
    prompt.response_format.json_schema.schema.required,
    ['intent', 'companyName', 'searchTerms', 'referencesPriorTurn']
  );
  assert.equal(model.params.temperature, 0);
  assert.equal(model.params.max_tokens, 600);
  // Reasoning models reject a temperature and need the completion-token budget instead.
  const reasoning = intentConfig('gpt-5-mini', 600).promptTemplating.model;
  assert.equal(reasoning.params.temperature, undefined);
  assert.equal(reasoning.params.max_completion_tokens, 600);
});

test('a schema-shaped answer becomes a bounded intent', async () => {
  let captured;
  class Client {
    constructor(config, deployment) { captured = { config, deployment }; }

    async chatCompletion(request) {
      captured.request = request;
      return { getContent: () => VALID };
    }
  }

  const intent = await parseIntent({
    question: 'does the company Alluvion already exist in our system?',
    conversationHistory: [{ role: 'user', content: 'hello' }],
    env: BOUND,
    Client
  });

  assert.deepEqual(intent, {
    intent: 'duplicate_check',
    companyName: 'Alluvion',
    searchTerms: ['alluvion'],
    referencesPriorTurn: false
  });
  assert.equal(captured.deployment.resourceGroup, 'default');
  assert.match(captured.request.placeholderValues.question, /Alluvion/u);
  assert.match(captured.request.placeholderValues.history, /user: hello/u);
});

// Every failure has to degrade to the pattern parser rather than break the assistant.
test('null is returned whenever the model cannot be trusted or reached', async () => {
  const unbound = await parseIntent({ question: 'Alluvion?', env: {}, Client: answering(VALID) });
  assert.equal(unbound, null);

  const empty = await parseIntent({ question: '   ', env: BOUND, Client: answering(VALID) });
  assert.equal(empty, null);

  const malformed = await parseIntent({
    question: 'Alluvion?', env: BOUND, Client: answering('sorry, I cannot do that')
  });
  assert.equal(malformed, null);

  // Unauthorized classifies as non-retryable, so this asserts the fallback without paying for two backoffs.
  class Broken {
    async chatCompletion() { throw new Error('unauthorized'); }
  }
  const threw = await parseIntent({ question: 'Alluvion?', env: BOUND, Client: Broken });
  assert.equal(threw, null);
});

// The parsed name reaches an OData filter, so nothing arrives unbounded or untyped.
test('model output is clamped, de-duplicated and type-checked', () => {
  const dirty = sanitizeIntent({
    intent: 'delete_everything',
    companyName: `${'A'.repeat(200)}`,
    searchTerms: ['Alluvion', 'ALLUVION', '', 'x'.repeat(90), ...Array.from({ length: 20 }, (u, i) => `t${i}`)],
    referencesPriorTurn: 'yes'
  });

  assert.equal(dirty.intent, 'other');
  assert.equal(dirty.companyName.length, 80);
  assert.equal(dirty.searchTerms.length, 8);
  assert.equal(dirty.searchTerms[0], 'alluvion');
  assert.ok(dirty.searchTerms.every((term) => term.length <= 40));
  assert.equal(dirty.referencesPriorTurn, false);
  assert.equal(sanitizeIntent({ companyName: '   ' }).companyName, null);
});

test('a model intent wins over the patterns that used to guess', () => {
  const resolved = resolveQuestionIntent('any companies named Alluvion in our system?', [], {
    intent: 'duplicate_check',
    companyName: 'Alluvion',
    searchTerms: ['alluvion'],
    referencesPriorTurn: false
  });

  assert.equal(resolved.source, 'model');
  assert.equal(resolved.companyName, 'Alluvion');
  assert.deepEqual(resolved.searchTerms, ['alluvion']);
  assert.equal(resolved.asksAggregate, false);
});

test('a follow-up takes its name from the earlier turn, and small talk reads nothing', () => {
  const history = [
    { role: 'user', content: 'Is there a Business Partner called Spar Destelbergen?' },
    { role: 'assistant', content: 'No matching Business Partner was found.' }
  ];
  assert.equal(companyNameFromHistory(history), 'Spar Destelbergen');

  const followUp = resolveQuestionIntent('yes please, make it', history, {
    intent: 'create', companyName: null, searchTerms: [], referencesPriorTurn: true
  });
  assert.equal(followUp.companyName, 'Spar Destelbergen');

  const greeting = resolveQuestionIntent('Hallo', [], {
    intent: 'smalltalk', companyName: null, searchTerms: [], referencesPriorTurn: false
  });
  assert.equal(greeting.isSmalltalk, true);
  assert.equal(greeting.companyName, '');
});
