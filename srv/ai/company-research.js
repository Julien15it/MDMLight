'use strict';

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const PUBLIC_SEARCH_API = 'https://html.duckduckgo.com/html/';
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

async function fetchText(url, { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No HTTP client is available.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; MDMLight-BusinessPartnerAssistant/1.0)'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Internet search returned HTTP ${response.status}.`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;|&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
}

function publicResultUrl(value) {
  try {
    const decoded = decodeHtml(value);
    const url = new URL(decoded.startsWith('//') ? `https:${decoded}` : decoded);
    const target = url.hostname.endsWith('duckduckgo.com') ? url.searchParams.get('uddg') : url.href;
    if (!target) return '';
    const targetUrl = new URL(target);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) return '';
    return targetUrl.href;
  } catch {
    return '';
  }
}

function parsePublicSearchResults(html) {
  const titles = [...String(html || '').matchAll(
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu
  )];
  const snippets = [...String(html || '').matchAll(
    /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gu
  )];
  return titles.map((match, index) => ({
    url: publicResultUrl(match[1]),
    title: decodeHtml(match[2]),
    snippet: decodeHtml(snippets[index]?.[1])
  })).filter((result) => result.url && result.title).slice(0, 5);
}

function countryFromResult(result) {
  const text = `${result.title || ''} ${result.snippet || ''}`.toLocaleLowerCase();
  if (/\b(?:belgium|belgië|belgique)\b/u.test(text)) return 'BE';
  try {
    const suffix = new URL(result.url).hostname.split('.').at(-1).toLocaleLowerCase();
    return ({ be: 'BE', nl: 'NL', lu: 'LU', de: 'DE', fr: 'FR' })[suffix] || '';
  } catch {
    return '';
  }
}

function suggestedAddressFromResults(results = []) {
  const addressPattern = /((?:[\p{L}\p{M}'’.-]+\s+){0,3}[\p{L}\p{M}'’.-]*(?:straat|steenweg|laan|weg|lei|dreef|kaai|plein|avenue|street|road|boulevard|chaussée|rue))\s+(\d+[a-z]?)\s*,?\s*(\d{4,6})\s+([\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){0,2})/iu;
  for (const result of results) {
    const match = decodeHtml(result.snippet).match(addressPattern);
    if (!match) continue;
    const streetWords = match[1].trim().split(/\s+/u);
    const leadingNoise = new Set([
      'at', 'de', 'het', 'in', 'langs', 'located', 'op', 'our', 'shop', 'the', 'visit', 'winkel'
    ]);
    while (streetWords.length > 1 && leadingNoise.has(streetWords[0].toLocaleLowerCase())) {
      streetWords.shift();
    }
    return {
      StreetName: streetWords.join(' '),
      HouseNumber: match[2].trim(),
      PostalCode: match[3].trim(),
      CityName: match[4].trim().replace(/[,.]+$/u, ''),
      Country: countryFromResult(result)
    };
  }
  return null;
}

async function publicWebSearch(name, options) {
  const searchUrl = new URL(PUBLIC_SEARCH_API);
  searchUrl.search = new URLSearchParams({ q: `${name} company address` }).toString();
  return parsePublicSearchResults(await fetchText(searchUrl, options));
}

async function researchCompanyOnPublicWeb(name, options = {}) {
  const results = await publicWebSearch(name, options);
  if (!results.length) return null;
  const extract = results.slice(0, 3).map((result) => (
    `${result.title}${result.snippet ? ` - ${result.snippet}` : ''}`
  )).join('\n');
  return {
    title: results[0].title,
    description: 'Public web search result',
    extract: extract.slice(0, MAX_EXTRACT_LENGTH),
    url: results[0].url,
    source: 'Public web search',
    sources: results.slice(0, 3).map(({ title, url }) => ({ title, url })),
    suggestedAddress: suggestedAddressFromResults(results)
  };
}

/**
 * A supplementary address lookup for the Wikipedia branch, which has no structured address of its
 * own - the REST summary API is a prose extract, nothing more. Same DuckDuckGo snippet search the
 * public-web fallback already runs, as its own call: Wikipedia winning the company description does
 * not mean an address was ever looked for, and Wikipedia is the branch a well-known company always
 * takes, so without this a whole class of companies could never get an address suggested at all.
 * Best-effort like every other lookup in this module - a failure here must not cost the Wikipedia
 * result it was only ever meant to enrich.
 */
async function addressFromPublicWeb(name, options) {
  try {
    return suggestedAddressFromResults(await publicWebSearch(name, options));
  } catch {
    return null;
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

  try {
    const search = await fetchJson(searchUrl, options);
    const result = search?.query?.search?.[0];
    if (!result?.title) return researchCompanyOnPublicWeb(companyName, options);

    const summary = await fetchJson(
      `${WIKIPEDIA_SUMMARY_API}${encodeURIComponent(result.title.replaceAll(' ', '_'))}`,
      options
    );
    const extract = String(summary?.extract || '').trim();
    if (!extract) return researchCompanyOnPublicWeb(companyName, options);

    return {
      title: String(summary.title || result.title),
      description: String(summary.description || '').trim(),
      extract: extract.slice(0, MAX_EXTRACT_LENGTH),
      url: summary?.content_urls?.desktop?.page
        || `https://en.wikipedia.org/wiki/${encodeURIComponent(result.title.replaceAll(' ', '_'))}`,
      source: 'Wikipedia',
      // See addressFromPublicWeb - Wikipedia's own summary carries no structured address.
      suggestedAddress: await addressFromPublicWeb(companyName, options)
    };
  } catch {
    return researchCompanyOnPublicWeb(companyName, options);
  }
}

module.exports = {
  MAX_EXTRACT_LENGTH,
  decodeHtml,
  fetchJson,
  fetchText,
  parsePublicSearchResults,
  publicResultUrl,
  suggestedAddressFromResults,
  researchCompanyOnPublicWeb,
  addressFromPublicWeb,
  researchCompany
};
