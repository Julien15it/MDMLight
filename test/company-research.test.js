'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { researchCompany } = require('../srv/ai/company-research');

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
  assert.equal(result.url, 'https://en.wikipedia.org/wiki/Coca-Cola');
  assert.match(result.extract, /public beverage company/);
  assert.match(urls[0], /w\/api\.php/);
  assert.match(urls[1], /page\/summary\/Coca-Cola/);
});

test('company research returns null when no public result is found', async () => {
  const result = await researchCompany('Unknown Example', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ query: { search: [] } }) })
  });
  assert.equal(result, null);
});
