'use strict';

const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_RESOURCE_GROUP = 'default';
const MAX_CONTEXT_PARTNERS = 250;

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
    const client = new OrchestrationClient({
      promptTemplating: {
        model: {
          name: env.AICORE_MODEL || DEFAULT_MODEL,
          params: {
            max_tokens: 900
          }
        },
        prompt: {
          template: [
            {
              role: 'system',
              content: [
                'You are the Business Partner Assistant inside an SAP Fiori application.',
                'For S/4HANA status and master data, answer only from the supplied live S/4HANA JSON context.',
                'For a general question about a public company, you may add concise general model knowledge, but clearly label it as general information and never present it as S/4HANA data.',
                'If the requested company is absent from the S/4HANA context, say so and propose creating it as a new Business Partner.',
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
    if (!answer) throw new Error('SAP AI Core returned an empty answer.');
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
