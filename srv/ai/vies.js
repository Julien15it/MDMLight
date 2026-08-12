'use strict';

const { fetchJson } = require('./company-research');

const VIES_API = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms/';

// VIES uses EL for Greece, not the ISO GR, and XI for Northern Ireland.
const VIES_COUNTRY_CODES = Object.freeze({ GR: 'EL' });

const VIES_COUNTRIES = Object.freeze(new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR',
  'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI',
  'SK', 'XI'
]));

const STATUS = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  UNKNOWN: 'unknown',
  NOT_APPLICABLE: 'not_applicable'
});

function viesCountryCode(country) {
  const code = String(country || '').trim().toLocaleUpperCase().slice(0, 2);
  return VIES_COUNTRY_CODES[code] || code;
}

// A VAT number may or may not carry its own prefix; VIES wants the national part only.
function nationalNumber(vatNumber, countryCode) {
  const cleaned = String(vatNumber || '').replace(/[^\p{L}\p{N}]+/gu, '').toLocaleUpperCase();
  return cleaned.startsWith(countryCode) ? cleaned.slice(countryCode.length) : cleaned;
}

/**
 * `isValid` alone is not the answer. A throttled or unreachable member state also returns
 * `isValid: false` — observed live as `MS_MAX_CONCURRENT_REQ`. Reading the flag on its own would
 * report a perfectly good VAT number as invalid and raise a false finding on the change request.
 */
function statusFrom(body) {
  const userError = String(body?.userError || '').trim().toLocaleUpperCase();
  if (body?.isValid === true) return STATUS.VALID;
  if (userError === 'INVALID' || userError === 'VALID') return STATUS.INVALID;
  return STATUS.UNKNOWN;
}

function isPlaceholder(value) {
  const text = String(value || '').trim();
  return !text || /^-+$/u.test(text);
}

/**
 * Member states format the address themselves and many return none at all — Germany never does.
 * Parse best-effort, always keep the raw text, and never let a parse miss look like missing data.
 */
function parseAddress(address, country) {
  if (isPlaceholder(address)) return null;
  const lines = String(address).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const last = lines.length > 1 ? lines.at(-1) : '';
  const postalCity = last.match(/^(\S{3,10})\s+(.+)$/u);
  return {
    StreetName: (postalCity ? lines.slice(0, -1) : lines).join(' '),
    PostalCode: postalCity ? postalCity[1] : '',
    CityName: postalCity ? postalCity[2] : '',
    Country: String(country || '').toLocaleUpperCase()
  };
}

/**
 * Validates a VAT number and, where the member state permits, returns the registered name. It
 * cannot search by name, so it enriches a candidate that already has a number — it never finds one.
 */
async function checkVatNumber(country, vatNumber, options = {}) {
  const countryCode = viesCountryCode(country);
  const national = nationalNumber(vatNumber, countryCode);
  const base = { source: 'VIES', countryCode, vatNumber: national };
  if (!countryCode || !national) return { ...base, status: STATUS.UNKNOWN, reason: 'incomplete_input' };
  if (!VIES_COUNTRIES.has(countryCode)) return { ...base, status: STATUS.NOT_APPLICABLE };

  const url = new URL(`${encodeURIComponent(countryCode)}/vat/${encodeURIComponent(national)}`, VIES_API);
  const body = await fetchJson(url, options);
  const status = statusFrom(body);
  return {
    ...base,
    status,
    reason: String(body?.userError || '').trim().toLocaleUpperCase(),
    name: isPlaceholder(body?.name) ? '' : String(body.name).trim(),
    address: status === STATUS.VALID ? parseAddress(body?.address, countryCode) : null,
    rawAddress: isPlaceholder(body?.address) ? '' : String(body.address).trim(),
    checkedAt: String(body?.requestDate || '')
  };
}

module.exports = {
  VIES_API,
  VIES_COUNTRIES,
  VIES_COUNTRY_CODES,
  STATUS,
  viesCountryCode,
  nationalNumber,
  statusFrom,
  parseAddress,
  checkVatNumber
};
