'use strict';

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const MAX_EXTRACT_LENGTH = 1800;

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No HTTP client is available.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MDMLight-BusinessPartnerAssistant/1.0'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Internet lookup returned HTTP ${response.status}.`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function researchCompany(name, options = {}) {
  const companyName = String(name || '').trim();
  if (!companyName) return null;

  const searchUrl = new URL(WIKIPEDIA_API);
  searchUrl.search = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: `${companyName} company`,
    srlimit: '5',
    utf8: '1',
    format: 'json',
    origin: '*'
  }).toString();

  const search = await fetchJson(searchUrl, options);
  const result = search?.query?.search?.[0];
  if (!result?.title) return null;

  const summary = await fetchJson(
    `${WIKIPEDIA_SUMMARY_API}${encodeURIComponent(result.title.replaceAll(' ', '_'))}`,
    options
  );
  const extract = String(summary?.extract || '').trim();
  if (!extract) return null;

  return {
    title: String(summary.title || result.title),
    description: String(summary.description || '').trim(),
    extract: extract.slice(0, MAX_EXTRACT_LENGTH),
    url: summary?.content_urls?.desktop?.page
      || `https://en.wikipedia.org/wiki/${encodeURIComponent(result.title.replaceAll(' ', '_'))}`
  };
}

module.exports = {
  MAX_EXTRACT_LENGTH,
  fetchJson,
  researchCompany
};
