'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  watchedSets, parseMetadata, compareMetadata, describeDrift, serviceTargets, checkMetadataDrift
} = require('../srv/metadata-drift');
const { parseArguments } = require('../tools/import-metadata');

// The destination route does not work from BAS, so the other two are the ones that get used.
test('the importer takes a service plus an explicit source', () => {
  assert.deepEqual(parseArguments(['API_BUSINESS_PARTNER']), {
    service: 'API_BUSINESS_PARTNER', url: null, file: null, insecure: false
  });
  assert.deepEqual(parseArguments(['X', '--file', 'saved.xml']), {
    service: 'X', url: null, file: 'saved.xml', insecure: false
  });
  assert.deepEqual(parseArguments(['X', '--url', 'https://h/sap', '--insecure']), {
    service: 'X', url: 'https://h/sap', file: null, insecure: true
  });
  // Requiring the module must not run the import.
  assert.equal(parseArguments([]).service, null);
});

const edmx = (sets) => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
<edmx:DataServices>
<Schema Namespace="test">
${Object.entries(sets).map(([name, properties]) => `
<EntityType Name="${name}Type" sap:label="x">
<Key><PropertyRef Name="${properties[0]}"/></Key>
${properties.map((property) => `<Property Name="${property}" Type="Edm.String" MaxLength="4"/>`).join('\n')}
</EntityType>`).join('\n')}
<EntityContainer Name="c">
${Object.keys(sets).map((name) => `<EntitySet Name="${name}" EntityType="test.${name}Type"/>`).join('\n')}
</EntityContainer>
</Schema>
</edmx:DataServices>
</edmx:Edmx>`;

test('the reader finds entity sets and their properties through the entity type', () => {
  const { entitySets } = parseMetadata(edmx({
    Countries: ['Country', 'Country_Text'],
    Regions: ['Region', 'Region_Text', 'Country']
  }));
  assert.deepEqual([...entitySets.keys()].sort(), ['Countries', 'Regions']);
  assert.deepEqual([...entitySets.get('Countries')].sort(), ['Country', 'Country_Text']);
  assert.equal(entitySets.get('Regions').size, 3);
});

test('nothing parseable yields no entity sets rather than throwing', () => {
  assert.equal(parseMetadata('<html>gateway error</html>').entitySets.size, 0);
  assert.equal(parseMetadata('').entitySets.size, 0);
  assert.equal(parseMetadata(undefined).entitySets.size, 0);
});

// The whole point of the direction split: one of these breaks a read today, the other does not.
test('a property the live service dropped is separated from one it gained', () => {
  const local = parseMetadata(edmx({ Countries: ['Country', 'Country_Text', 'Retired'] }));
  const live = parseMetadata(edmx({ Countries: ['Country', 'Country_Text', 'Added'] }));
  const diff = compareMetadata(local, live, ['Countries']);
  assert.deepEqual(diff.goneProperties, [{ entitySet: 'Countries', properties: ['Retired'] }]);
  assert.deepEqual(diff.newProperties, [{ entitySet: 'Countries', properties: ['Added'] }]);
  assert.deepEqual(diff.goneSets, []);
  assert.deepEqual(diff.newSets, []);
});

test('an entity set present on only one side is reported as a set, not as every property', () => {
  const local = parseMetadata(edmx({ Countries: ['Country'], Gone: ['A', 'B', 'C'] }));
  const live = parseMetadata(edmx({ Countries: ['Country'], New: ['X'] }));
  const diff = compareMetadata(local, live, ['Countries', 'Gone', 'New']);
  assert.deepEqual(diff.goneSets, ['Gone']);
  assert.deepEqual(diff.newSets, ['New']);
  assert.deepEqual(diff.goneProperties, []);
});

// 65 entity sets of which the app reads nine: an unscoped diff is a report nobody finishes.
test('only the watched sets are compared', () => {
  const local = parseMetadata(edmx({ Countries: ['Country'], Ignored: ['A'] }));
  const live = parseMetadata(edmx({ Countries: ['Country'] }));
  assert.deepEqual(compareMetadata(local, live, ['Countries']).goneSets, []);
  assert.deepEqual(compareMetadata(local, live, []).goneSets, ['Ignored'], 'unwatched means compare all');
});

test('a watched set missing from both sides is reported rather than read as agreement', () => {
  const both = parseMetadata(edmx({ Countries: ['Country'] }));
  const diff = compareMetadata(both, both, ['Countries', 'Renamed']);
  assert.deepEqual(diff.unknown, ['Renamed']);
  assert.deepEqual(diff.goneSets, []);
});

test('the message names the command to run, and separates warnings from notes', () => {
  const lines = describeDrift('API_BUSINESS_PARTNER', {
    goneSets: ['A_Gone'],
    newSets: [],
    goneProperties: [{ entitySet: 'A_BusinessPartner', properties: ['OldField'] }],
    newProperties: [{ entitySet: 'A_BusinessPartner', properties: ['NewField'] }],
    unknown: []
  }, 'npm run import:bp');

  assert.equal(lines.length, 2);
  const warning = lines.find((line) => line.level === 'warn');
  assert.match(warning.message, /reads may already be failing/u);
  assert.match(warning.message, /A_Gone/u);
  assert.match(warning.message, /OldField/u);
  assert.match(warning.message, /npm run import:bp/u);

  const note = lines.find((line) => line.level === 'info');
  assert.match(note.message, /behind/u);
  assert.match(note.message, /NewField/u);
  assert.equal(/OldField/u.test(note.message), false, 'a dropped field is not a note');
});

test('nothing to report produces no lines at all', () => {
  assert.deepEqual(describeDrift('X', {
    goneSets: [], newSets: [], goneProperties: [], newProperties: [], unknown: []
  }, 'cmd'), []);
});

// The destination and path already live in package.json; a second copy here is what goes stale.
test('targets come from the requires block, and skip anything not destination-backed', () => {
  const targets = serviceTargets({
    API_BUSINESS_PARTNER: {
      kind: 'odata-v2',
      model: 'srv/external/API_BUSINESS_PARTNER',
      credentials: { destination: 'VF_S4HANA_DEST', path: '/API_BUSINESS_PARTNER' }
    },
    SBPA_DESTINATION: { kind: 'rest', credentials: { destination: 'sbpa-destination' } },
    db: { kind: 'sqlite' }
  }, { API_BUSINESS_PARTNER: ['A_BusinessPartner'] });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].url, '/API_BUSINESS_PARTNER/$metadata');
  assert.match(targets[0].edmx, /API_BUSINESS_PARTNER\.edmx$/u);
  assert.deepEqual(targets[0].watched, ['A_BusinessPartner']);
});

test('the watched list covers the maintained entities and every value help', () => {
  const watched = watchedSets({
    maintenanceEntities: { Addresses: { remote: 'A_BusinessPartnerAddress' } },
    valueHelpEntities: ['Countries', 'BusinessPartnerRoleCodes']
  });
  assert.deepEqual(watched.API_BUSINESS_PARTNER, ['A_BusinessPartner', 'A_BusinessPartnerAddress']);
  // The projection is renamed to dodge a clash; the remote set is the one to ask the service about.
  assert.deepEqual(watched.ZSRVB_MDMLIGHT_VH, ['Countries', 'BusinessPartnerRoles']);
});

const collectLog = () => {
  const lines = [];
  const record = (level) => (...args) => lines.push({ level, message: args.join(' ') });
  return { lines, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
};

const requires = {
  ZSRVB_MDMLIGHT_VH: {
    kind: 'odata-v2',
    model: 'srv/external/ZSRVB_MDMLIGHT_VH',
    credentials: { destination: 'VF_S4HANA_DEST', path: '/ZSRVB_MDMLIGHT_VH' }
  }
};

test('drift found against the live service is warned about once', async () => {
  const log = collectLog();
  const results = await checkMetadataDrift({
    requires,
    valueHelpEntities: ['Countries'],
    readFile: async () => edmx({ Countries: ['Country', 'Country_Text'] }),
    executeHttpRequest: async () => ({ data: edmx({ Countries: ['Country'] }) }),
    log
  });

  assert.equal(results.length, 1);
  const warnings = log.lines.filter((line) => line.level === 'warn');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /Country_Text/u);
  assert.match(warnings[0].message, /npm run import:valuehelp/u);
});

// An unreachable S/4 is the normal case in local dev. It must never look like a finding.
test('an unreachable service, an empty answer or a missing copy stay at debug', async () => {
  for (const [readFile, execute] of [
    [async () => { throw new Error('ENOENT'); }, async () => ({ data: edmx({ Countries: ['Country'] }) })],
    [async () => edmx({ Countries: ['Country'] }), async () => { throw new Error('no destination'); }],
    [async () => edmx({ Countries: ['Country'] }), async () => ({ data: '<html>503</html>' })]
  ]) {
    const log = collectLog();
    const results = await checkMetadataDrift({
      requires, valueHelpEntities: ['Countries'], readFile, executeHttpRequest: execute, log
    });
    assert.deepEqual(results, []);
    assert.deepEqual(log.lines.filter((line) => line.level !== 'debug'), []);
  }
});

test('a service in step says so at debug and reports nothing', async () => {
  const log = collectLog();
  const same = edmx({ Countries: ['Country', 'Country_Text'] });
  await checkMetadataDrift({
    requires,
    valueHelpEntities: ['Countries'],
    readFile: async () => same,
    executeHttpRequest: async () => ({ data: same }),
    log
  });
  assert.deepEqual(log.lines.filter((line) => line.level !== 'debug'), []);
  assert.match(log.lines[0].message, /matches the local copy/u);
});
