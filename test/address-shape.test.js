'use strict';

/**
 * A suggested address is prose somebody else wrote, and all three sources reach the same trap.
 * Reported live 2026-09-08 - three shapes, one module (srv/ai/address-shape.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ADDRESS_CONNECTORS, ADDRESS_INTRODUCERS, LIMITS,
  cleanStreet, shapeSuggestedAddress, splitHouseNumber
} = require('../srv/ai/address-shape');

// --- The three reported values ---------------------------------------------

test('the phrase introducing an address is not part of the street name', () => {
  assert.equal(cleanStreet('situé a huistreet'), 'huistreet');
  assert.equal(cleanStreet('Situé à Huistreet'), 'Huistreet');
  assert.equal(cleanStreet('Visit our shop at Edingensesteenweg'), 'Edingensesteenweg');
  assert.equal(cleanStreet('gelegen aan de Kerkstraat'), 'Kerkstraat');
  assert.equal(cleanStreet('Adresse: Rue de la Loi'), 'Rue de la Loi');
});

test('a value that came out of a URL is dropped, not repaired', () => {
  assert.equal(cleanStreet('huistreet+50'), '');
  assert.equal(cleanStreet('Huistreet%2050'), '');
  assert.equal(cleanStreet('https://example.be/contact'), '');
  assert.equal(cleanStreet('info@example.com'), '');
  assert.equal(cleanStreet('www.example.be'), '');
  // Nothing is left that a requester could act on, so the street and its number both go.
  assert.deepEqual(
    shapeSuggestedAddress({
      StreetName: 'huistreet+50', HouseNumber: '50', PostalCode: '9000', CityName: 'Gent', Country: 'be'
    }),
    { PostalCode: '9000', CityName: 'Gent', Country: 'BE' }
  );
});

test('a house number joined onto the street is split into its own field', () => {
  assert.deepEqual(splitHouseNumber('Huistreet 50'), { StreetName: 'Huistreet', HouseNumber: '50' });
  assert.deepEqual(splitHouseNumber('Begijnenvest 113'), { StreetName: 'Begijnenvest', HouseNumber: '113' });
  assert.deepEqual(splitHouseNumber('Rue de la Loi 16A'), { StreetName: 'Rue de la Loi', HouseNumber: '16A' });
});

// --- What must NOT happen --------------------------------------------------

/**
 * The reason the two word sets are separate. A street may genuinely begin with an article, and the
 * old snippet-only noise list stripped one unconditionally.
 */
test('a street that begins with an article keeps it', () => {
  assert.equal(cleanStreet('De Keyserlei'), 'De Keyserlei');
  assert.equal(cleanStreet('Le Grand Rue'), 'Le Grand Rue');
  assert.equal(cleanStreet('Van Eycklei'), 'Van Eycklei');
  // ...and only loses it behind an introducer, where there is no doubt.
  assert.equal(cleanStreet('gelegen aan De Keyserlei'), 'Keyserlei');
});

test('the two word sets do not overlap', () => {
  for (const word of ADDRESS_CONNECTORS) {
    assert.equal(ADDRESS_INTRODUCERS.has(word), false, `${word} is in both sets`);
  }
});

// Same bar vies.js's own parseAddress applied before this module existed: a number it cannot read
// cleanly stays part of the street rather than being guessed at.
test('only a plain trailing number is split off', () => {
  assert.deepEqual(splitHouseNumber('Kerkstraat 12 bus 3'), { StreetName: 'Kerkstraat 12 bus 3', HouseNumber: '' });
  assert.deepEqual(splitHouseNumber('Avenue Louise 149 boite 24'), { StreetName: 'Avenue Louise 149 boite 24', HouseNumber: '' });
  assert.deepEqual(splitHouseNumber('16 Rue de la Loi'), { StreetName: '16 Rue de la Loi', HouseNumber: '' });
  assert.deepEqual(splitHouseNumber('Koedreef'), { StreetName: 'Koedreef', HouseNumber: '' });
});

test('a number is never left standing without its street, and never overwrites one already given', () => {
  // The street is dropped, so its number goes with it.
  assert.equal(shapeSuggestedAddress({ StreetName: 'a+b', HouseNumber: '' }), null);
  // A number the source already put in its own field wins over one hiding in the street.
  assert.deepEqual(
    shapeSuggestedAddress({ StreetName: 'Kerkstraat 12', HouseNumber: '14' }),
    { StreetName: 'Kerkstraat', HouseNumber: '14' }
  );
});

test('a street with no word in it is not a street', () => {
  assert.equal(cleanStreet('50'), '');
  assert.equal(cleanStreet('50-52'), '');
  assert.equal(cleanStreet('  '), '');
  assert.equal(cleanStreet(null), '');
});

// --- Shape -----------------------------------------------------------------

test('empty fields are omitted rather than carried as blanks', () => {
  assert.deepEqual(
    shapeSuggestedAddress({ StreetName: 'Kerkstraat 12', PostalCode: '', CityName: 'Gent,', Country: 'be' }),
    { StreetName: 'Kerkstraat', HouseNumber: '12', CityName: 'Gent', Country: 'BE' }
  );
  assert.equal(shapeSuggestedAddress({}), null);
  assert.equal(shapeSuggestedAddress(null), null);
});

// db/staging.cds' own widths - `field_lengths` would refuse a longer value at Check, so a
// suggestion must not arrive already too long for the field it lands in.
test('every field is clamped to the staged column width', () => {
  const shaped = shapeSuggestedAddress({
    StreetName: 'K'.repeat(200),
    PostalCode: '9'.repeat(40),
    CityName: 'G'.repeat(200),
    Country: 'BELGIUM'
  });
  assert.equal(shaped.StreetName.length, LIMITS.StreetName);
  assert.equal(shaped.PostalCode.length, LIMITS.PostalCode);
  assert.equal(shaped.CityName.length, LIMITS.CityName);
  assert.equal(shaped.Country.length, LIMITS.Country);
});
