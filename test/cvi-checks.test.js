'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createCviStages, invalidate, _internals } = require('../srv/checks/cvi-checks');
const { runDerivations } = require('../srv/checks/pipeline');

/**
 * The flags are booleans, not 'X'. That is what the remote service actually delivers -- every
 * CHAR(1) flag in these sets is Edm.Boolean in `srv/external/ZSRVB_MDMLIGHT_VH.cds` -- and
 * fixtures that used 'X' are why the role category rule passed its tests while being wrong in
 * production, twice. `isSet` accepts both; the fixtures here use the representation the wire uses,
 * and one test below pins the other one.
 *
 * FLCU01 is a customer role on an organisation-only category; BUP001 is allowed for all three and
 * creates nothing. FLVN01 creates a supplier.
 */
const CONFIG = Object.freeze({
  roles: [
    { BPRole: 'FLCU01', BPRoleName: 'Customer', BPRoleCategory: 'FLCU01' },
    { BPRole: 'FLVN01', BPRoleName: 'Supplier', BPRoleCategory: 'FLVN01' },
    { BPRole: 'BUP001', BPRoleName: 'Contact Person', BPRoleCategory: 'BUP001' }
  ],
  categories: [
    {
      BPRoleCategory: 'FLCU01',
      IsAllowedForPerson: false,
      IsAllowedForOrganization: true,
      IsAllowedForGroup: false,
      CreatesCustomerMandatory: true,
      CreatesCustomerOptional: false,
      CreatesSupplierMandatory: false,
      CreatesSupplierOptional: false
    },
    {
      BPRoleCategory: 'FLVN01',
      IsAllowedForPerson: true,
      IsAllowedForOrganization: true,
      IsAllowedForGroup: true,
      CreatesCustomerMandatory: false,
      CreatesCustomerOptional: false,
      CreatesSupplierMandatory: true,
      CreatesSupplierOptional: false
    },
    {
      BPRoleCategory: 'BUP001',
      IsAllowedForPerson: true,
      IsAllowedForOrganization: true,
      IsAllowedForGroup: true,
      CreatesCustomerMandatory: false,
      CreatesCustomerOptional: false,
      CreatesSupplierMandatory: false,
      CreatesSupplierOptional: false
    }
  ],
  postprocessing: [{ SynchronizationObject: 'BP', IsPostprocessingActive: true }],
  directions: [
    { SourceObject: 'BP', TargetObject: 'CUSTOMER', IsActive: true },
    { SourceObject: 'BP', TargetObject: 'VENDOR', IsActive: true }
  ],
  // S4A's real intervals for the ranges these tests use.
  numberRanges: [
    {
      NumberRangeObject: 'BU_PARTNER',
      NumberRangeNumber: '01',
      FromNumber: '0000000001',
      ToNumber: '0999999999',
      IsExternalNumberRange: false
    },
    {
      NumberRangeObject: 'BU_PARTNER',
      NumberRangeNumber: 'AB',
      FromNumber: 'A',
      ToNumber: 'ZZZZZZZZZZ',
      IsExternalNumberRange: true
    },
    {
      NumberRangeObject: 'DEBITOR',
      NumberRangeNumber: '01',
      FromNumber: '0000000001',
      ToNumber: '0000099999',
      IsExternalNumberRange: false
    },
    {
      NumberRangeObject: 'DEBITOR',
      NumberRangeNumber: 'XX',
      FromNumber: 'A',
      ToNumber: 'ZZZZZZZZZZ',
      IsExternalNumberRange: true
    },
    {
      NumberRangeObject: 'KREDITOR',
      NumberRangeNumber: 'XX',
      FromNumber: 'A',
      ToNumber: 'ZZZZZZZZZZ',
      IsExternalNumberRange: true
    }
  ],
  assignments: {
    // S100 -> 0100 with same number: BP range AB and customer range XX are the same interval.
    // 0001 -> DEBI without same number: both internal, which is the other legitimate setup.
    // 0002 -> KUNA without same number: KUNA is externally numbered, and nothing fills it in.
    CviCustomerNumberAssignments: [
      {
        SyncDirection: 'BP_TO_CUSTOMER',
        BPGrouping: 'S100',
        CustomerAccountGroup: '0100',
        HasSameNumber: true,
        BPNumberRange: 'AB',
        CustomerNumberRange: 'XX'
      },
      {
        SyncDirection: 'BP_TO_CUSTOMER',
        BPGrouping: '0001',
        CustomerAccountGroup: 'DEBI',
        HasSameNumber: false,
        BPNumberRange: '01',
        CustomerNumberRange: '01'
      },
      {
        SyncDirection: 'BP_TO_CUSTOMER',
        BPGrouping: '0002',
        CustomerAccountGroup: 'KUNA',
        HasSameNumber: false,
        BPNumberRange: 'AB',
        CustomerNumberRange: 'XX'
      },
      {
        SyncDirection: 'BP_TO_CUSTOMER',
        BPGrouping: 'S110',
        CustomerAccountGroup: '0110',
        HasSameNumber: true,
        BPNumberRange: '01',
        CustomerNumberRange: 'XX'
      },
      {
        SyncDirection: 'BP_TO_CUSTOMER',
        BPGrouping: 'S170',
        CustomerAccountGroup: '0170',
        HasSameNumber: false,
        BPNumberRange: '01',
        CustomerNumberRange: ''
      },
      // The inbound direction, which nothing reads. Here so a rule that forgot to filter on
      // SyncDirection would be caught by a test rather than by a requester.
      {
        SyncDirection: 'CUSTOMER_TO_BP',
        BPGrouping: 'ZZZZ',
        CustomerAccountGroup: 'ZZZZ',
        HasSameNumber: false,
        BPNumberRange: 'AB',
        CustomerNumberRange: 'XX'
      }
    ],
    CviSupplierNumberAssignments: [
      {
        SyncDirection: 'BP_TO_VENDOR',
        BPGrouping: '0002',
        SupplierAccountGroup: 'LIEF',
        HasSameNumber: false,
        BPNumberRange: 'AB',
        SupplierNumberRange: 'XX'
      }
    ]
  }
});

