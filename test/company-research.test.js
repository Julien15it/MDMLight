'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePublicSearchResults,
  researchCompany,
  vatCandidatesFromResults,
  vatNumberFromPublicWeb
} = require('../srv/ai/company-research');

test('company research returns bounded public information and its source', async () => {
  const responses = [
    { query: { search: [{ title: 'Coca-Cola' }] } },
    {
      title: 'Coca-Cola',
      description: 'American beverage company',
      extract: 'Coca-Cola is a public beverage company.',
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Coca-Cola' } }
    }
  ];
  const urls = [];
  const result = await researchCompany('Coca-Cola', {
    fetchImpl: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => responses.shift()
      };
    }
  });

  assert.equal(result.title, 'Coca-Cola');
  assert.equal(result.source, 'Wikipedia');
  assert.equal(result.url, 'https://en.wikipedia.org/wiki/Coca-Cola');
  assert.match(result.extract, /public beverage company/);
  assert.match(urls[0], /w\/api\.php/);
  assert.match(urls[1], /page\/summary\/Coca-Cola/);
});

/**
 * Fixed 2026-08-26: the Wikipedia branch used to return no `suggestedAddress` at all - the REST
 * summary API is prose, not a structured address - so a well-known company (which always wins this
 * branch over the public-web fallback) could never get an address suggested, even though the chat
 * itself could describe the company in detail. A supplementary DuckDuckGo lookup fills the gap.
 */
test('a Wikipedia hit also gets a supplementary address from the public web', async () => {
  const responses = [
    { query: { search: [{ title: 'Colruyt Group' }] } },
    {
      title: 'Colruyt Group',
      description: 'Belgian retail company',
      extract: 'Colruyt Group is a Belgian retail company.',
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Colruyt_Group' } }
    }
  ];
  const result = await researchCompany('Colruyt Group', {
    fetchImpl: async (url) => {
      if (String(url).includes('duckduckgo')) {
        return {
          ok: true,
          text: async () => (
            '<a class="result__a" href="https://colruytgroup.be">Colruyt Group</a>'
            + '<a class="result__snippet">Visit our shop at Edingensesteenweg 196 1500 Halle.</a>'
          )
        };
      }
      return { ok: true, json: async () => responses.shift() };
    }
  });

  assert.equal(result.source, 'Wikipedia');
  assert.match(result.extract, /Belgian retail company/);
  assert.deepEqual(result.suggestedAddress, {
    StreetName: 'Edingensesteenweg',
    HouseNumber: '196',
    PostalCode: '1500',
    CityName: 'Halle',
    Country: 'BE'
  });
});

/** A failed or empty address lookup must not cost the Wikipedia result it was enriching. */
test('a Wikipedia hit survives an address lookup that finds or returns nothing', async () => {
  const responses = [
    { query: { search: [{ title: 'Example Corp' }] } },
    {
      title: 'Example Corp',
      description: 'A company',
      extract: 'Example Corp is a company.',
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Example_Corp' } }
    }
  ];
  const result = await researchCompany('Example Corp', {
    fetchImpl: async (url) => {
      if (String(url).includes('duckduckgo')) throw new Error('DuckDuckGo unavailable');
      return { ok: true, json: async () => responses.shift() };
    }
  });

  assert.equal(result.source, 'Wikipedia');
  assert.match(result.extract, /Example Corp is a company/);
  assert.equal(result.suggestedAddress, null);
});

test('company research falls back to public web results for a local company', async () => {
  const publicHtml = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fspar-destelbergen.be%2F">Spar Destelbergen</a>
    <a class="result__snippet">Visit our shop at Dendermondsesteenweg 468 9070 Destelbergen.</a>`;
  const result = await researchCompany('SPAR Destelbergen', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ query: { search: [] } }),
      text: async () => publicHtml
    })
  });

  assert.equal(result.source, 'Public web search');
  assert.equal(result.url, 'https://spar-destelbergen.be/');
  assert.match(result.extract, /Dendermondsesteenweg/);
  assert.deepEqual(result.suggestedAddress, {
    StreetName: 'Dendermondsesteenweg',
    HouseNumber: '468',
    PostalCode: '9070',
    CityName: 'Destelbergen',
    Country: 'BE'
  });
});

/**
 * vatNumberFromPublicWeb is deliberately ignorant of which two-letter codes VIES actually serves -
 * that trust decision belongs to business-partner-service.js's vatNumberFromWebSearch, which alone
 * owns the VIES call. This module only shapes candidates out of search snippets, so the same pattern
 * that matches a real VAT number also matches an unrelated two-letter-plus-digits token; that is by
 * design, filtered by the caller.
 */
test('vatCandidatesFromResults finds shaped candidates in titles and snippets, de-duplicated', () => {
  const results = [
    { title: 'Alluvion BV - BTW BE0403.200.393', snippet: 'Contact us' },
    { title: 'Alluvion', snippet: 'VAT number: BE 0403 200 393 - same company' },
    { title: 'Unrelated', snippet: 'Order ID12345678 shipped' }
  ];
  assert.deepEqual(vatCandidatesFromResults(results), [
    { country: 'BE', number: '0403200393' },
    { country: 'ID', number: '12345678' }
  ]);
});

test('vatCandidatesFromResults finds nothing in plain prose, and never throws on empty input', () => {
  assert.deepEqual(vatCandidatesFromResults([{ title: 'Alluvion', snippet: 'A software company in Gent' }]), []);
  assert.deepEqual(vatCandidatesFromResults([]), []);
  assert.deepEqual(vatCandidatesFromResults(), []);
});

test('vatNumberFromPublicWeb searches for the number and shapes what it finds', async () => {
  const html = `
    <a class="result__a" href="https://alluvion.eu">Alluvion - BTW BE0403.200.393</a>
    <a class="result__snippet">Software company in Gent.</a>`;
  let requestedUrl;
  const candidates = await vatNumberFromPublicWeb('Alluvion', {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return { ok: true, text: async () => html };
    }
  });
  assert.match(requestedUrl, /q=Alluvion(?:\+|%20)VAT(?:\+|%20)number/u);
  assert.deepEqual(candidates, [{ country: 'BE', number: '0403200393' }]);
});

test('vatNumberFromPublicWeb is best-effort: a failed search resolves to an empty list, never throws', async () => {
  const candidates = await vatNumberFromPublicWeb('Alluvion', {
    fetchImpl: async () => { throw new Error('DuckDuckGo unavailable'); }
  });
  assert.deepEqual(candidates, []);
});

test('public search parser ignores unsafe and malformed result links', () => {
  const results = parsePublicSearchResults(`
    <a class="result__a" href="javascript:alert(1)">Unsafe</a>
    <a class="result__a" href="https://example.com/company">Example Company</a>
    <a class="result__snippet">Trusted public snippet.</a>`);

  assert.deepEqual(results, [{
    url: 'https://example.com/company',
    title: 'Example Company',
    snippet: ''
  }]);
});
