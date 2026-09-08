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
 * This stage only speaks about relations that are a SEPARATE record the request has to bring
 * along -- exactly the ones `RELATION_ROLE_NODE` names a section for.
 *
 * `BusinessPartnerContacts` is the counter-example that made this explicit (2026-09-04).
 * `A_BusinessPartnerContact` spells its relation `BusinessPartnerCompany`, and that IS the
 * business partner being maintained -- not a customer or vendor master hanging off it. On a create
 * there is nothing to add and nothing to check: the root of the very same request creates it. But
 * the stage treated it like any other relation and produced *"BusinessPartnerContacts needs a
 * BusinessPartnerCompany record, and a new business partner has none. Add the **undefined** section
 * to this request."* -- a blocking error naming a section that cannot exist, with a hole in the
 * sentence where `RELATION_ROLE_NODE['BusinessPartnerCompany']` should have been.
 *
 * **This is a check that does not APPLY, not one that could not run** -- the distinction the
 * standing rule turns on. `readRelationNumber` already encodes the same fact from the other end: a
 * relation field with no `RELATION_NAVIGATION` entry resolves to the business partner itself, so
 * the change path answered correctly all along and only the create path had to guess.
 */
const BROUGHT_BY_THE_PARTNER = (relationField) => !(relationField in RELATION_ROLE_NODE);

/**
 * @param resolve  async (relationField, businessPartner) -> number | null. Injected so the
 *                 stage is testable without S/4, and called at most once per relation field.
 * @param relationFields  section id -> 'Customer' | 'Supplier'.
 * @param roleNodes  the sections that ARE the record rather than hanging off it.
 * @param businessPartner  the partner being changed. A create has none, and the payload root
 *                 does not always carry it, so the caller passes what it knows.
 */
/** The rows of a section that will still exist after the request posts - `cvi-checks.js`'s own. */
const liveRows = (rows) => (Array.isArray(rows) ? rows : [])
  .filter((row) => String(row?.action || 'C').trim().toUpperCase() !== 'D');

/**
 * @param requestedRelations  async (payload) -> Set of 'Customer' | 'Supplier'. The relations the
 *                 request's OWN roles would create, per S/4's `TBD002`/`TBC002` - injected the same
 *                 way `resolve` is, and for the same reason. Omitted, the second stage is not built
 *                 at all rather than silently passing everything.
 */
function createRelationStages({
  resolve, relationFields, roleNodes, businessPartner: known, requestedRelations
}) {
  const resolved = new Map();

  const numberFor = async (relationField, businessPartner) => {
    if (!resolved.has(relationField)) {
      resolved.set(relationField, await resolve(relationField, businessPartner));
    }
    return resolved.get(relationField);
  };

  /**
   * Customer or supplier data with no role that creates the account.
   *
   * Reported live 2026-09-08: a request carrying supplier data but no supplier role was accepted,
   * routed, approved, and then failed at ACTIVATION. It is the sibling of `relation_parent_exists`
   * above and deliberately a separate stage: that one asks whether the customer/vendor RECORD is
   * there, this one whether anything in the request would bring one into being. A create satisfies
   * the first by carrying a `Suppliers` section - and then satisfies nothing at all, because it is
   * the ROLE that makes CVI create the vendor master, not the section.
   *
   * **Which role creates which account comes from S/4, never from the role name** (`TBD002`/
   * `TBC002`, via `requestedSyncTargets`) - `checks.md`'s standing rule; pattern-matching `FLVN*`
   * would be a guess.
   *
   * Blocking, unlike everything else read out of the CVI customizing: a warning here is a request
   * that cannot be activated, and the requester can act on it in one click. **A configuration that
   * could not be READ still never blocks** - it says so and steps aside, the same posture
   * `cvi_configuration` takes, because an unreachable S/4 must not stop every submit.
   */
  const roleRequestedStage = {
    name: 'relation_role_requested',
    async run(payload) {
      const sections = payload.sections || {};
      const businessPartner = known || payload.root?.BusinessPartner;

      // Every section that is customer or supplier data, the role node itself included.
      const carried = new Map();
      for (const [section, rows] of Object.entries(sections)) {
        const relationField = relationFields[section];
        if (!relationField || !(relationField in RELATION_ROLE_NODE)) continue;
        if (!liveRows(rows).length) continue;
        if (!carried.has(relationField)) carried.set(relationField, []);
        carried.get(relationField).push(section);
      }
      if (!carried.size) return [];

      // A partner that already HAS the record already has the role that made it, so there is
      // nothing for this request to ask for. Shares `numberFor` with the stage above, so a change
      // request costs no second lookup - and a create has no partner and never asks at all.
      const stillNeeded = [];
      for (const [relationField, dependents] of carried) {
        if (!businessPartner) { stillNeeded.push([relationField, dependents]); continue; }
        try {
          if (await numberFor(relationField, businessPartner)) continue;
        } catch {
          // `relation_parent_exists` already warns about this exact lookup, naming the error. A
          // second warning saying the same thing would only make the list longer.
          continue;
        }
        stillNeeded.push([relationField, dependents]);
      }
      if (!stillNeeded.length) return [];

      let requested;
      try {
        requested = await requestedRelations(payload);
      } catch (error) {
        return [{
          severity: 'warning',
          message: `The CVI configuration could not be read (${error.message}), so it is not known`
            + ' whether the roles on this request create the customer or supplier record its data'
            + ' needs.'
        }];
      }

      return stillNeeded
        .filter(([relationField]) => !requested.has(relationField))
        .map(([relationField, dependents]) => ({
          severity: 'error',
          target: dependents[0],
          message: `${dependents.join(', ')} ${dependents.length > 1 ? 'carry' : 'carries'}`
            + ` ${relationField.toLowerCase()} data, but no business partner role on this request`
            + ` creates a ${relationField.toLowerCase()} in S/4. Add a role that does to the Business`
            + ' Partner Roles section, or remove those sections.'
        }));
    }
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
          // The partner itself is the parent, so no section brings it and none is missing.
          if (BROUGHT_BY_THE_PARTNER(relationField)) continue;
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
    },
    // Appended, never prepended: several tests reach `relation_parent_exists` as `validations[0]`.
    // Built only when the caller supplied the resolver - a stage that cannot answer its question
    // must not be registered as one that did.
    ...(typeof requestedRelations === 'function' ? [roleRequestedStage] : [])]
  };
}

module.exports = { createRelationStages, RELATION_ROLE_NODE };
