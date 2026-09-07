'use strict';

/**
 * Changing or deleting an existing email/phone/fax/website needs the row's whole S/4 key, and only
 * part of it can be staged.
 *
 * Their key is `AddressID+Person+OrdinalNumber` (`A_AddressHomePageURL` adds `ValidityStartDate`
 * and `IsDefaultURLAddress`). `StagedAddress*` declared none of it beyond `AddressID`, and
 * `stageable` drops any field the staging entity does not declare - so the keys the read HAD
 * brought back from S/4 were thrown away at staging time and a `U`/`D` failed with *"Missing key
 * field(s): Person, OrdinalNumber"* (2026-09-07).
 *
 * `OrdinalNumber` is now staged, because it is the one part that IDENTIFIES the row: once the
 * requester has edited the value itself, nothing else says which of the address's rows it used to
 * be. `Person` and `ValidityStartDate` are NOT staged, because they can be read back on
 * `AddressID+OrdinalNumber` - which is what resolveAddressChildKeys does.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');

const {
  ADDRESS_CHILD_NODES,
  ADDRESS_CHILD_ASSIGNED_KEYS,
  resolveAddressChildKeys,
  usableDateTimeKey
} = require('../srv/change-request-service')._internals;

const STAGED = {
  AddressEmails: 'mdmlight.staging.StagedAddressEmails',
  AddressPhoneNumbers: 'mdmlight.staging.StagedAddressPhoneNumbers',
  AddressFaxNumbers: 'mdmlight.staging.StagedAddressFaxNumbers',
  AddressHomePageURLs: 'mdmlight.staging.StagedAddressHomePageURLs'
};

// The generated screen metadata, loaded the same way mdg-node-tree.test.js loads it.
function screenSections() {
  const file = path.join(
    __dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'BusinessPartnerMetadata.js'
  );
  let loaded;
  const define = (dependencies, factory) => { loaded = factory(); };
  new Function('sap', fs.readFileSync(file, 'utf8'))({ ui: { define } });
  return loaded.sections;
}

/** A stand-in for the S/4 service: records the query and answers with `rows`. */
const s4With = (rows) => {
  const calls = [];
  return {
    calls,
    run: async (query) => {
      calls.push(query);
      return rows;
    }
  };
};

test('every non-tax address child declares the keys it must read back', () => {
  assert.deepEqual(
    Object.keys(ADDRESS_CHILD_ASSIGNED_KEYS).sort(),
    ['AddressEmails', 'AddressFaxNumbers', 'AddressHomePageURLs', 'AddressPhoneNumbers'],
    'the four whose key S/4 assigns, and only those'
  );
  // AddressTaxNumbers keys on BusinessPartner+AddressID+BPTaxType, all staged or injected.
  assert.equal(ADDRESS_CHILD_ASSIGNED_KEYS.AddressTaxNumbers, undefined);
  assert.ok(ADDRESS_CHILD_NODES.has('AddressTaxNumbers'), 'it is still an address child');

  assert.deepEqual(ADDRESS_CHILD_ASSIGNED_KEYS.AddressEmails.fields, ['Person']);
  assert.deepEqual(
    ADDRESS_CHILD_ASSIGNED_KEYS.AddressHomePageURLs.fields,
    ['Person', 'ValidityStartDate'],
    "a website's key carries a validity date too"
  );
});

test('a tax number resolves to nothing at all, with no S/4 round trip', async () => {
  const s4 = s4With([{ Person: 'nope' }]);
  assert.deepEqual(await resolveAddressChildKeys(s4, 'AddressTaxNumbers', { AddressID: '77' }), {});
  assert.equal(s4.calls.length, 0);
});

test('the rest of the key is read back on AddressID and OrdinalNumber', async () => {
  const s4 = s4With([{ Person: '0000000000' }]);
  assert.deepEqual(
    await resolveAddressChildKeys(s4, 'AddressEmails', { AddressID: '77', OrdinalNumber: '002' }),
    { Person: '0000000000' }
  );
  assert.equal(s4.calls.length, 1, 'one read per row, not one per request');

  const { SELECT } = s4.calls[0];
  assert.match(JSON.stringify(SELECT.from), /A_AddressEmailAddress/u);
  // Both key parts, so the read cannot answer with a sibling row of the same address.
  const where = JSON.stringify(SELECT.where);
  assert.match(where, /AddressID/u);
  assert.match(where, /"77"/u);
  assert.match(where, /OrdinalNumber/u);
  assert.match(where, /"002"/u);
});

