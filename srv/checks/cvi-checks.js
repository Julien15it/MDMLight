'use strict';

/**
 * Validations against the S/4 Customer/Vendor Integration customizing, read over
 * `CviConfigService`'s remote service (`srv/cvi-config-service.cds`).
 *
 * What this answers: **will the partner being requested actually synchronise?** CVI turns a
 * business partner into a customer and a supplier, and whether it can is decided by customizing
 * nobody filling in this form can see. A role the BP category is not allowed to carry is accepted
 * by the screen, staged, approved, and only then refused by S/4 -- after an approver has spent
 * their time on it.
 *
 * What it deliberately does NOT do is reproduce SAP's own check report. Transaction
 * CVI_FS_CHECK_CUST is a module pool with no callable API, its verdicts move with support packages,
 * and copying them means chasing them. These rules are derived from the configuration itself and
 * are stated in terms of the request in front of the requester.
 */

const cds = require('@sap/cds');

const SERVICE = 'ZSRVB_MDMLIGHT_VH';

// Same 60s TTL as rule-store.js and field-property-store.js. The configuration is customizing:
// it changes when somebody transports, not while a form is being filled in.
const TTL_MS = 60000;

/**
 * Warning, not error, and this is the knob. A mismatch here is a statement about S/4's customizing
 * as this app reads it, and the cost of the two failures is not symmetric: a warning on a
 * combination that would have worked is noise, while blocking one is a requester who cannot submit
 * a legitimate partner and has no way to argue with it. Move to 'error' once the rule has been seen
 * to be right on real data at a real customer.
 */
const ROLE_CATEGORY_SEVERITY = 'warning';

/** Same reasoning, same knob, for the number assignment rules below. */
const NUMBER_ASSIGNMENT_SEVERITY = 'warning';

// BusinessPartnerCategory -> the TB003A flag that says the role category may be used for it.
const CATEGORY_FLAG = Object.freeze({
  1: { field: 'IsAllowedForPerson', label: 'person' },
  2: { field: 'IsAllowedForOrganization', label: 'organisation' },
  3: { field: 'IsAllowedForGroup', label: 'group' }
});

const RESTRICTION_FLAGS = Object.freeze(
  Object.values(CATEGORY_FLAG).map((entry) => entry.field)
);

/**
 * The two things a BP role can turn into, and everything that differs between them. One object per
 * target rather than two near-identical code paths: the customer and supplier rules are the same
 * rules over different tables, and writing them twice is how they drift apart.
 *
 * `direction` is the outbound row (BP -> Customer / BP -> Vendor). The inbound rows
 * (CUSTOMER_TO_BP, VENDOR_TO_BP) are in the same remote sets and describe the opposite journey --
 * a customer created in S/4 becoming a BP. MDM Light only ever creates business partners, so
 * nothing here reads them; they are exposed because leaving half a table behind is how the next
 * person ends up re-deriving where it lives.
 */
const SYNC_TARGETS = Object.freeze([
  Object.freeze({
    key: 'customer',
    label: 'customer',
    set: 'CviCustomerNumberAssignments',
    direction: 'BP_TO_CUSTOMER',
    syncObject: 'CUSTOMER',
    accountGroupField: 'CustomerAccountGroup',
    accountRangeField: 'CustomerNumberRange',
    numberRangeObject: 'DEBITOR',
    createsFlags: Object.freeze(['CreatesCustomerMandatory', 'CreatesCustomerOptional']),
    // Where the derived account group lands. Both are single nodes (`many: false` in
    // PAYLOAD_NODES) but the UI still sends them as one-element arrays, so index 0 is the row.
    section: 'Customers',
    payloadField: 'CustomerAccountGroup'
  }),
  Object.freeze({
    key: 'supplier',
    label: 'supplier',
    set: 'CviSupplierNumberAssignments',
    direction: 'BP_TO_VENDOR',
    syncObject: 'VENDOR',
    accountGroupField: 'SupplierAccountGroup',
    accountRangeField: 'SupplierNumberRange',
    numberRangeObject: 'KREDITOR',
    createsFlags: Object.freeze(['CreatesSupplierMandatory', 'CreatesSupplierOptional']),
    section: 'Suppliers',
    payloadField: 'SupplierAccountGroup'
  })
]);

const BP_NUMBER_RANGE_OBJECT = 'BU_PARTNER';
const BP_SYNC_OBJECT = 'BP';

