'use strict';

/**
 * CVI's answer, read at submit instead of after approval.
 *
 * A node like CustomerCompany hangs off the customer record, not off the business partner, so
 * posting it needs the customer number. That number is CVI's: `CVI_CUST_LINK` and
 * `CVI_VEND_LINK` hold the business partner to customer/vendor assignment, and
 * `API_BUSINESS_PARTNER` exposes it as `to_Customer` / `to_Supplier`.
 *
 * `postToS4` already resolves it - but only while posting, which is after the approval. A
 * request whose parent never existed is therefore accepted, routed, approved, and only then
 * fails with "Business Partner X has no Customer record yet". By then the requester has moved
 * on and the approver has signed something that cannot be carried out.
 *
 * This stage asks the same question at submit. The parent counts as available when the request
 * creates it in the same run (a Customers or Suppliers row) or when the business partner
 * already carries it.
 */

const RELATION_ROLE_NODE = Object.freeze({
  Customer: 'Customers',
  Supplier: 'Suppliers'
});

/**
 * @param resolve  async (relationField, businessPartner) -> number | null. Injected so the
 *                 stage is testable without S/4, and called at most once per relation field.
 * @param relationFields  section id -> 'Customer' | 'Supplier'.
 * @param roleNodes  the sections that ARE the record rather than hanging off it.
 * @param businessPartner  the partner being changed. A create has none, and the payload root
 *                 does not always carry it, so the caller passes what it knows.
 */
function createRelationStages({ resolve, relationFields, roleNodes, businessPartner: known }) {
  const resolved = new Map();

  const numberFor = async (relationField, businessPartner) => {
    if (!resolved.has(relationField)) {
      resolved.set(relationField, await resolve(relationField, businessPartner));
    }
    return resolved.get(relationField);
  };

  return {
    validations: [{
      name: 'relation_parent_exists',
      async run(payload) {
        const sections = payload.sections || {};
        const businessPartner = known || payload.root?.BusinessPartner;

        // Which relations this request actually needs a parent for, and which it brings itself.
        const needed = new Set();
        const broughtAlong = new Set();
        for (const [section, rows] of Object.entries(sections)) {
          const relationField = relationFields[section];
          if (!relationField || !Array.isArray(rows) || rows.length === 0) continue;
          if (roleNodes.has(section)) broughtAlong.add(relationField);
          else needed.add(relationField);
        }

        const messages = [];
        for (const relationField of needed) {
          if (broughtAlong.has(relationField)) continue;

          const dependents = Object.keys(sections).filter((section) =>
            relationFields[section] === relationField
            && !roleNodes.has(section)
            && Array.isArray(sections[section])
            && sections[section].length > 0);

          // Nothing to look up against: a create has no business partner yet, so the only way
          // the parent can exist is for the request to carry it.
          if (!businessPartner) {
            messages.push({
              severity: 'error',
              target: dependents[0],
              message: `${dependents.join(', ')} needs a ${relationField} record, and a new business`
                + ` partner has none. Add the ${RELATION_ROLE_NODE[relationField]} section to this`
                + ' request.'
            });
            continue;
          }

          let number;
          try {
            number = await numberFor(relationField, businessPartner);
          } catch (error) {
            // Cannot tell. Blocking on an unreachable system would strand the request, and
            // passing silently is the failure this stage exists to prevent - so it says so.
            messages.push({
              severity: 'warning',
              target: dependents[0],
              message: `Could not check whether business partner ${businessPartner} has a`
                + ` ${relationField} record (${error.message}). If it has none,`
                + ` ${dependents.join(', ')} will fail when the approved request is posted.`
            });
            continue;
          }

          if (number) continue;

          messages.push({
            severity: 'error',
            target: dependents[0],
            message: `${dependents.join(', ')} needs a ${relationField} record, and business`
              + ` partner ${businessPartner} has none. Add the`
              + ` ${RELATION_ROLE_NODE[relationField]} section to this request, or remove those`
              + ' sections.'
          });
        }
        return messages;
      }
    }]
  };
}

module.exports = { createRelationStages, RELATION_ROLE_NODE };
