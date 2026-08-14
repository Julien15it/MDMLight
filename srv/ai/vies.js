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

// VIES throttles on concurrency and counts requests it is still working on, so answers are cached
// and a throttled one is retried: MS_MAX_CONCURRENT_REQ means "ask again in a moment", not "no".
const SETTLED_TTL_MS = 24 * 60 * 60 * 1000;
// Short, so fixing a number and re-checking re-asks, but three presses are not three requests.
const UNKNOWN_TTL_MS = 60 * 1000;
const RETRY_DELAY_MS = 1500;
const MAX_ATTEMPTS = 2;

// At 6s we aborted calls Belgium was still serving, and an abort does not stop VIES counting them.
const VIES_TIMEOUT_MS = 15000;

/** Reasons that mean "the answer is not available yet", as opposed to "the number is not valid". */
const RETRYABLE = Object.freeze(new Set([
  'MS_MAX_CONCURRENT_REQ',
  'GLOBAL_MAX_CONCURRENT_REQ',
  'MS_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT'
]));

const answers = new Map();

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
  const street = (postalCity ? lines.slice(0, -1) : lines).join(' ');
  // VIES sends "Koedreef 12" as one line while S/4 keeps the number apart. Only a plain trailing
  // number, so "Kerkstraat 12 bus 3" stays whole.
  const numbered = street.match(/^(\D+?)[\s,]+(\d+[A-Za-z]?)$/u);
  return {
    StreetName: numbered ? numbered[1] : street,
    HouseNumber: numbered ? numbered[2] : '',
    PostalCode: postalCity ? postalCity[1] : '',
    CityName: postalCity ? postalCity[2] : '',
    Country: String(country || '').toLocaleUpperCase()
  };
}

/** One request. A transport failure is an unknown answer, never a thrown error. */
async function askVies(base, countryCode, national, options) {
  const url = new URL(`${encodeURIComponent(countryCode)}/vat/${encodeURIComponent(national)}`, VIES_API);
  let body;
  try {
    body = await fetchJson(url, { timeoutMs: VIES_TIMEOUT_MS, ...options });
  } catch (error) {
    // A throw here reached runValidations, which blocks - so a 429 stopped the whole check.
    return {
      ...base,
      status: STATUS.UNKNOWN,
      reason: /abort/iu.test(error?.name || error?.message || '') ? 'TIMEOUT' : 'UNREACHABLE',
      detail: error?.message || 'VIES could not be reached.',
      name: '',
      address: null,
      rawAddress: '',
      checkedAt: ''
    };
  }
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

/**
 * Validates a VAT number and, where the member state permits, returns the registered name. It
 * cannot search by name, so it enriches a candidate that already has a number — it never finds one.
 */
async function checkVatNumber(country, vatNumber, options = {}) {
  const { now = Date.now, sleep = wait, attempts = MAX_ATTEMPTS, ...fetchOptions } = options;
  const countryCode = viesCountryCode(country);
  const national = nationalNumber(vatNumber, countryCode);
  const base = { source: 'VIES', countryCode, vatNumber: national };
  if (!countryCode || !national) return { ...base, status: STATUS.UNKNOWN, reason: 'incomplete_input' };
  if (!VIES_COUNTRIES.has(countryCode)) return { ...base, status: STATUS.NOT_APPLICABLE };

  const key = `${countryCode}|${national}`;
  const hit = answers.get(key);
  if (hit && hit.expires > now()) return hit.value;

  let answer;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    answer = await askVies(base, countryCode, national, fetchOptions);
    if (answer.status !== STATUS.UNKNOWN || !RETRYABLE.has(answer.reason)) break;
    if (attempt === Math.max(1, attempts)) break;
    console.warn(`[vies] ${key} answered ${answer.reason}; retrying in ${RETRY_DELAY_MS}ms.`);
    await sleep(RETRY_DELAY_MS);
  }
  if (answer.status === STATUS.UNKNOWN) {
    console.warn(`[vies] ${key} unresolved: ${answer.reason}${answer.detail ? ` (${answer.detail})` : ''}`);
  }
  answers.set(key, {
    value: answer,
    expires: now() + (answer.status === STATUS.UNKNOWN ? UNKNOWN_TTL_MS : SETTLED_TTL_MS)
  });
  return answer;
}

/** Tests, and anything that needs a genuinely fresh answer, start from an empty cache. */
function clearVatCache() {
  answers.clear();
}

module.exports = {
  VIES_API,
  VIES_COUNTRIES,
  VIES_COUNTRY_CODES,
  VIES_TIMEOUT_MS,
  RETRYABLE,
  RETRY_DELAY_MS,
  SETTLED_TTL_MS,
  UNKNOWN_TTL_MS,
  STATUS,
  viesCountryCode,
  nationalNumber,
  statusFrom,
  parseAddress,
  checkVatNumber,
  clearVatCache
};
