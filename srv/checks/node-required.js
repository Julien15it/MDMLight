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
 * Fields `postToS4` supplies itself, which are therefore legitimately absent from staging:
 * the relation number it resolves per section, and `BusinessPartner` on a role node.
 */
function injectedFields(section, relationFields, roleNodes) {
  const injected = new Set([relationFields[section] || 'BusinessPartner']);
  if (roleNodes.has(section)) injected.add('BusinessPartner');
  return injected;
}

function missingFor(section, row, config, relationFields, roleNodes) {
  const injected = injectedFields(section, relationFields, roleNodes);
  const missing = (config.requiredCreateFields || [])
    .filter((field) => !injected.has(field))
    .filter((field) => !hasValue(row[field]));

  const oneOf = config.oneOfCreateFields || [];
  const oneOfMissing = oneOf.length && !oneOf.some((field) => hasValue(row[field]));
  return { missing, oneOfMissing, oneOf };
}

/**
 * `entities` is MAINTENANCE_ENTITIES, `relationFields` is RELATION_FIELDS, `roleNodes` is
 * ROLE_NODES -- injected rather than imported so this module stays free of the service graph and
 * so a test can state the rules it is checking against.
 */
function createNodeRequiredStages({ entities = {}, relationFields = {}, roleNodes = new Set() } = {}) {
  return {
    validations: [{
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
              section, row, config, relationFields, roleNodes
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