const withConfig = (overrides = {}) => async () => ({ ...CONFIG, ...overrides });

const payload = (category, roles = [], grouping) => ({
  root: { BusinessPartnerCategory: category, BusinessPartnerGrouping: grouping },
  sections: { BusinessPartnerRoles: roles }
});

const stage = (read) => createCviStages({ read }).validations[0];

test.beforeEach(() => invalidate());

test('a role the category may not carry is reported against its own row', async () => {
  const found = await stage(withConfig()).run(payload('1', [{ BusinessPartnerRole: 'FLCU01' }]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'warning');
  assert.strictEqual(found[0].target, 'BusinessPartnerRoles');
  assert.strictEqual(found[0].index, 0);
  assert.strictEqual(found[0].field, 'BusinessPartnerRole');
  assert.match(found[0].message, /FLCU01 \(Customer\)/u);
  assert.match(found[0].message, /person/u);
});

/**
 * The bug under the bug. Every flag in these sets arrives as a boolean, so a rule that only
 * recognises 'X' reads *every* row as blank: first that meant "forbidden" and the rule fired on
 * FLCU01 on an organisation, then the fix for that ("no flags set restricts nothing") made it
 * permanently silent instead. Both representations have to work.
 */
test('flags are recognised as booleans and as X', () => {
  assert.strictEqual(_internals.isSet(true), true);
  assert.strictEqual(_internals.isSet('X'), true);
  assert.strictEqual(_internals.isSet('x'), true);
  assert.strictEqual(_internals.isSet(false), false);
  assert.strictEqual(_internals.isSet(''), false);
  assert.strictEqual(_internals.isSet(' '), false);
  assert.strictEqual(_internals.isSet(undefined), false);
  assert.strictEqual(_internals.isSet(null), false);
});

test('every offending role is reported, not just the first', async () => {
  const found = await stage(withConfig()).run(
    payload('3', [{ BusinessPartnerRole: 'FLCU01' }, { BusinessPartnerRole: 'BUP001' }])
  );
  // BUP001 is allowed for a group, FLCU01 is not.
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].index, 0);
});

/**
 * A row with none of the three flags set says nothing rather than forbidding everything. Kept as a
 * guard: on S4A all 166 TB003A rows have at least one flag set, so this is not a description of
 * that system -- the earlier claim that its flags were unmaintained was wrong.
 */
test('a role category with none of the three flags maintained restricts nothing', async () => {
  const read = withConfig({
    categories: [{
      BPRoleCategory: 'FLCU01',
      IsAllowedForPerson: false,
      IsAllowedForOrganization: false,
      IsAllowedForGroup: false
    }]
  });
  for (const category of ['1', '2', '3']) {
    assert.deepStrictEqual(
      await stage(read).run(payload(category, [{ BusinessPartnerRole: 'FLCU01' }])),
      [],
      `category ${category}`
    );
    invalidate();
  }
});