test('a website resolves both of its assigned key parts', async () => {
  const s4 = s4With([{ Person: '0000000000', ValidityStartDate: '2026-01-01' }]);
  assert.deepEqual(
    await resolveAddressChildKeys(s4, 'AddressHomePageURLs', { AddressID: '77', OrdinalNumber: '001' }),
    { Person: '0000000000', ValidityStartDate: '2026-01-01' }
  );
});

test('a single object answer is accepted as one row', async () => {
  const s4 = s4With({ Person: '0000000000' });
  assert.deepEqual(
    await resolveAddressChildKeys(s4, 'AddressEmails', { AddressID: '77', OrdinalNumber: '001' }),
    { Person: '0000000000' }
  );
});

/**
 * Every one of these throws rather than returning a partial key. A key missing a part addresses a
 * DIFFERENT row than the requester picked, so an update would overwrite, and a delete would remove,
 * something nobody chose - the same reasoning as "a candidate never resolves silently to nothing"
 * for addressIdByStagedRow.
 */
test('a row that cannot be identified is refused, never guessed', async () => {
  const cases = [
    {
      what: 'no ordinal staged (a request raised before the column existed)',
      rows: [{ Person: '0000000000' }],
      row: { AddressID: '77' },
      message: /carries no OrdinalNumber/u
    },
    {
      what: 'a blank ordinal is no ordinal',
      rows: [{ Person: '0000000000' }],
      row: { AddressID: '77', OrdinalNumber: '   ' },
      message: /carries no OrdinalNumber/u
    },
    {
      what: 'the row is gone from S/4',
      rows: [],
      row: { AddressID: '77', OrdinalNumber: '002' },
      message: /has no row 002 in S\/4/u
    },
    {
      what: 'two rows share the ordinal, so the target is ambiguous',
      rows: [{ Person: '0000000000' }, { Person: '0000000123' }],
      row: { AddressID: '77', OrdinalNumber: '002' },
      message: /2 rows numbered 002/u
    },
    {
      what: 'S/4 answered without the key part at all',
      rows: [{ SomethingElse: 'x' }],
      row: { AddressID: '77', OrdinalNumber: '002' },
      message: /did not return Person for address 77 row 002/u
    }
  ];

  for (const { what, rows, row, message } of cases) {
    await assert.rejects(
      () => resolveAddressChildKeys(s4With(rows), 'AddressEmails', row),
      (error) => message.test(error.message),
      what
    );
  }
});

test('the four staging entities carry OrdinalNumber, and nothing else of the key', async () => {
  const model = cds.linked(await cds.load(path.join(__dirname, '..', 'db')));

  for (const [section, entity] of Object.entries(STAGED)) {
    const elements = model.definitions[entity].elements;
    assert.ok(elements.OrdinalNumber, `${entity} must carry OrdinalNumber`);
    assert.equal(elements.OrdinalNumber.length, 3, `${entity}: OrdinalNumber is CHAR3 in S/4`);
    assert.ok(elements.AddressID, `${entity} must carry AddressID`);
    // Read back at post time instead - a staged column for these would be dead weight.
    for (const field of ADDRESS_CHILD_ASSIGNED_KEYS[section].fields) {
      assert.equal(elements[field], undefined, `${entity} must NOT stage ${field}`);
    }
  }

  const taxNumbers = model.definitions['mdmlight.staging.StagedAddressTaxNumbers'].elements;
  assert.equal(taxNumbers.OrdinalNumber, undefined, 'a tax number is not keyed by an ordinal');
  assert.ok(taxNumbers.BPTaxType, 'its own key part is staged, and always was');
});

test('the ordinal is never asked of a requester', () => {
  const sections = new Map(screenSections().map((section) => [section.id, section]));

  for (const section of Object.keys(STAGED)) {
    const fields = (sections.get(section).fields || []).map((field) => field.name);
    assert.ok(fields.length, `${section} has screen fields`);
    assert.equal(
      fields.includes('OrdinalNumber'), false,
      `${section} must not render OrdinalNumber - S/4 assigns it`
    );
  }
});

