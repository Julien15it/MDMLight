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

// BusinessPartnerCategory -> the TB003A flag that says the role category may be used for it.
const CATEGORY_FLAG = Object.freeze({
  1: { field: 'IsAllowedForPerson', label: 'person' },
  2: { field: 'IsAllowedForOrganization', label: 'organisation' },
  3: { field: 'IsAllowedForGroup', label: 'group' }
});

const RESTRICTION_FLAGS = Object.freeze(
  Object.values(CATEGORY_FLAG).map((entry) => entry.field)
);

const isSet = (value) => String(value || '').trim().toUpperCase() === 'X';

let cache = null;

function invalidate() {
  cache = null;
}

async function readConfiguration() {
  const service = await cds.connect.to(SERVICE);
  const [roles, categories, postprocessing] = await Promise.all([
    service.run(cds.ql.SELECT.from('CviBusinessPartnerRoles')),
    service.run(cds.ql.SELECT.from('CviRoleCategories')),
    service.run(cds.ql.SELECT.from('CviPostprocessingControl'))
  ]);
  return { roles: roles || [], categories: categories || [], postprocessing: postprocessing || [] };
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
  const category = String(payload?.root?.BusinessPartnerCategory || '').trim();
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
    const role = String(row?.BusinessPartnerRole || '').trim();
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

    // A category with NONE of the three flags set expresses no restriction, and this is the bug
    // that shipped first: read literally, such a row forbids every BP category at once, which is
    // not a configuration anybody creates. Most systems simply never maintain these flags -- on
    // S4A this rule fired on FLCU01 and FLVN01 on an organisation, the two most ordinary
    // combinations in the product. Blank is "nothing to say", never "forbidden".
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
 * One stage, not three: the pipeline blocks on the first error a validation stage reports, and a
 * requester should see everything wrong with their roles at once rather than one per press.
 */
function createCviStages({ read = readConfiguration } = {}) {
  return {
    validations: [{
      name: 'cvi_configuration',
      async run(payload) {
        let config;
        try {
          config = await configuration(read);
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
          ...postprocessingFindings(payload, config)
        ];
      }
    }]
  };
}

module.exports = {
  createCviStages,
  invalidate,
  ROLE_CATEGORY_SEVERITY,
  _internals: { configuration, roleCategoryFindings, postprocessingFindings, liveRows, isSet }
};
