'use strict';

/**
 * The name a business partner should be shown under, composed from its name components.
 *
 * S/4 derives `BusinessPartnerFullName` itself and refuses to be told it -
 * `sap:creatable="false" sap:updatable="false"` in API_BUSINESS_PARTNER - so for a partner that
 * already exists it is read from S/4 and nothing here is needed. This exists for the one that does
 * NOT exist yet: a pending create is staged in CAP, S/4 has never seen it, and `db/staging.cds`
 * holds no such column, so anything that wants to show a requested partner by name has to compose it.
 *
 * **Never write the result into a request payload.** `sanitizeEntityPayload` excludes the field on
 * update but not on create, so a value sitting on the staged root would be forwarded to S/4 on the
 * post and rejected. It is a value to display and to send to the workflow, not one to store.
 */

/** S/4's category codes: 1 person, 2 organisation, 3 group. */
const CATEGORY_FIELDS = Object.freeze({
  1: ['FirstName', 'MiddleName', 'LastName'],
  2: ['OrganizationBPName1', 'OrganizationBPName2'],
  3: ['GroupBusinessPartnerName1', 'GroupBusinessPartnerName2']
});

/** Tried in turn when the category is absent or its own fields are empty. */
const FALLBACK_GROUPS = Object.freeze([
  ['OrganizationBPName1', 'OrganizationBPName2'],
  ['FirstName', 'MiddleName', 'LastName'],
  ['GroupBusinessPartnerName1', 'GroupBusinessPartnerName2'],
  ['SearchTerm1']
]);

const join = (root, fields) => fields
  .map((field) => root[field])
  .filter(Boolean)
  .join(' ')
  .trim();

/**
 * The composed name, or `''` when there is nothing to compose from.
 *
 * The category decides which fields to read, because S/4 discards name fields that do not match it.
 * An empty answer still falls back through the other groups: a row whose category disagrees with the
 * fields somebody filled in is better named than left blank, and this is used to label a request a
 * human is about to read.
 */
function fullNameOf(root = {}) {
  const own = CATEGORY_FIELDS[root.BusinessPartnerCategory];
  const fromCategory = own ? join(root, own) : '';
  if (fromCategory) return fromCategory;

  for (const group of FALLBACK_GROUPS) {
    const name = join(root, group);
    if (name) return name;
  }
  return '';
}

/**
 * The full name S/4 would have derived, for a row on its way to the workflow. Returns the row
 * unchanged when it already carries one - a change request over an existing partner has the real
 * value from S/4, and composing over it would replace what S/4 says with a guess.
 */
function withFullName(root) {
  if (!root) return root;
  if (String(root.BusinessPartnerFullName || '').trim()) return root;
  const fullName = fullNameOf(root);
  return fullName ? { ...root, BusinessPartnerFullName: fullName } : root;
}

module.exports = {
  CATEGORY_FIELDS,
  fullNameOf,
  withFullName
};