/**
 * The post has to resolve the key BEFORE it branches on the action, because both the `D` branch
 * (which sends `data` as KeyJson) and the update below it need the full key.
 */
test('postToS4 resolves the key for a change and a delete, but never for a create', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8');
  const resolveAt = source.indexOf('await resolveAddressChildKeys(s4, section, data)');
  assert.ok(resolveAt > 0, 'the post resolves the assigned key parts');
  assert.match(
    source.slice(source.lastIndexOf('if (', resolveAt), resolveAt),
    /action !== 'C'/u,
    'a create has no row to read back yet'
  );
  assert.ok(
    resolveAt < source.indexOf("if (action === 'D')", resolveAt),
    'resolved before the delete branch, which sends data as its KeyJson'
  );
});

/**
 * A create flips the staged row to 'U' so a resubmit over a LATER node's failure does not create it
 * twice - which makes the ordinal a retry dependency: the resubmit's update has to address the row
 * this run created, and only S/4 knows its number.
 */
test('a create records the ordinal S/4 assigned, so a resubmit can address the row', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8');
  const createAt = source.indexOf("const persisted = { action: 'U' };");
  assert.ok(createAt > 0, 'the create still flips the action to U');
  const block = source.slice(createAt, source.indexOf('.where({ ID }));', createAt));
  assert.match(block, /ADDRESS_CHILD_ASSIGNED_KEYS\[section\]/u, 'only for the four that need it');
  assert.match(block, /persisted\.OrdinalNumber = assigned/u, 'and it is persisted, not just read');
});

/**
 * `Person` (ADR6/ADRT-PERSNUMBER) is the CONTACT PERSON a row hangs off, and is blank for an
 * address-level entry - which every row of these sections is, on an organisation or a person alike.
 * So blank is the real key value, and demanding a non-empty one refused a change S/4 had answered
 * correctly (reported live 2026-09-07: "S/4 returned no Person for address 1367 row 1"). Staging
 * `Person` would not have helped for the same reason: the value being carried IS blank.
 */
test('a blank Person is a real key value, not a missing one', async () => {
  const s4 = s4With([{ Person: '' }]);
  assert.deepEqual(
    await resolveAddressChildKeys(s4, 'AddressEmails', { AddressID: '1367', OrdinalNumber: '1' }),
    { Person: '' },
    'the blank comes back as the key value it is'
  );
});

test('a null key part is normalised to the blank the key predicate needs', async () => {
  // sanitizeEntityKeys drops null as missing, so null and '' cannot both reach it.
  const s4 = s4With([{ Person: null }]);
  assert.deepEqual(
    await resolveAddressChildKeys(s4, 'AddressEmails', { AddressID: '1367', OrdinalNumber: '1' }),
    { Person: '' }
  );
});

/**
 * The other half: `sanitizeEntityKeys` reads '' as a key nobody supplied, which is what it was
 * added for. The four address children declare `Person` blankable so it alone gets through.
 */
test('the four children declare Person blankable, and nothing else does', () => {
  const { MAINTENANCE_ENTITIES } = require('../srv/business-partner-service')._internals;

  for (const section of Object.keys(STAGED)) {
    assert.deepEqual(
      MAINTENANCE_ENTITIES[section].blankableKeyFields, ['Person'],
      `${section} must allow a blank Person`
    );
  }
  // A tax number keys on BusinessPartner/AddressID/BPTaxType - none of them may be blank.
  assert.equal(MAINTENANCE_ENTITIES.AddressTaxNumbers.blankableKeyFields, undefined);

  const blankable = Object.entries(MAINTENANCE_ENTITIES)
    .filter(([, config]) => config.blankableKeyFields)
    .map(([section]) => section)
    .sort();
  assert.deepEqual(
    blankable,
    ['AddressEmails', 'AddressFaxNumbers', 'AddressHomePageURLs', 'AddressPhoneNumbers'],
    'the emptiness test stays strict for every other node'
  );
});

