'use strict';

const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_RESOURCE_GROUP = 'default';
const DEFAULT_MAX_TOKENS = 4000;
const MAX_CONTEXT_PARTNERS = 60;

/**
 * gpt-5 and the o-series are reasoning models: their completion budget also
 * covers hidden reasoning tokens, and they expect max_completion_tokens rather
 * than max_tokens. A budget that is too small is spent entirely on reasoning
 * and the model then returns empty content instead of an error.
 */
function isReasoningModel(model) {
  return /^(gpt-5|o[1-9])/iu.test(String(model));
}

function modelParams(model, maxTokens) {
  return isReasoningModel(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

const SAFE_FIELDS = Object.freeze([
  'BusinessPartner',
  'BusinessPartnerFullName',
  'BusinessPartnerName',
  'BusinessPartnerCategory',
  'BusinessPartnerGrouping',
  'SearchTerm1',
  'SearchTerm2',
  'FirstName',
  'LastName',
  'OrganizationBPName1',
  'BusinessPartnerIsBlocked'
]);

function hasAiCoreBinding(env = process.env) {
  if (env.AICORE_SERVICE_KEY) return true;
  try {
    const services = JSON.parse(env.VCAP_SERVICES || '{}');
    return Object.entries(services).some(([label, instances]) => (
      /aicore/iu.test(label) && Array.isArray(instances) && instances.length > 0
    ));
  } catch {
    return false;
  }
}

function safePartner(partner) {
  return Object.fromEntries(
    SAFE_FIELDS
      .filter((field) => partner[field] !== undefined && partner[field] !== null && partner[field] !== '')
      .map((field) => [field, partner[field]])
  );
}

function relevantPartners(question, partners) {
  const normalized = String(question || '').toLocaleLowerCase();
  const numberMatch = normalized.match(/\b(?:bp|business partner|partner)\s*#?\s*(\d{1,10})\b/u);
  if (numberMatch) {
    return partners.filter((partner) => String(partner.BusinessPartner) === numberMatch[1]);
  }

  const directMatches = partners.filter((partner) => {
    const searchable = SAFE_FIELDS
      .map((field) => partner[field])
      .filter((value) => value !== undefined && value !== null)
      .join(' ')
      .toLocaleLowerCase();
    return normalized.split(/\s+/u).some((term) => term.length >= 4 && searchable.includes(term));
  });

  return (directMatches.length ? directMatches : partners).slice(0, MAX_CONTEXT_PARTNERS);
}

function promptContext(question, partners, addresses) {
  const relevant = relevantPartners(question, partners).map(safePartner);
  return JSON.stringify({
    totalBusinessPartners: partners.length,
    businessPartnersIncluded: relevant,
    addressesIncluded: Array.isArray(addresses) ? addresses.slice(0, 50) : []
  });
}

async function askSapAiCore({ question, partners, addresses, fallbackAnswer, env = process.env, Client }) {
  if (!hasAiCoreBinding(env)) {
    return { Answer: fallbackAnswer, Provider: 'S/4HANA search' };
  }

  try {
    const OrchestrationClient = Client
      || (await import('@sap-ai-sdk/orchestration')).OrchestrationClient;
    const model = env.AICORE_MODEL || DEFAULT_MODEL;
    const maxTokens = Number(env.AICORE_MAX_TOKENS) || DEFAULT_MAX_TOKENS;
    const client = new OrchestrationClient({
      promptTemplating: {
        model: {
          name: model,
          params: modelParams(model, maxTokens)
        },
        prompt: {
          template: [
            {
              role: 'system',
              content: [
                'You are the Business Partner Assistant inside an SAP Fiori application.',
                'Answer only from the supplied live S/4HANA JSON context.',
                'Never invent Business Partners or values and never claim to have changed S/4HANA.',
                'Only the explicitly supplied safe fields may be discussed; bank and tax data are not available.',
                'Answer in the same language as the user and keep the answer concise and business-friendly.',
                'If the context is insufficient, say exactly what is missing.'
              ].join(' ')
            },
            {
              role: 'user',
              content: 'Question: {{?question}}\n\nLive S/4HANA context:\n{{?context}}'
            }
          ]
        }
      }
    }, {
      resourceGroup: env.AICORE_RESOURCE_GROUP || DEFAULT_RESOURCE_GROUP
    });

    const response = await client.chatCompletion({
      placeholderValues: {
        question,
        context: promptContext(question, partners, addresses)
      }
    });
    const answer = String(response.getContent() || '').trim();
    if (!answer) {
      const finishReason = response.getFinishReason?.() ?? 'unknown';
      const usage = response.getTokenUsage?.() ?? {};
      throw new Error(
        `SAP AI Core returned an empty answer (model ${model}, finish_reason ${finishReason}, `
        + `tokens ${JSON.stringify(usage)}). If the budget was spent on reasoning, raise AICORE_MAX_TOKENS.`
      );
    }
    return { Answer: answer, Provider: 'SAP AI Core' };
  } catch (error) {
    console.warn('[assistant] SAP AI Core unavailable, using S/4HANA search fallback:', error.message);
    return { Answer: fallbackAnswer, Provider: 'S/4HANA search fallback' };
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_RESOURCE_GROUP,
  SAFE_FIELDS,
  hasAiCoreBinding,
  promptContext,
  relevantPartners,
  askSapAiCore
};
