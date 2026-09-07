'use strict';

/**
 * The app's OWN post-time required fields, evaluated at CHECK time.
 *
 * Why this exists (2026-08-28). A change request passed every check and then failed at activation
 * with `CustomerTaxIndicators: enter required field(s) Customer, SalesOrganization, ...`. Those
 * rules live in `MAINTENANCE_ENTITIES.requiredCreateFields` and were only ever enforced inside
 * `postToS4` -- after an approver had spent their time, and after the root and earlier children had
 * already been written, because the post is not atomic. The pipeline validated against S/4 and
 * against the steward's rules, and never against the app's own.
 *
 * It is deliberately a mirror, not a second opinion: same config, same emptiness test, same
 * wording, so a row this passes cannot be refused by the post for a reason this could have named.
 */

const hasValue = (value) => value !== undefined && value !== null
  && (typeof value !== 'string' || value.trim() !== '');

const CREATE = 'C';

/**
 * Only rows the post will actually CREATE. `postToS4` skips `N`, deletes `D` without a create
 * check, and sends `U` as an update -- so validating those would refuse rows nothing rejects.
 */
const isCreateRow = (row) => String(row?.action || CREATE).trim().toUpperCase() === CREATE;

/**
 * Fields `postToS4` supplies itself, which are therefore legitimately absent from staging: the
 * relation number it resolves per section, `BusinessPartner` on a role node, and -- for an
 * address-owned child (Email/Phone/Fax/Website/Tax Number) -- `AddressID` AND `BusinessPartner`.
 *
 * `AddressID` is the one relation `postToS4` resolves PER ROW, from whichever staged address the
 * row belongs to, rather than once for the whole section (see ADDRESS_CHILD_NODES/
 * addressIdByStagedRow in change-request-service.js and "Address-owned children" in staging.md).
 * It cannot exist at check time by design: a brand new address has no S/4 key until its own create
 * returns one, and the child is linked to it through `__addressKey`/`address_ID` instead.
 * `BusinessPartner` is injected for the same reason one line down for a role node -- the post sets
 * it from the partner it has just created or is updating, and sanitizeEntityPayload drops it again
 * for the four children whose key does not carry it.
 *
 * Demanding either here refused every new email, phone, fax, website and address tax number on a
 * create (reported 2026-09-04) for fields the requester cannot supply and the post never reads
 * from staging.
 */
function injectedFields(section, relationFields, roleNodes, addressChildNodes) {
  const injected = new Set([relationFields[section] || 'BusinessPartner']);
  if (roleNodes.has(section)) injected.add('BusinessPartner');
  if (addressChildNodes && addressChildNodes.has(section)) {
    injected.add('AddressID');
    injected.add('BusinessPartner');
  }
  return injected;
}

function missingFor(section, row, config, relationFields, roleNodes, addressChildNodes) {
  const injected = injectedFields(section, relationFields, roleNodes, addressChildNodes);
  const missing = (config.requiredCreateFields || [])
    .filter((field) => !injected.has(field))
    .filter((field) => !hasValue(row[field]));

  const oneOf = config.oneOfCreateFields || [];
  const oneOfMissing = oneOf.length && !oneOf.some((field) => hasValue(row[field]));
  return { missing, oneOfMissing, oneOf };
}

/**
 * `entities` is MAINTENANCE_ENTITIES, `relationFields` is RELATION_FIELDS, `roleNodes` is
 * ROLE_NODES, `addressChildNodes` is ADDRESS_CHILD_NODES -- injected rather than imported so this
 * module stays free of the service graph and so a test can state the rules it is checking against.
 */
function createNodeRequiredStages({
  entities = {}, relationFields = {}, roleNodes = new Set(), addressChildNodes = new Set()
} = {}) {
  return {
    validations: [{
      /**
       * A row the post can never create, refused before an approver spends their time on it.
       *
       * `node_required_fields` below deliberately skips a section that is not `creatable` - it has
       * no create rules to check. Nothing then said the row could not be posted AT ALL, so
       * `AddressTaxNumbers` passed every check and failed at activation with S/4's own *"Operation
       * is not supported"* - after the business partner had already been created (2026-09-07).
       *
       * Same shape as the 2026-08-28 fix this module exists for: the post's own refusal, evaluated
       * at check time, in the post's own words. `notCreatableReason` is the entity's if it has one.
       */
      name: 'node_not_creatable',
      async run(payload) {
        const findings = [];

        for (const [section, rows] of Object.entries(payload?.sections || {})) {
          const config = entities[section];
          if (!config || config.creatable !== false || !Array.isArray(rows)) continue;

          rows.forEach((row, index) => {
            if (!isCreateRow(row)) return;
            findings.push({
              severity: 'error',
              target: section,
              index,
              message: config.notCreatableReason
                || `${section} cannot be created directly. Add the corresponding role first.`
            });
          });
        }

        return findings;
      }
    }, {
      name: 'node_required_fields',
      async run(payload) {
        const findings = [];

        for (const [section, rows] of Object.entries(payload?.sections || {})) {
          const config = entities[section];
          // A section nothing posts has no create rules to check.
          if (!config || !config.creatable) continue;
          if (!Array.isArray(rows)) continue;

          rows.forEach((row, index) => {
            if (!isCreateRow(row)) return;
            const { missing, oneOfMissing, oneOf } = missingFor(
              section, row, config, relationFields, roleNodes, addressChildNodes
            );

            // Same wording as validateMaintenanceCreate, so a requester who has seen the
            // activation failure recognises the message that now prevents it.
            if (missing.length) {
              findings.push({
                severity: 'error',
                target: section,
                index,
                message: `${section}: enter required field(s) ${missing.join(', ')}.`
              });
            }
            if (oneOfMissing) {
              findings.push({
                severity: 'error',
                target: section,
                index,
                message: `${section}: enter at least one of ${oneOf.join(' or ')}.`
              });
            }
          });
        }

        return findings;
      }
    }]
  };
}

module.exports = { createNodeRequiredStages, _internals: { isCreateRow, injectedFields, missingFor } };