test('sanitizeEntityKeys lets a declared blank key through, and still catches a missing one', async () => {
  const cds = require('@sap/cds');
  const { sanitizeEntityKeys } = require('../srv/business-partner-service')._internals;
  const model = await cds.load(path.join(__dirname, '..', 'srv'));
  const entity = model.definitions['BusinessPartnerService.AddressEmails'];

  assert.deepEqual(
    sanitizeEntityKeys(
      { AddressID: '1367', Person: '', OrdinalNumber: '1' }, entity, { blankable: ['Person'] }
    ),
    { AddressID: '1367', Person: '', OrdinalNumber: '1' }
  );
  // Without the declaration the blank still reads as missing - the default is unchanged.
  assert.throws(
    () => sanitizeEntityKeys({ AddressID: '1367', Person: '', OrdinalNumber: '1' }, entity),
    (error) => error.statusCode === 400 && /Person/u.test(error.message)
  );
  // Blankable is not "optional": an absent key is still missing.
  assert.throws(
    () => sanitizeEntityKeys({ AddressID: '1367', OrdinalNumber: '1' }, entity, { blankable: ['Person'] }),
    (error) => error.statusCode === 400 && /Person/u.test(error.message)
  );
  // And a blank the entity does NOT permit is still refused.
  assert.throws(
    () => sanitizeEntityKeys({ AddressID: '', Person: '', OrdinalNumber: '1' }, entity, { blankable: ['Person'] }),
    (error) => error.statusCode === 400 && /AddressID/u.test(error.message)
  );
});

/**
 * `A_AddressHomePageURL` is the one address child whose key is not all strings - it adds
 * `ValidityStartDate` (Edm.DateTime) and `IsDefaultURLAddress` (Edm.Boolean).
 *
 * Reported live 2026-09-07, after BP 562: the gateway refused
 * `A_AddressHomePageURL(AddressID='1205',Person='',OrdinalNumber='1',
 * ValidityStartDate=datetime'0000-12-30T00:00:00',IsDefaultURLAddress=true)` with *"Malformed URI
 * literal syntax"*. The FORM was right - `Person=''`, a bare `true`, a `datetime'...'` literal -
 * but Edm.DateTime starts at 0001-01-01, and `0000-12-30` is how CAP renders an SAP INITIAL date.
 * A website row with no validity date read back as one, and we tried to put it in a key.
 */
test('an initial date is addressed as the one value the release allows', async () => {
  // SAP's own annotation on this property: "Valid-from date - in current Release only 00010101
  // possible". So `0000-12-30` is not a broken date, it is THAT value rendered two days out (the
  // ABAP initial arrives as /Date(-62135769600000)/, just under Edm.DateTime's 0001-01-01 floor).
  assert.equal(usableDateTimeKey('0000-12-30T00:00:00'), null, 'it still cannot be a literal as-is');
  assert.deepEqual(
    await resolveAddressChildKeys(
      s4With([{ Person: '', ValidityStartDate: '0000-12-30T00:00:00' }]),
      'AddressHomePageURLs',
      { AddressID: '1205', OrdinalNumber: '1' }
    ),
    { Person: '', ValidityStartDate: '0001-01-01' }
  );
});

/**
 * Substituting is safe here in the one way that matters, and ONLY here: it cannot address a
 * different row, because no row of this entity can hold a different value. A date-keyed field with
 * no such declared constraint is still refused rather than guessed at - which is why today's date
 * was refused when this was first hit (BP 562): a real date could name another row.
 */
test('the substitution is declared per field, and only where the release allows one value', () => {
  assert.deepEqual(
    ADDRESS_CHILD_ASSIGNED_KEYS.AddressHomePageURLs.onlyPossibleValue,
    { ValidityStartDate: '0001-01-01' }
  );
  for (const section of ['AddressEmails', 'AddressPhoneNumbers', 'AddressFaxNumbers']) {
    assert.equal(ADDRESS_CHILD_ASSIGNED_KEYS[section].onlyPossibleValue, undefined, section);
    assert.equal(ADDRESS_CHILD_ASSIGNED_KEYS[section].dateTimeFields, undefined, section);
  }
  // And the value is what S/4's metadata says, not an arbitrary floor.
  const edmx = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'external', 'API_BUSINESS_PARTNER.edmx'), 'utf8'
  );
  const start = edmx.indexOf('<EntityType Name="A_AddressHomePageURLType"');
  const block = edmx.slice(start, edmx.indexOf('</EntityType>', start));
  assert.match(block, /only 00010101 possible/u, 'SAP still states the single legal value');
});

