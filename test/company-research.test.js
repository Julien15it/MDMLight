'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePublicSearchResults,
  researchCompany
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

test('company research returns null when no public result is found', async () => {
  const result = await researchCompany('Unknown Example', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ query: { search: [] } }),
      text: async () => ''
    })
  });
  assert.equal(result, null);
});

test('company research falls back to public web results for a local company', async () => {
  const publicHtml = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fspar-destelbergen.be%2F">Spar Destelbergen</a>
    <a class="result__snippet">Your local fresh-food market in Destelbergen.</a>`;
  const result = await researchCompany('SPAR Destelbergen', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ query: { search: [] } }),
      text: async () => publicHtml
    })
  });

  assert.equal(result.source, 'Public web search');
  assert.equal(result.url, 'https://spar-destelbergen.be/');
  assert.match(result.extract, /fresh-food market/);
});

test('company research still uses public search when Wikipedia is unavailable', async () => {
  const result = await researchCompany('Local Example', {
    fetchImpl: async (url) => {
      if (String(url).includes('wikipedia')) throw new Error('Wikipedia unavailable');
      return {
        ok: true,
        text: async () => '<a class="result__a" href="https://example.com">Local Example</a>'
      };
    }
  });

  assert.equal(result.source, 'Public web search');
  assert.equal(result.url, 'https://example.com/');
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