/**
 * A CHAR(1) flag in S/4 is an 'X' or a blank; over OData the same flag arrives as `true` or
 * `false`, because the import maps flag data elements to Edm.Boolean -- every one of these sets
 * does (see `srv/external/ZSRVB_MDMLIGHT_VH.cds`).
 *
 * **Comparing only against 'X' is what made the role category rule wrong twice.** With booleans
 * on the wire, `'X' === true` is false for every row: the first version read that as "not
 * allowed" and fired on `FLCU01` on an organisation, and the fix for that -- treat a row with no
 * flags set as unrestricted -- then made the rule permanently silent, because with booleans no row
 * ever *looks* like it has a flag set. Accepting both representations is what makes it work at
 * all.
 */
const isSet = (value) => {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  const text = String(value).trim().toUpperCase();
  return text === 'X' || text === 'TRUE';
};

const text = (value) => String(value ?? '').trim();

let cache = null;

function invalidate() {
  cache = null;
}

async function readConfiguration() {
  const service = await cds.connect.to(SERVICE);
  const [
    roles,
    categories,
    postprocessing,
    numberRanges,
    customerAssignments,
    supplierAssignments,
    directions
  ] = await Promise.all([
    service.run(cds.ql.SELECT.from('CviBusinessPartnerRoles')),
    service.run(cds.ql.SELECT.from('CviRoleCategories')),
    service.run(cds.ql.SELECT.from('CviPostprocessingControl')),
    service.run(cds.ql.SELECT.from('CviNumberRanges')),
    service.run(cds.ql.SELECT.from('CviCustomerNumberAssignments')),
    service.run(cds.ql.SELECT.from('CviSupplierNumberAssignments')),
    service.run(cds.ql.SELECT.from('CviSyncDirections'))
  ]);
  return {
    roles: roles || [],
    categories: categories || [],
    postprocessing: postprocessing || [],
    numberRanges: numberRanges || [],
    assignments: {
      CviCustomerNumberAssignments: customerAssignments || [],
      CviSupplierNumberAssignments: supplierAssignments || []
    },
    directions: directions || []
  };
}

async function configuration(read = readConfiguration, now = Date.now()) {
  if (cache && cache.until > now) return cache.value;
  const value = await read();
  cache = { value, until: now + TTL_MS };
  return value;
}

/** The rows of a section that will still exist after the request posts. */
function liveRows(payload, section) {
  const rows = payload?.sections?.[section];
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => String(row?.action || 'C').toUpperCase() !== 'D');
}

/**
 * A role the BP category may not carry. S/4 refuses the combination on the post, so catching it
 * here is the difference between a requester fixing it now and an approver discovering it later.
 */
function roleCategoryFindings(payload, { roles, categories }) {
  const category = text(payload?.root?.BusinessPartnerCategory);
  const requested = liveRows(payload, 'BusinessPartnerRoles');
  if (!category || !requested.length) return [];

  const flag = CATEGORY_FLAG[category];
  // A category outside 1/2/3 is not something this check can judge, and saying nothing is more
  // honest than guessing which flag to read.
  if (!flag) return [];

  const categoryOf = new Map(roles.map((row) => [row.BPRole, row]));
  const allowed = new Map(categories.map((row) => [row.BPRoleCategory, row]));
  const findings = [];

  for (const [index, row] of requested.entries()) {
    const role = text(row?.BusinessPartnerRole);
    if (!role) continue;

    const definition = categoryOf.get(role);
    if (!definition) {
      findings.push({
        severity: 'info',
        target: 'BusinessPartnerRoles',
        index,
        field: 'BusinessPartnerRole',
        message: `Role ${role} is not in the S/4 role table, so its business partner category could not be checked.`
      });
      continue;
    }

    const rules = allowed.get(definition.BPRoleCategory);
    if (!rules) {
      findings.push({
        severity: 'info',
        target: 'BusinessPartnerRoles',
        index,
        field: 'BusinessPartnerRole',
        message: `Role ${role} belongs to role category ${definition.BPRoleCategory}, which has no CVI configuration.`
      });
      continue;
    }

    // A category with NONE of the three flags set expresses no restriction: read literally, such a
    // row forbids every BP category at once, which is not a configuration anybody creates. Kept as
    // a guard, not as a description of any system we have seen -- on S4A all 166 TB003A rows have
    // at least one flag set, so this branch is never taken there.
    if (!RESTRICTION_FLAGS.some((field) => isSet(rules[field]))) continue;

    if (isSet(rules[flag.field])) continue;

    const name = definition.BPRoleName ? `${role} (${definition.BPRoleName})` : role;
    findings.push({
      severity: ROLE_CATEGORY_SEVERITY,
      target: 'BusinessPartnerRoles',
      index,
      field: 'BusinessPartnerRole',
      message: `Role ${name} has role category ${definition.BPRoleCategory}, which S/4 does not allow for a ${flag.label}. This partner will not synchronise.`
    });
  }

  return findings;
}