test('a real validity date still resolves, unchanged', async () => {
  const s4 = s4With([{ Person: '', ValidityStartDate: '2026-01-01T00:00:00' }]);
  assert.deepEqual(
    await resolveAddressChildKeys(s4, 'AddressHomePageURLs', { AddressID: '1205', OrdinalNumber: '1' }),
    { Person: '', ValidityStartDate: '2026-01-01T00:00:00' },
    'passed through as S/4 gave it - a key is an address, not a value to normalise'
  );
});

test('only the website declares a DateTime key part', () => {
  assert.deepEqual(ADDRESS_CHILD_ASSIGNED_KEYS.AddressHomePageURLs.dateTimeFields, ['ValidityStartDate']);
  for (const section of ['AddressEmails', 'AddressPhoneNumbers', 'AddressFaxNumbers']) {
    assert.equal(ADDRESS_CHILD_ASSIGNED_KEYS[section].dateTimeFields, undefined, section);
  }
});

test('usableDateTimeKey keeps a real date and rejects what cannot be a literal', () => {
  // Kept, and returned as given rather than reformatted.
  for (const value of ['2026-01-01T00:00:00', new Date('2026-01-01T00:00:00Z'), '0001-01-01T00:00:00']) {
    assert.equal(usableDateTimeKey(value), value, String(value));
  }
  // Year 0 is outside Edm.DateTime, and nonsense is not a date at all.
  for (const value of ['0000-12-30T00:00:00', '0000-01-01T00:00:00', '', 'not-a-date', null]) {
    assert.equal(usableDateTimeKey(value), null, JSON.stringify(value));
  }
});

/**
 * `ValidityStartDate` is part of this entity's key and is not on the screen, so the create has to
 * supply it - and there is exactly one value it may be. Today's date was sent first (2026-09-07)
 * and S/4 **accepted it and ignored it**: BP 646's row read back `"ValidityStartDate":
 * "0000-12-30"` all the same, as did both rows of address 1205 before it. Its own metadata says
 * why - `sap:quickinfo="Valid-from date - in current Release only 00010101 possible"`.
 */
test('a website create carries the one validity date the release allows', () => {
  const { MAINTENANCE_ENTITIES, createDefaultsFor } = require('../srv/business-partner-service')._internals;
  const defaults = createDefaultsFor(MAINTENANCE_ENTITIES.AddressHomePageURLs);

  assert.deepEqual(defaults, { ValidityStartDate: '0001-01-01' });
  // And it is a value Edm.DateTime can carry, unlike the 0000-12-30 the same row reads back as.
  assert.equal(usableDateTimeKey(defaults.ValidityStartDate), '0001-01-01');
  assert.equal(usableDateTimeKey('0000-12-30'), null);
  // It is the same value resolveAddressChildKeys addresses an existing row by - one constant, two
  // places, and they must not drift.
  assert.equal(
    ADDRESS_CHILD_ASSIGNED_KEYS.AddressHomePageURLs.onlyPossibleValue.ValidityStartDate,
    defaults.ValidityStartDate
  );
});

test('no other maintenance node invents a create value', () => {
  const { MAINTENANCE_ENTITIES, createDefaultsFor } = require('../srv/business-partner-service')._internals;

  const withDefaults = Object.entries(MAINTENANCE_ENTITIES)
    .filter(([, config]) => config.createDefaults)
    .map(([section]) => section);
  assert.deepEqual(withDefaults, ['AddressHomePageURLs']);
  // And the helper is empty for everything else, so the create payload is untouched.
  assert.deepEqual(createDefaultsFor(MAINTENANCE_ENTITIES.AddressEmails), {});
  assert.deepEqual(createDefaultsFor(MAINTENANCE_ENTITIES.Addresses), {});
});

/**
 * A requester's own value must win: the default exists only to fill a field the screen never shows.
 */
test('the default never overwrites what was supplied', () => {
  const { MAINTENANCE_ENTITIES, createDefaultsFor } = require('../srv/business-partner-service')._internals;
  const payload = { WebsiteURL: 'alluvion.eu', ValidityStartDate: '2020-01-01' };
  const defaulted = { ...createDefaultsFor(MAINTENANCE_ENTITIES.AddressHomePageURLs), ...payload };
  assert.equal(defaulted.ValidityStartDate, '2020-01-01');
});