test('postprocessing switched off is reported when the request asks for a role', async () => {
  const read = withConfig({
    postprocessing: [{ SynchronizationObject: 'BP', IsPostprocessingActive: false }]
  });
  const found = await stage(read).run(payload('2', [{ BusinessPartnerRole: 'FLCU01' }]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'warning');
  assert.match(found[0].message, /Postprocessing is switched off/u);
  assert.match(found[0].message, /BP/u);
});

// --- Number assignment -----------------------------------------------------------------------

test('which sync targets a request reaches for comes from S/4, not from the role name', () => {
  const targets = (roles) => _internals
    .requestedSyncTargets(payload('2', roles), CONFIG)
    .map((entry) => entry.target.key);

  assert.deepStrictEqual(targets([{ BusinessPartnerRole: 'FLCU01' }]), ['customer']);
  assert.deepStrictEqual(targets([{ BusinessPartnerRole: 'FLVN01' }]), ['supplier']);
  assert.deepStrictEqual(
    targets([{ BusinessPartnerRole: 'FLCU01' }, { BusinessPartnerRole: 'FLVN01' }]),
    ['customer', 'supplier']
  );
  // A contact person becomes neither, so no number assignment applies to it at all.
  assert.deepStrictEqual(targets([{ BusinessPartnerRole: 'BUP001' }]), []);
});

test('same number set but intervals that differ names both ranges and both intervals', async () => {
  const found = await stage(withConfig()).run(
    payload('2', [{ BusinessPartnerRole: 'FLCU01' }], 'S110')
  );
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'warning');
  assert.strictEqual(found[0].field, 'BusinessPartnerGrouping');
  assert.match(found[0].message, /same number/u);
  assert.match(found[0].message, /01 is 0000000001-0999999999/u);
  assert.match(found[0].message, /XX is A-ZZZZZZZZZZ/u);
});

test('an externally numbered account group with no same-number flag is reported', async () => {
  const found = await stage(withConfig()).run(
    payload('2', [{ BusinessPartnerRole: 'FLCU01' }], '0002')
  );
  assert.strictEqual(found.length, 1);
  assert.match(found[0].message, /external number range XX/u);
  assert.match(found[0].message, /same number/u);
});

test('a grouping with no assignment at all is reported, naming the roles that need one', async () => {
  const found = await stage(withConfig()).run(
    payload('2', [{ BusinessPartnerRole: 'FLCU01' }], 'MDM0')
  );
  assert.strictEqual(found.length, 1);
  assert.match(found[0].message, /Role FLCU01/u);
  assert.match(found[0].message, /grouping MDM0 has no customer account group/u);
});

test('a switched-off direction is reported and the ranges are not then second-guessed', async () => {
  const read = withConfig({
    directions: [{ SourceObject: 'BP', TargetObject: 'CUSTOMER', IsActive: false }]
  });
  const found = await stage(read).run(payload('2', [{ BusinessPartnerRole: 'FLCU01' }], '0002'));
  assert.strictEqual(found.length, 1);
  assert.match(found[0].message, /not active in S\/4/u);
});

test('customer and supplier are judged separately in one pass', async () => {
  const found = await stage(withConfig()).run(payload(
    '2',
    [{ BusinessPartnerRole: 'FLCU01' }, { BusinessPartnerRole: 'FLVN01' }],
    '0002'
  ));
  assert.strictEqual(found.length, 2);
  assert.match(found[0].message, /customer/u);
  assert.match(found[1].message, /supplier/u);
});

test('the inbound direction rows are never read as if they were outbound', async () => {
  const found = await stage(withConfig()).run(
    payload('2', [{ BusinessPartnerRole: 'FLCU01' }], 'ZZZZ')
  );
  // ZZZZ exists only as a CUSTOMER_TO_BP row, so this is "nothing maintained", not a range verdict.
  assert.strictEqual(found.length, 1);
  assert.match(found[0].message, /no customer account group/u);
});

// --- Account group derivation ------------------------------------------------------------------

const derivation = (read) => createCviStages({ read }).derivations[0];

test('the account group is derived from the grouping S/4 assigns it to', async () => {
  const entries = await derivation(withConfig()).run(
    payload('2', [{ BusinessPartnerRole: 'FLCU01' }], '0001')
  );
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].target, 'Customers');
  assert.strictEqual(entries[0].field, 'CustomerAccountGroup');
  assert.strictEqual(entries[0].value, 'DEBI');
  assert.strictEqual(entries[0].createsRow, true);
  assert.match(entries[0].message, /not a free choice/u);
});

