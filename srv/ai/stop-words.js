'use strict';

// One list for both the S/4 query terms and the prompt-context filter. When these drifted apart,
// words like "any" and "companies" survived into the context filter and emptied it.
const STOP_WORDS = Object.freeze(new Set([
  // English function words
  'a', 'an', 'about', 'all', 'already', 'and', 'any', 'are', 'as', 'at', 'be', 'business',
  'by', 'called', 'can', 'data', 'display', 'do', 'does', 'find', 'for', 'from',
  'get', 'give', 'has', 'have', 'hello', 'hey', 'hi', 'how', 'i', 'in', 'is',
  'it', 'list', 'many', 'me', 'my', 'name', 'named', 'of', 'on', 'or', 'our',
  'partner', 'partners', 'please', 'record', 'records', 'search', 'show',
  'tell', 'thank', 'thanks', 'that', 'the', 'their', 'there', 'this', 'to',
  'us', 'we', 'what', 'which', 'who', 'whose', 'with', 'you', 'your',
  // Dutch function words
  'aan', 'al', 'alle', 'alles', 'als', 'bedankt', 'bij', 'dank', 'de', 'die',
  'dit', 'door', 'een', 'en', 'er', 'geef', 'gegevens', 'hallo', 'heb',
  'hebben', 'heeft', 'het', 'hun', 'ik', 'je', 'kan', 'kun', 'kunt', 'laat',
  'lijst', 'met', 'mij', 'naam', 'niet', 'nog', 'om', 'ons', 'onze', 'op', 'over',
  'reeds', 'te', 'toon', 'tonen', 'uit', 'van', 'voor', 'wat', 'welke', 'wie', 'wil',
  'zie', 'zijn', 'zoek', 'zoeken',
  // Generic company and address nouns, never part of a partner name
  'address', 'addresses', 'adres', 'adressen', 'bedrijf', 'bedrijven', 'city',
  'companies', 'company', 'country', 'firma', 'gevestigd', 'info', 'informatie',
  'land', 'located', 'organisatie', 'organisaties', 'organization', 'organizations',
  'postal', 'postcode', 'regio', 'region', 'stad', 'straat', 'street',
  // Existence wording, which asks the question rather than naming the partner
  'aanwezig', 'available', 'beschikbaar', 'bestaan', 'bestaat', 'exist', 'existing',
  'exists', 'system', 'systeem', 'systems',
  // Words that select a report rather than name a partner
  'aantal', 'blocked', 'blokkade', 'categorie', 'category', 'count',
  'geblokkeerd', 'groep', 'groepering', 'grouping', 'hoeveel', 'total',
  'totaal'
]));

module.exports = { STOP_WORDS };
