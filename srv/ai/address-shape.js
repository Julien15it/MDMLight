'use strict';

/**
 * The one place a SUGGESTED address is shaped before it can reach a field.
 *
 * Every address the assistant offers comes from prose somebody else wrote: a VIES member state's
 * own formatting, GLEIF's free-text `addressLines`, or a DuckDuckGo snippet. None of the three is
 * a structured street/number pair, and each of them produced a real, reported value that was not
 * a street name at all (2026-09-08):
 *
 * - `StreetName: "situé a huistreet"` - the snippet matcher captured up to three words before the
 *   street-type word, and the French phrase that introduced the address came along with it.
 * - `StreetName: "huistreet+50"` - a URL-encoded fragment inside a snippet, read as a street.
 * - `StreetName: "Huistreet 50"` with `HouseNumber` empty - GLEIF joins its address lines and
 *   never separates the number, which S/4 keeps in a field of its own.
 *
 * So this module answers two questions and nothing else: **is this text a street name at all**, and
 * **is the house number hiding inside it**. It never invents, corrects or completes a value - a
 * street it cannot vouch for is DROPPED rather than proposed, because a wrong street quietly typed
 * into a create is worse than an empty one the requester fills in themselves.
 *
 * The postal code, city and country survive a dropped street: they are separately sourced and still
 * worth having.
 */

// S/4's own column widths (db/staging.cds, StagedAddresses). Clamped here as well as validated
// there, so a suggestion never arrives already too long for the field it lands in.
const LIMITS = Object.freeze({
  StreetName: 60, HouseNumber: 10, PostalCode: 10, CityName: 40, Country: 3, Region: 3
});

/**
 * A word that can only be INTRODUCING an address, never part of a street name: a verb, a
 * possessive, a kind of premises, or a preposition of place. These come off the front freely.
 */
const ADDRESS_INTRODUCERS = Object.freeze(new Set([
  // Dutch
  'gelegen', 'gevestigd', 'gehuisvest', 'adres', 'bezoekadres', 'bezoek', 'kantoor',
  'hoofdkantoor', 'vestiging', 'winkel', 'aan', 'op', 'te', 'bij', 'langs', 'ons', 'onze', 'is',
  'zijn',
  // French
  'situe', 'situee', 'situes', 'situees', 'sis', 'sise', 'adresse', 'bureau', 'magasin', 'siege',
  'notre', 'nos',
  // English
  'located', 'address', 'office', 'shop', 'store', 'visit', 'headquarters', 'hq', 'at', 'in',
  'our', 'the',
  // German
  'anschrift', 'ansassig', 'gelegene', 'bei', 'im', 'am', 'unser', 'unsere'
]));

/**
 * Articles and particles that come off only AFTER an introducer has already been stripped. They are
 * separated out because a street name may genuinely BEGIN with one - "De Keyserlei", "Le Grand Rue",
 * "Van Eycklei" - and a rule that stripped those unconditionally would quietly rename a real street.
 * Behind an introducer there is no such doubt: "situe a Huistreet" is not a street called "a
 * Huistreet".
 */
const ADDRESS_CONNECTORS = Object.freeze(new Set([
  'a', 'au', 'aux', 'das', 'de', 'den', 'der', 'die', 'du', 'het', 'la', 'le', 'les', 'of', 'on',
  'van'
]));

/** Accent- and punctuation-insensitive, so "situé," and "situe" are the same word. */
function fold(word) {
  return String(word).normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLocaleLowerCase();
}

const text = (value) => String(value === null || value === undefined ? '' : value)
  .replace(/\p{C}+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

/**
 * Characters and shapes that never occur in a street name and always mean the text came from
 * somewhere it should not have: a URL, a query string, HTML, an e-mail address. This is a REJECT
 * test, not a cleaning one - a value that trips it is not repaired, it is dropped, because whatever
 * produced it was not describing a street.
 */
const NOT_A_STREET = Object.freeze([
  /[+=&%#<>|\\/@_~^*$"`{}[\]]/u,
  /\bhttps?:/iu,
  /\bwww\./iu,
  /\.(?:com|net|org|be|nl|fr|de|lu|eu)\b/iu
]);

/** A street has to carry at least one word - "50" and "50-52" are numbers, not names. */
const HAS_A_WORD = /\p{L}{2,}/u;

/**
 * The street a value can be trusted to be, or `''`.
 *
 * The introducing phrase comes off first - the run of ADDRESS_INTRODUCERS, then any connectors
 * standing behind it - and what is left is judged whole: a value that still looks like it came out
 * of a URL is dropped rather than repaired.
 */
function cleanStreet(value) {
  const cleaned = text(value).replace(/^[\s,.;:-]+|[\s,.;:-]+$/gu, '');
  if (!cleaned) return '';

  const words = cleaned.split(' ');
  let introduced = false;
  while (words.length > 1 && ADDRESS_INTRODUCERS.has(fold(words[0]))) {
    words.shift();
    introduced = true;
  }
  // Only behind an introducer, and this is the whole reason the two sets are separate.
  while (introduced && words.length > 1 && ADDRESS_CONNECTORS.has(fold(words[0]))) words.shift();
  const street = words.join(' ').trim();

  if (!street || !HAS_A_WORD.test(street)) return '';
  if (NOT_A_STREET.some((pattern) => pattern.test(street))) return '';
  return street.slice(0, LIMITS.StreetName);
}

/**
 * The house number hiding at the end of a street name, as `{ StreetName, HouseNumber }`.
 *
 * Only a plain trailing number after a street carrying NO other digits - the same bar `parseAddress`
 * in vies.js already applies - so "Kerkstraat 12 bus 3" stays whole rather than being split into a
 * number that is not the whole number.
 */
function splitHouseNumber(street) {
  const value = text(street);
  const numbered = value.match(/^([^\d]*\p{L}[^\d]*?)[\s,]+(\d+[A-Za-z]?)$/u);
  if (!numbered) return { StreetName: value, HouseNumber: '' };
  return { StreetName: numbered[1].replace(/[\s,]+$/u, ''), HouseNumber: numbered[2] };
}

/**
 * A suggested address, shaped and vouched for. Returns `null` when nothing usable is left at all.
 *
 * The street and its number are one decision: a dropped street takes its number with it, because a
 * house number with no street is not something a requester can act on.
 */
function shapeSuggestedAddress(address) {
  if (!address || typeof address !== 'object') return null;

  const split = splitHouseNumber(address.StreetName);
  const street = cleanStreet(split.StreetName);
  // Whatever was already in its own field wins - only a street that was carrying the number gives
  // one up, and only into an empty field.
  const houseNumber = text(address.HouseNumber) || (street ? split.HouseNumber : '');

  const keep = (field, value) => (value ? { [field]: value.slice(0, LIMITS[field]) } : {});
  const shaped = {
    ...keep('StreetName', street),
    ...(street ? keep('HouseNumber', houseNumber) : {}),
    ...keep('PostalCode', text(address.PostalCode)),
    ...keep('CityName', text(address.CityName).replace(/[,.]+$/u, '')),
    ...keep('Country', text(address.Country).toLocaleUpperCase()),
    ...keep('Region', text(address.Region).toLocaleUpperCase())
  };
  return Object.keys(shaped).length ? shaped : null;
}

module.exports = {
  ADDRESS_CONNECTORS,
  ADDRESS_INTRODUCERS,
  LIMITS,
  cleanStreet,
  shapeSuggestedAddress,
  splitHouseNumber
};