test('the derivation creates the row it needs when the section is empty', async () => {
  const request = payload('2', [{ BusinessPartnerRole: 'FLVN01' }], '0002');
  const { derived, applied } = await runDerivations(request, [derivation(withConfig())]);

  // `__state` marks the row as one the pipeline built, so the S/4 check sends it as an insert.
  assert.deepStrictEqual(derived.sections.Suppliers, [{ SupplierAccountGroup: 'LIEF', __state: 'new' }]);
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].check, 'cvi_account_group');
  assert.strictEqual(applied[0].severity, 'info');
});

// It used to say nothing at all here, and `accountGroupConflictFindings` existed to explain the
// silence. Since 2026-09-03 the account group TBD001 decides is proposed over the typed one -
// still a proposal, so a requester who means it unticks the row and keeps theirs; the conflict
// finding stays, because S/4 uses TBD001's either way.
test('the derivation proposes over an account group somebody typed', async () => {
  const request = payload('2', [{ BusinessPartnerRole: 'FLVN01' }], '0002');
  request.sections.Suppliers = [{ SupplierAccountGroup: 'KRED' }];
  const { derived, applied } = await runDerivations(request, [derivation(withConfig())]);

  assert.strictEqual(derived.sections.Suppliers[0].SupplierAccountGroup, 'LIEF');
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].overwrites, true);
  assert.strictEqual(applied[0].current, 'KRED');
  assert.strictEqual(applied[0].system, true);
});

// The check Maarten asked for: an accepted proposal must not come back on the next press.
test('the derivation says nothing when the typed account group is already the derived one', async () => {
  const request = payload('2', [{ BusinessPartnerRole: 'FLVN01' }], '0002');
  request.sections.Suppliers = [{ SupplierAccountGroup: 'LIEF' }];
  const { applied } = await runDerivations(request, [derivation(withConfig())]);

  assert.deepStrictEqual(applied, []);
});

test('both account groups are derived when the request asks for both', async () => {
  const request = payload(
    '2',
    [{ BusinessPartnerRole: 'FLCU01' }, { BusinessPartnerRole: 'FLVN01' }],
    '0002'
  );
  const { derived } = await runDerivations(request, [derivation(withConfig())]);
  assert.strictEqual(derived.sections.Customers[0].CustomerAccountGroup, 'KUNA');
  assert.strictEqual(derived.sections.Suppliers[0].SupplierAccountGroup, 'LIEF');
});

test('nothing is derived where nothing is certain', async () => {
  const cases = [
    ['no grouping', payload('2', [{ BusinessPartnerRole: 'FLCU01' }])],
    ['no assignment for the grouping', payload('2', [{ BusinessPartnerRole: 'FLCU01' }], 'MDM0')],
    ['a role that creates nothing', payload('2', [{ BusinessPartnerRole: 'BUP001' }], '0001')],
    // ZZZZ exists only as an inbound CUSTOMER_TO_BP row.
    ['an inbound-only row', payload('2', [{ BusinessPartnerRole: 'FLCU01' }], 'ZZZZ')]
  ];
  for (const [name, request] of cases) {
    assert.deepStrictEqual(await derivation(withConfig()).run(request), [], name);
    invalidate();
  }
});

test('an account group that contradicts the grouping is reported against its own row', async () => {
  const request = payload('2', [{ BusinessPartnerRole: 'FLCU01' }], '0001');
  request.sections.Customers = [{ CustomerAccountGroup: 'KUNA' }];
  const found = await stage(withConfig()).run(request);

  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'warning');
  assert.strictEqual(found[0].target, 'Customers');
  assert.strictEqual(found[0].index, 0);
  assert.strictEqual(found[0].field, 'CustomerAccountGroup');
  assert.match(found[0].message, /KUNA was entered/u);
  assert.match(found[0].message, /assigned to DEBI/u);
});

test('a configuration that cannot be read reports itself and never blocks', async () => {
  const read = async () => { throw new Error('S/4 is unreachable'); };
  const found = await stage(read).run(payload('1', [{ BusinessPartnerRole: 'FLCU01' }]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'warning');
  assert.notStrictEqual(found[0].severity, 'error');
  assert.match(found[0].message, /could not be read/u);
  assert.match(found[0].message, /S\/4 is unreachable/u);
});

// The one system derivation in the app: it is what CVI will use whatever anybody ticks, and it is
// what makes the Customers/Suppliers node exist for the customer and vendor tiers of the S/4 check.
test('the account group derivation is marked system and labelled in three words', async () => {
  const request = payload('2', [{ BusinessPartnerRole: 'FLVN01' }], '0002');
  const { applied } = await runDerivations(request, [derivation(withConfig())]);

  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].system, true);
  assert.strictEqual(applied[0].label, 'CVI customizing');
  assert.ok(applied[0].label.split(' ').length <= 3);
});