/**
 * Postprocessing off means a synchronisation error is dropped rather than queued for somebody to
 * fix -- so the partner silently never becomes a customer and nobody is told. Only worth saying
 * when this request actually asks for a role, and reported per row rather than against a
 * hardcoded sync object name, which would silently match nothing if S/4 spells it differently.
 */
function postprocessingFindings(payload, { postprocessing }) {
  if (!liveRows(payload, 'BusinessPartnerRoles').length) return [];
  return postprocessing
    .filter((row) => !isSet(row?.IsPostprocessingActive))
    .map((row) => ({
      severity: 'warning',
      message: `Postprocessing is switched off for synchronisation object ${row.SynchronizationObject} in S/4. A synchronisation error on this partner will be dropped rather than queued for correction.`
    }));
}

/**
 * Which of the two sync targets this request actually reaches for, and the roles that ask for it.
 *
 * TBD002 / TBC002 answer this in S/4 and are exposed on `CviRoleCategories` as the four
 * `Creates...` flags. Mandatory and optional are both counted: an optional customer is still a
 * customer the moment somebody ticks it, and the number assignment has to be right either way.
 *
 * A role whose category says nothing about customers or suppliers reaches neither, and says
 * nothing here -- which is the point of asking S/4 instead of pattern-matching on role names like
 * `FLCU*`.
 */
function requestedSyncTargets(payload, { roles, categories }) {
  const categoryOf = new Map(roles.map((row) => [row.BPRole, row.BPRoleCategory]));
  const settings = new Map(categories.map((row) => [row.BPRoleCategory, row]));
  const asked = new Map();

  for (const row of liveRows(payload, 'BusinessPartnerRoles')) {
    const role = text(row?.BusinessPartnerRole);
    if (!role) continue;
    const rules = settings.get(categoryOf.get(role));
    if (!rules) continue;

    for (const target of SYNC_TARGETS) {
      if (!target.createsFlags.some((field) => isSet(rules[field]))) continue;
      if (!asked.has(target.key)) asked.set(target.key, { target, roles: [] });
      asked.get(target.key).roles.push(role);
    }
  }

  return [...asked.values()];
}

/**
 * MDSC_CTRL_OPT_A holds only what has been switched on, so a direction with no row at all is a
 * direction that is off. Shared by the rule and the derivation on purpose: a derivation that
 * filled in an account group for a direction the warning had just called dead would be worse than
 * either on its own.
 */
function directionIsActive(directions, target) {
  return directions.some((row) => text(row?.SourceObject) === BP_SYNC_OBJECT
    && text(row?.TargetObject) === target.syncObject
    && isSet(row?.IsActive));
}

/** The outbound rows for one grouping. TBD001/TBC001 are keyed by grouping, so this is 0 or 1. */
function assignmentsFor(assignments, target, grouping) {
  return (assignments[target.set] || []).filter(
    (row) => text(row?.SyncDirection) === target.direction && text(row?.BPGrouping) === grouping
  );
}

/** The one assignment row a decision may be based on, or null when there is nothing to be sure of. */
function soleAssignment(config, target, grouping) {
  const rows = assignmentsFor(config.assignments, target, grouping);
  // More than one row for a grouping should not exist, and if S/4 ever produces it the honest
  // answer is to derive nothing rather than pick a winner.
  return rows.length === 1 ? rows[0] : null;
}

function intervalOf(numberRanges, object, number) {
  if (!number) return null;
  return numberRanges.find(
    (row) => text(row?.NumberRangeObject) === object && text(row?.NumberRangeNumber) === number
  ) || null;
}

const describe = (interval) => `${text(interval.FromNumber)}-${text(interval.ToNumber)}`;

/**
 * The rule this whole exercise was for: **does the grouping on this request line up with the
 * account group CVI will use, so that a number actually gets assigned?**
 *
 * `CVI_FS_CHECK_CUST_SUBROUTINES` (forms `check_customer_numbers` / `check_vendor_numbers`) is the
 * reference for the first two rules; it reads the same tables this now exposes. It does *not*
 * cover the last two, and they are the ones that fire on S4A.
 *
 * 1. Nothing maintained. No row in TBD001/TBC001 for the grouping means CVI has no account group
 *    to create the account with. Nine of S4A's 23 groupings have no customer row and fifteen have
 *    no supplier row, `MDM0` among them.
 * 2. Direction switched off. MDSC_CTRL_OPT_A missing the row, or holding it inactive, means the
 *    account is silently never created. SAP's report checks the mirror image of this -- "maintained
 *    but inactive" -- and never this direction.
 * 3. Same number set, intervals differ. Message 023 of `CVI_FS_CHECK_CUST`, spelled out with both
 *    ranges and both intervals named, because "the number ranges do not match" without them sends
 *    the reader to two SPRO screens to find out which.
 * 4. Same number not set and the account's range is external. Nobody supplies that number: the
 *    requester cannot (there is no field for it) and CVI will not (the range is not its to draw
 *    from). This is messages 022/031 turned around -- SAP checks it for the inbound direction only.
 */
