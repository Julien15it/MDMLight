'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createCviStages, invalidate } = require('../srv/checks/cvi-checks');

// FLCU01 is a customer role on an organisation-only category; BUP001 is allowed for all three.
const CONFIG = Object.freeze({
  roles: [
    { BPRole: 'FLCU01', BPRoleName: 'Customer', BPRoleCategory: 'FLCU01' },
    { BPRole: 'BUP001', BPRoleName: 'Contact Person', BPRoleCategory: 'BUP001' }
  ],
  categories: [
    {
      BPRoleCategory: 'FLCU01',
      IsAllowedForPerson: '',
      IsAllowedForOrganization: 'X',
      IsAllowedForGroup: ''
    },
    {
      BPRoleCategory: 'BUP001',
      IsAllowedForPerson: 'X',
      IsAllowedForOrganization: 'X',
      IsAllowedForGroup: 'X'
    }
  ],
  postprocessing: [{ SynchronizationObject: 'BP', IsPostprocessingActive: 'X' }]
});

const withConfig = (overrides = {}) => async () => ({ ...CONFIG, ...overrides });

const payload = (category, roles = []) => ({
  root: { BusinessPartnerCategory: category },
  sections: { BusinessPartnerRoles: roles }
});

const stage = (read) => createCviStages({ read }).validations[0];

test.beforeEach(() => invalidate());

test('a role its business partner category may carry reports nothing', async () => {
  const found = await stage(withConfig()).run(payload('2', [{ BusinessPartnerRole: 'FLCU01' }]));
  assert.deepStrictEqual(found, []);
});

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

test('every offending role is reported, not just the first', async () => {
  const found = await stage(withConfig()).run(
    payload('3', [{ BusinessPartnerRole: 'FLCU01' }, { BusinessPartnerRole: 'BUP001' }])
  );
  // BUP001 is allowed for a group, FLCU01 is not.
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].index, 0);
});

test('a role S/4 does not know is reported as info, never as a mismatch', async () => {
  const found = await stage(withConfig()).run(payload('1', [{ BusinessPartnerRole: 'ZZZZZZ' }]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'info');
  assert.match(found[0].message, /not in the S\/4 role table/u);
});

test('a role row being deleted is not judged', async () => {
  const found = await stage(withConfig()).run(
    payload('1', [{ BusinessPartnerRole: 'FLCU01', action: 'D' }])
  );
  assert.deepStrictEqual(found, []);
});

test('an unknown business partner category is not guessed at', async () => {
  const found = await stage(withConfig()).run(payload('9', [{ BusinessPartnerRole: 'FLCU01' }]));
  assert.deepStrictEqual(found, []);
});

test('postprocessing switched off is reported when the request asks for a role', async () => {
  const read = withConfig({
    postprocessing: [{ SynchronizationObject: 'BP', IsPostprocessingActive: '' }]
  });
  const found = await stage(read).run(payload('2', [{ BusinessPartnerRole: 'FLCU01' }]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'warning');
  assert.match(found[0].message, /Postprocessing is switched off/u);
  assert.match(found[0].message, /BP/u);
});

test('postprocessing is not mentioned when no role is requested', async () => {
  const read = withConfig({
    postprocessing: [{ SynchronizationObject: 'BP', IsPostprocessingActive: '' }]
  });
  assert.deepStrictEqual(await stage(read).run(payload('2', [])), []);
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

test('the configuration is read once and cached across runs', async () => {
  let reads = 0;
  const read = async () => { reads += 1; return CONFIG; };
  const validation = stage(read);
  await validation.run(payload('2', [{ BusinessPartnerRole: 'FLCU01' }]));
  await validation.run(payload('2', [{ BusinessPartnerRole: 'FLCU01' }]));
  assert.strictEqual(reads, 1);
});
