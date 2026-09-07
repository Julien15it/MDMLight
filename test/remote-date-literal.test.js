'use strict';

/**
 * A date reaches S/4 as `/Date(<ms>)/`, and only on the CREATE path.
 *
 * Reported live 2026-09-07 (BP 645, straight after the create finally sent a validity date at all):
 * *"Conversion error for property 'ValidityStartDate' at offset '33'"*. A create is POSTed raw
 * through `s4.send` with a navigation path, so nothing between the payload and the gateway looks at
 * the target's types - the `'2026-09-07'` `createDefaults` produces went out as a plain string and
 * offset 33 landed on it. `/Date(<ms>)/` is the form S/4 itself emits for these properties, which
 * is why an initial one reads back through the facade as `0000-12-30`.
 *
 * An UPDATE must NOT be converted: it goes through `cds.ql.UPDATE`, and CAP's own remote client
 * serializes by the model.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAINTENANCE_ENTITIES,
  createDefaultsFor,
  remoteDateLiteral,
  serializeRemoteDates
} = require('../srv/business-partner-service')._internals;

const source = fs.readFileSync(
  path.join(__dirname, '..', 'srv', 'business-partner-service.js'), 'utf8'
);

// A website row's own elements, plus a string to be left alone and the boolean key part.
const WEBSITE_ELEMENTS = {
  ValidityStartDate: { type: 'cds.Date' },
  WebsiteURL: { type: 'cds.String' },
  IsDefaultURLAddress: { type: 'cds.Boolean' },
  OrdinalNumber: { type: 'cds.String' }
};

test('a date-only value becomes midnight UTC, not midnight wherever the container is', () => {
  assert.equal(remoteDateLiteral('2026-09-07'), `/Date(${Date.UTC(2026, 8, 7)})/`);
  // The bug this guards: 'YYYY-MM-DDTHH:mm:ss' without a zone is LOCAL time to Date.parse, so a
  // container east of UTC would send the previous day.
  assert.equal(remoteDateLiteral('2026-09-07T00:00:00'), `/Date(${Date.UTC(2026, 8, 7)})/`);
  assert.equal(remoteDateLiteral('2026-09-07T12:30:00Z'), `/Date(${Date.UTC(2026, 8, 7, 12, 30)})/`);
  // An explicit offset is honoured rather than overridden.
  assert.equal(remoteDateLiteral('2026-09-07T02:00:00+02:00'), `/Date(${Date.UTC(2026, 8, 7)})/`);
  assert.equal(remoteDateLiteral(new Date(Date.UTC(2026, 8, 7))), `/Date(${Date.UTC(2026, 8, 7)})/`);
});

test('anything it cannot read as a date is refused, so the original value is what S/4 judges', () => {
  for (const value of ['', 'today', 'not-a-date', null, undefined, 42, true, {}]) {
    assert.equal(remoteDateLiteral(value), null, JSON.stringify(value) || String(value));
  }
  // Already converted: nothing double-wraps, whichever path a value arrives by.
  assert.equal(remoteDateLiteral('/Date(1789084800000)/'), null);
});

test('only date-typed ELEMENTS are converted, never a value that merely looks like one', () => {
  const body = serializeRemoteDates({
    ValidityStartDate: '2026-09-07',
    // A string field whose content reads as a date stays a string - the model decides, not the value.
    WebsiteURL: '2026-09-07',
    IsDefaultURLAddress: true,
    OrdinalNumber: '1'
  }, WEBSITE_ELEMENTS);

  assert.equal(body.ValidityStartDate, `/Date(${Date.UTC(2026, 8, 7)})/`);
  assert.equal(body.WebsiteURL, '2026-09-07');
  assert.equal(body.IsDefaultURLAddress, true, 'a boolean is a JSON boolean on the wire');
  assert.equal(body.OrdinalNumber, '1');
});

test('a field the entity does not declare is left exactly as it is', () => {
  const body = serializeRemoteDates(
    { to_AddressUsage: [{ AddressUsage: 'XXDEFAULT', StandardUsage: true }] }, WEBSITE_ELEMENTS
  );
  // The deep-insert array the FIRST address of a partner carries must survive untouched.
  assert.deepEqual(body.to_AddressUsage, [{ AddressUsage: 'XXDEFAULT', StandardUsage: true }]);
});

test('it copies rather than mutating, and survives a missing model', () => {
  const payload = { ValidityStartDate: '2026-09-07' };
  const body = serializeRemoteDates(payload, WEBSITE_ELEMENTS);
  assert.equal(payload.ValidityStartDate, '2026-09-07', 'the caller still holds real values');
  assert.notEqual(body, payload);
  // No elements: hand back what came in rather than guessing from the values.
  assert.deepEqual(serializeRemoteDates(payload, undefined), payload);
  assert.equal(serializeRemoteDates(null, WEBSITE_ELEMENTS), null);
});

/** The one date this app actually sends, end to end: the website default it invented itself. */
test("the website create's own default converts to a literal S/4 accepts", () => {
  const defaults = createDefaultsFor(MAINTENANCE_ENTITIES.AddressHomePageURLs);
  const body = serializeRemoteDates(defaults, WEBSITE_ELEMENTS);
  assert.match(body.ValidityStartDate, /^\/Date\(\d+\)\/$/u);
  // A year Edm.DateTime accepts, which was the point of defaulting it at all.
  const milliseconds = Number(body.ValidityStartDate.slice(6, -2));
  assert.ok(new Date(milliseconds).getUTCFullYear() >= 2026);
});

/**
 * Where it is called from matters as much as what it does: converted too early, the required-field
 * check and the navigation path would judge `/Date(...)/` strings; applied to the update, CAP's own
 * serializer would be handed a string where it expects a date.
 */
test('the create converts, the update does not', () => {
  const createBranch = source.slice(
    source.indexOf('const defaulted = { ...createDefaultsFor(configuration)'),
    source.indexOf('return JSON.stringify(result || payload);')
  );
  assert.ok(createBranch.length > 0, 'the create branch moved');
  assert.match(createBranch, /const body = serializeRemoteDates\(defaulted, entity\.elements\);/u);
  assert.ok(
    createBranch.indexOf('validateMaintenanceCreate') < createBranch.indexOf('serializeRemoteDates'),
    'validated on real values, converted only on the way out'
  );
  assert.match(createBranch, /createBusinessPartnerAddress\(s4, body\)/u);
  assert.match(createBranch, /createBusinessPartnerChild\(s4, configuration, body, addressed\)/u);
  // `addressed` still carries the raw values - it addresses the parent and is what the check reads.
  assert.doesNotMatch(createBranch, /serializeRemoteDates\(addressed/u);

  const updateAt = source.indexOf('cds.ql.UPDATE(targetEntity)');
  assert.ok(updateAt > -1, 'the update moved');
  assert.doesNotMatch(
    source.slice(updateAt - 500, updateAt + 200), /serializeRemoteDates/u,
    'cds.ql serializes by the model itself'
  );
});