function numberAssignmentFindings(payload, config) {
  const grouping = text(payload?.root?.BusinessPartnerGrouping);
  if (!grouping) return [];

  const requested = requestedSyncTargets(payload, config);
  if (!requested.length) return [];

  const { numberRanges, assignments, directions } = config;
  const findings = [];
  const say = (message) => findings.push({
    severity: NUMBER_ASSIGNMENT_SEVERITY,
    field: 'BusinessPartnerGrouping',
    message
  });

  for (const { target, roles } of requested) {
    const asking = `${roles.length > 1 ? 'Roles' : 'Role'} ${roles.join(', ')}`;

    if (!directionIsActive(directions, target)) {
      say(`${asking} would create a ${target.label}, but synchronisation from business partner to ${target.label} is not active in S/4. No ${target.label} will be created for this partner.`);
      continue;
    }

    const rows = assignmentsFor(assignments, target, grouping);
    if (!rows.length) {
      say(`${asking} would create a ${target.label}, but grouping ${grouping} has no ${target.label} account group assigned in S/4. CVI has no account group to create the ${target.label} with.`);
      continue;
    }

    for (const row of rows) {
      const accountGroup = text(row[target.accountGroupField]);
      const bpRangeNumber = text(row.BPNumberRange);
      const accountRangeNumber = text(row[target.accountRangeField]);

      if (!bpRangeNumber) {
        say(`Grouping ${grouping} has no number range in S/4, so a business partner number cannot be assigned.`);
        continue;
      }
      if (!accountRangeNumber) {
        say(`${target.label.replace(/^./, (first) => first.toUpperCase())} account group ${accountGroup} has no number range in S/4, so a ${target.label} number cannot be assigned to this partner.`);
        continue;
      }

      const bpRange = intervalOf(numberRanges, BP_NUMBER_RANGE_OBJECT, bpRangeNumber);
      const accountRange = intervalOf(numberRanges, target.numberRangeObject, accountRangeNumber);
      if (!bpRange) {
        say(`Number range ${bpRangeNumber} of grouping ${grouping} does not exist for number range object ${BP_NUMBER_RANGE_OBJECT} in S/4.`);
        continue;
      }
      if (!accountRange) {
        say(`Number range ${accountRangeNumber} of ${target.label} account group ${accountGroup} does not exist for number range object ${target.numberRangeObject} in S/4.`);
        continue;
      }

      if (isSet(row.HasSameNumber)) {
        if (text(bpRange.FromNumber) !== text(accountRange.FromNumber)
          || text(bpRange.ToNumber) !== text(accountRange.ToNumber)) {
          say(`Grouping ${grouping} and ${target.label} account group ${accountGroup} are set to use the same number, but their intervals differ: business partner range ${bpRangeNumber} is ${describe(bpRange)} and ${target.label} range ${accountRangeNumber} is ${describe(accountRange)}. The ${target.label} cannot take the business partner's number.`);
        }
        continue;
      }

      if (isSet(accountRange.IsExternalNumberRange)) {
        say(`${target.label.replace(/^./, (first) => first.toUpperCase())} account group ${accountGroup} uses external number range ${accountRangeNumber} (${describe(accountRange)}) and grouping ${grouping} is not set to give the ${target.label} the same number. Nothing assigns that number, so the ${target.label} cannot be created.`);
      }
    }
  }

  return findings;
}

/**
 * The account group a requester should not have to look up. For direction BP -> Customer, S/4
 * takes the customer account group from TBD001 by grouping -- it is not a free choice, it is a
 * lookup, and until now the only place it existed was a SPRO screen the requester cannot see.
 *
 * Fills `Customers.CustomerAccountGroup` and `Suppliers.SupplierAccountGroup`. The pipeline
 * enforces the two rules that matter: it never overwrites a value somebody typed, and `createsRow`
 * only invents a row when the section is completely empty -- so a request that already carries
 * supplier data gets the field filled, and one that carries none gets the row it needs.
 *
 * Deliberately silent where it cannot be sure: no grouping, no role that creates the account, an
 * inactive direction, no assignment row, or more than one. The last case should not exist -- TBD001
 * is keyed by grouping -- and if S/4 ever produces it, deriving nothing beats picking a winner.
 * `numberAssignmentFindings` already says out loud why nothing was filled in.
 */
