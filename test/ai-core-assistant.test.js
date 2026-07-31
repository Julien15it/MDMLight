'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aiModelNames,
  askSapAiCore,
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
    AICORE_MODEL: 'gpt-5-mini',
    AICORE_FALLBACK_MODELS: 'gpt-5,anthropic--claude-4.5-haiku,gpt-5'
  }), ['gpt-5-mini', 'gpt-5', 'anthropic--claude-4.5-haiku']);
  assert.deepEqual(aiModelNames({
    AICORE_MODEL: 'gpt-5-mini',
    AICORE_FALLBACK_MODELS: ''
  }), ['gpt-5-mini']);
});

test('AI prompt context is bounded and excludes sensitive fields', () => {
  assert.deepEqual(relevantPartners('Show BP 1', partners).map((item) => item.BusinessPartner), ['1']);
  const context = promptContext('Show BP 1', partners, []);
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
    []
  );
  assert.match(context, /Public company summary/);
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
      AICORE_MODEL: 'gpt-5-mini',
      AICORE_FALLBACK_MODELS: '',
      AICORE_RESOURCE_GROUP: 'default'
    },
    Client: MockOrchestrationClient
  });

  assert.deepEqual(result, {
    Answer: 'There are two partners in the supplied context.',
    Provider: 'SAP AI Core'
  });
  assert.equal(captured.config.promptTemplating.model.name, 'gpt-5-mini');
  assert.equal(captured.deployment.resourceGroup, 'default');
  assert.match(captured.request.placeholderValues.context, /SAP S\.E\./);
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