/**
 * The GENERAL form of the website bug, so it cannot come back on a node nobody was thinking about.
 *
 * A row is unaddressable forever if its key contains a date the create left initial: S/4 stores its
 * own initial value, renders it as year 0, and then refuses its own literal. A key field that is
 * not a plain string is therefore only safe if the create is guaranteed to fill it - either because
 * the requester must (`requiredCreateFields`) or because the app defaults it (`createDefaults`).
 *
 * Booleans are exempt: `false` is a perfectly good key literal, so an unset one cannot be malformed
 * (it is still a design smell where the field is also editable - see IsDefaultURLAddress).
 */
test('no creatable node has a date in its key that a create could leave empty', () => {
  const { MAINTENANCE_ENTITIES } = require('../srv/business-partner-service')._internals;
  const edmxText = fs.readFileSync(
    path.join(__dirname, '..', 'srv', 'external', 'API_BUSINESS_PARTNER.edmx'), 'utf8'
  );

  // Sliced rather than matched with a built RegExp: inside a template literal `[\s\S]` collapses to
  // `[sS]`, which silently matches nothing useful and would make this test pass by finding no keys.
  const entityKeys = (remote) => {
    const start = edmxText.indexOf(`<EntityType Name="${remote}Type"`);
    if (start < 0) return [];
    const block = edmxText.slice(start, edmxText.indexOf('</EntityType>', start));
    const [head] = block.split('</Key>');
    const keys = [...head.matchAll(/<PropertyRef Name="([^"]+)"/gu)].map((m) => m[1]);
    const types = new Map(
      [...block.matchAll(/<Property Name="([^"]+)" Type="([^"]+)"/gu)].map((m) => [m[1], m[2]])
    );
    return keys.map((name) => ({ name, type: types.get(name) }));
  };

  const unguarded = [];
  const dateKeys = [];
  for (const [section, config] of Object.entries(MAINTENANCE_ENTITIES)) {
    if (config.creatable === false || !config.remote) continue;
    const filled = new Set(config.requiredCreateFields || []);
    const defaulted = new Set(Object.keys(
      typeof config.createDefaults === 'function' ? config.createDefaults() : {}
    ));
    for (const key of entityKeys(config.remote)) {
      if (!/^Edm\.(DateTime|DateTimeOffset|Date)$/u.test(key.type || '')) continue;
      dateKeys.push(`${section}.${key.name}`);
      if (filled.has(key.name) || defaulted.has(key.name)) continue;
      unguarded.push(`${section}.${key.name} (${key.type})`);
    }
  }

  // Or the whole test passes because the EDMX slicing found no keys at all.
  assert.deepEqual(
    dateKeys.sort(),
    ['AddressHomePageURLs.ValidityStartDate', 'BusinessPartnerContacts.ValidityEndDate'],
    'the two date-keyed nodes were actually read out of the EDMX'
  );
  assert.deepEqual(
    unguarded, [],
    'a date in the key must be required of the requester or defaulted by the app, or the row it '
    + 'creates can never be addressed again'
  );
});

/** The two nodes this actually applies to, and how each is covered - so a change is deliberate. */
test('the two date-keyed nodes are covered by different means, on purpose', () => {
  const { MAINTENANCE_ENTITIES, createDefaultsFor } = require('../srv/business-partner-service')._internals;

  // A contact's validity is a business decision, so the requester supplies it.
  assert.ok(MAINTENANCE_ENTITIES.BusinessPartnerContacts.requiredCreateFields.includes('ValidityEndDate'));
  assert.equal(MAINTENANCE_ENTITIES.BusinessPartnerContacts.createDefaults, undefined);

  // A website's is not a decision at all - the release allows one value - so the app fills it in
  // rather than asking a requester for the only answer there is.
  assert.ok(!MAINTENANCE_ENTITIES.AddressHomePageURLs.requiredCreateFields.includes('ValidityStartDate'));
  assert.equal(createDefaultsFor(MAINTENANCE_ENTITIES.AddressHomePageURLs).ValidityStartDate, '0001-01-01');
});