function accountGroupEntries(payload, config) {
  const grouping = text(payload?.root?.BusinessPartnerGrouping);
  if (!grouping) return [];

  const entries = [];
  for (const { target, roles } of requestedSyncTargets(payload, config)) {
    if (!directionIsActive(config.directions, target)) continue;

    const assignment = soleAssignment(config, target, grouping);
    if (!assignment) continue;

    const accountGroup = text(assignment[target.accountGroupField]);
    if (!accountGroup) continue;

    entries.push({
      target: target.section,
      index: 0,
      field: target.payloadField,
      value: accountGroup,
      createsRow: true,
      message: `${target.label.replace(/^./, (first) => first.toUpperCase())} account group ${accountGroup} comes from grouping ${grouping} in the S/4 CVI customizing, which ${roles.join(', ')} needs. It is not a free choice: this is the account group CVI will use.`
    });
  }

  return entries;
}

/**
 * The other half of the derivation. Because a derivation never overwrites a typed value, a
 * requester who picks a different account group by hand silently gets their own -- and then S/4
 * uses TBD001's anyway. Saying so is the whole point of this module: accepted by the screen,
 * refused or quietly overridden by S/4, discovered by an approver.
 */
function accountGroupConflictFindings(payload, config) {
  const grouping = text(payload?.root?.BusinessPartnerGrouping);
  if (!grouping) return [];

  const findings = [];
  for (const { target } of requestedSyncTargets(payload, config)) {
    if (!directionIsActive(config.directions, target)) continue;

    const assignment = soleAssignment(config, target, grouping);
    if (!assignment) continue;

    const expected = text(assignment[target.accountGroupField]);
    const typed = text(liveRows(payload, target.section)[0]?.[target.payloadField]);
    if (!expected || !typed || typed === expected) continue;

    findings.push({
      severity: NUMBER_ASSIGNMENT_SEVERITY,
      target: target.section,
      index: 0,
      field: target.payloadField,
      message: `${target.label.replace(/^./, (first) => first.toUpperCase())} account group ${typed} was entered, but grouping ${grouping} is assigned to ${expected} in the S/4 CVI customizing. CVI takes the account group from the grouping, so ${expected} is what this partner will get.`
    });
  }

  return findings;
}

/**
 * One validation stage, not four: the pipeline blocks on the first error a validation stage
 * reports, and a requester should see everything wrong with their roles at once rather than one
 * per press. One derivation beside it, which the pipeline runs *after* the validations -- so the
 * conflict finding above is judged on what the requester typed, not on what was just filled in.
 */
function createCviStages({ read = readConfiguration } = {}) {
  const load = async () => configuration(read);

  return {
    derivations: [{
      name: 'cvi_account_group',
      async run(payload) {
        let config;
        try {
          config = await load();
        } catch (error) {
          // An improvement, not a gate. The pipeline turns a thrown derivation into an info line
          // and carries on, but saying which lookup failed beats a bare stack message.
          return [{
            message: `The CVI configuration could not be read (${error.message}), so the account group was not derived.`
          }];
        }
        return accountGroupEntries(payload, config);
      }
    }],
    validations: [{
      name: 'cvi_configuration',
      async run(payload) {
        let config;
        try {
          config = await load();
        } catch (error) {
          // Reported, never blocking. The pipeline turns a thrown validation into a blocking
          // error, which would be more severe than anything this stage itself reports -- an
          // unreachable S/4 would stop every submit over a warning. Saying it could not run keeps
          // "no findings" from reading as "checked and fine".
          return [{
            severity: 'warning',
            message: `The CVI configuration could not be read (${error.message}), so this partner's roles were not checked against it.`
          }];
        }
        return [
          ...roleCategoryFindings(payload, config),
          ...postprocessingFindings(payload, config),
          ...numberAssignmentFindings(payload, config),
          ...accountGroupConflictFindings(payload, config)
        ];
      }
    }]
  };
}

module.exports = {
  createCviStages,
  invalidate,
  ROLE_CATEGORY_SEVERITY,
  NUMBER_ASSIGNMENT_SEVERITY,
  _internals: {
    configuration,
    roleCategoryFindings,
    postprocessingFindings,
    numberAssignmentFindings,
    accountGroupEntries,
    accountGroupConflictFindings,
    requestedSyncTargets,
    liveRows,
    isSet
  }
};
