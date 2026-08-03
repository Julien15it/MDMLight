'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aiCoreFallbackReason,
  aiCoreErrorText,
  aiModelNames,
  askSapAiCore,
  chatCompletionWithRetry,
  hasAiCoreBinding,
  promptContext,
  relevantPartners
} = require('../srv/ai/business-partner-assistant');

const partners = [
  {
    BusinessPartner: '1',
    BusinessPartnerFullName: 'Brussels Pharmaceuticals SA/NV',
    BusinessPartnerCategory: '2',
    BusinessPartnerGrouping: '0001',
    BusinessPartnerIsBlocked: false,
    TaxNumber1: 'must-never-enter-the-prompt'
  },
  {
    BusinessPartner: '2',
    BusinessPartnerFullName: 'SAP S.E.',
    BusinessPartnerCategory: '2',
    BusinessPartnerGrouping: '0001'
  }
];

test('AI Core binding detection supports Cloud Foundry and local service keys', () => {
  assert.equal(hasAiCoreBinding({}), false);
  assert.equal(hasAiCoreBinding({ AICORE_SERVICE_KEY: '{}' }), true);
  assert.equal(hasAiCoreBinding({
    VCAP_SERVICES: JSON.stringify({ aicore: [{ credentials: { clientid: 'x' } }] })
  }), true);
});

test('AI Core model configuration provides resilient, configurable fallbacks', () => {
  assert.deepEqual(aiModelNames({
    AICORE_MODEL: 'gpt-5',
    AICORE_FALLBACK_MODELS: 'gpt-5-mini,anthropic--claude-4.5-haiku,gpt-5-mini'
  }), ['gpt-5', 'gpt-5-mini', 'anthropic--claude-4.5-haiku']);
  assert.deepEqual(aiModelNames({
    AICORE_MODEL: 'gpt-5-mini',
    AICORE_FALLBACK_MODELS: ''
  }), ['gpt-5-mini']);
});

test('AI Core fallback reports whether deployment, model or authorization failed', () => {
  assert.equal(
    aiCoreFallbackReason(new Error('Deployment not found'), { AICORE_RESOURCE_GROUP: 'default' }),
    'orchestration deployment unavailable in resource group default'
  );
  assert.equal(
    aiCoreFallbackReason(new Error('Model is not available'), {}),
    'configured models unavailable or restricted'
  );
  assert.equal(
    aiCoreFallbackReason(new Error('HTTP 403 Forbidden'), {}),
    'AI Core authorization failed'
  );
  assert.equal(
    aiCoreFallbackReason({ message: 'Request failed', response: { status: 429 } }, {}),
    'AI Core model rate limit reached'
  );
  assert.equal(
    aiCoreFallbackReason({
      message: 'Request failed',
      cause: { message: 'HTTP request failed', cause: { response: { status: 401 } } }
    }, {}),
    'AI Core authorization failed'
  );
  assert.equal(
    aiCoreFallbackReason(new Error('Could not resolve aicore service binding'), {}),
    'AI Core service binding unavailable'
  );
  assert.equal(
    aiCoreErrorText({ message: 'Request failed', cause: { message: 'Deployment not found' } }),
    'Request failed | Deployment not found'
  );
});

test('AI Core retries one fast transient request failure', async () => {
  let calls = 0;
  const client = {
    chatCompletion: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Request failed');
      return { getContent: () => 'Recovered' };
    }
  };

  const result = await chatCompletionWithRetry(client, {}, {});
  assert.equal(result.response.getContent(), 'Recovered');
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test('AI prompt context is bounded and excludes sensitive fields', () => {
  assert.deepEqual(relevantPartners('Show BP 1', partners).map((item) => item.BusinessPartner), ['1']);
  assert.deepEqual(relevantPartners('Does Intellus exist?', partners), []);
  assert.deepEqual(relevantPartners('Hello', partners), []);
  const context = promptContext('Show BP 1', partners, []);
  assert.match(context, /"totalBusinessPartners":2/);
  assert.doesNotMatch(
    promptContext('Hello', [], [], null, [], [], null),
    /totalBusinessPartners/
  );
  assert.match(context, /Brussels Pharmaceuticals/);
  assert.doesNotMatch(context, /TaxNumber1|must-never-enter/);
});

test('AI prompt context finds partners by address and includes sourced research', () => {
  const addresses = [{
    BusinessPartner: '2',
    AddressID: '10',
    StreetName: 'Dorpstraat',
    CityName: 'Brussel',
    IBAN: 'must-never-enter-the-prompt'
  }];
  assert.deepEqual(
    relevantPartners('Find Dorpstraat', partners, addresses).map((item) => item.BusinessPartner),
    ['2']
  );
  const context = promptContext(
    'Tell me about company Coca-Cola',
    partners,
    addresses,
    {
      title: 'Coca-Cola',
      description: 'beverage company',
      extract: 'Public company summary.',
      url: 'https://en.wikipedia.org/wiki/Coca-Cola'
    },
    [],
    [{ role: 'user', content: 'Tell me about that company.' }]
  );
  assert.match(context, /Public company summary/);
  assert.match(context, /Tell me about that company/);
  assert.doesNotMatch(context, /Brussels Pharmaceuticals|SAP S\.E\./);
  assert.doesNotMatch(context, /IBAN|must-never-enter/);
});

test('assistant uses SAP AI Core when bound and reports its provider', async () => {
  let captured;
  class MockOrchestrationClient {
    constructor(config, deployment) {
      captured = { config, deployment };
    }

    async chatCompletion(request) {
      captured.request = request;
      return { getContent: () => 'There are two partners in the supplied context.' };
    }
  }

  const result = await askSapAiCore({
    question: 'How many partners are there?',
    partners,
    addresses: [],
    fallbackAnswer: 'fallback',
    env: {
      AICORE_SERVICE_KEY: '{}',
      AICORE_MODEL: 'gpt-5',
      AICORE_FALLBACK_MODELS: '',
      AICORE_RESOURCE_GROUP: 'default'
    },
    Client: MockOrchestrationClient
  });

  assert.deepEqual(result, {
    Answer: 'There are two partners in the supplied context.',
    Provider: 'SAP AI Core (gpt-5)'
  });
  assert.equal(captured.config.promptTemplating.model.name, 'gpt-5');
  assert.equal(captured.deployment.resourceGroup, 'default');
  assert.match(captured.request.placeholderValues.context, /"totalBusinessPartners":2/);
  assert.doesNotMatch(captured.request.placeholderValues.context, /SAP S\.E\./);
});

test('assistant keeps a deterministic S/4 fallback without an AI binding', async () => {
  const result = await askSapAiCore({
    question: 'How many?',
    partners,
    addresses: [],
    fallbackAnswer: 'There are 2 Business Partners.',
    env: {}
  });

  assert.deepEqual(result, {
    Answer: 'There are 2 Business Partners.',
    Provider: 'S/4HANA search'
  });
});
