'use strict';

const cds = require('@sap/cds');
const { startWorkflow } = require('./wf/processAutomation');

const STAGING = 'mdmlight.staging.';

/**
 * Maps a maintenance-screen section id onto its staging entity. The ids are the
 * same ones app/businesspartner/scripts/generate-maintenance-metadata.js emits,
 * so the UI can post its own state without translating anything.
 */
const NODES = {
  Addresses:            { entity: `${STAGING}StagedAddresses`,       many: true },
  BusinessPartnerRoles: { entity: `${STAGING}StagedRoles`,           many: true },
  TaxNumbers:           { entity: `${STAGING}StagedTaxNumbers`,      many: true },
  BankDetails:          { entity: `${STAGING}StagedBankDetails`,     many: true },
  Identifications:      { entity: `${STAGING}StagedIdentifications`, many: true },
  Industries:           { entity: `${STAGING}StagedIndustries`,      many: true },
  Customers:            { entity: `${STAGING}StagedCustomer`,        many: false },
  Suppliers:            { entity: `${STAGING}StagedSupplier`,        many: false }
};

const GENERAL = `${STAGING}StagedGeneral`;
const HEADER = `${STAGING}ChangeRequests`;

/** Never copied from a client payload into a staged row. */
const RESERVED = new Set([
  'ID', 'request', 'request_ID', 'action',
  'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'
]);

const APPROVAL_WORKFLOW_DEFINITION_ID =
  'eu10.alluvion-dev-cf.mdmlightapproval.mDM_LIGHT_APPROVAL_WF';

function parseJsonObject(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const failure = new Error(`${label} is not valid JSON.`);
    failure.statusCode = 400;
    throw failure;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const failure = new Error(`${label} must be a JSON object.`);
    failure.statusCode = 400;
    throw failure;
  }
  return value;
}

/**
 * Keeps only elements the staging entity actually has. The maintenance screen
 * carries S/4 fields we deliberately do not stage (derived names, ETag) plus
 * its own bookkeeping (__state, __keys); passing those through would fail the
 * insert on an unknown column.
 */
function stageable(entityName, source) {
  const elements = cds.model.definitions[entityName]?.elements || {};
  const row = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (RESERVED.has(name) || name.startsWith('__')) continue;
    if (!elements[name]) continue;
    if (value === undefined) continue;
    row[name] = value === '' ? null : value;
  }
  return row;
}

/**
 * 'new' -> create, 'modified' -> update, an entry in `deleted` -> delete.
 * Untouched rows get no action: a change request stages the whole partner so
 * the approver sees it in full, but only touched rows may be replayed to S/4.
 */
function rowAction(record) {
  if (record?.__state === 'new') return 'C';
  if (record?.__state) return 'U';
  return null;
}

function requestingUserEmail(req) {
  return req.user?.attr?.email || req.user?.id || 'unknown';
}

class ChangeRequestService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');

    /**
     * Replaces the staged nodes of a request wholesale. A save always carries
     * the complete screen state, so rewriting is both simpler and safer than
     * diffing - there is no way for a stale row to survive.
     */
    const writeStagedNodes = async (changeRequest, payload) => {
      const sections = payload.sections || {};
      const deleted = payload.deleted || {};

      await db.run(cds.ql.DELETE.from(GENERAL).where({ request_ID: changeRequest }));
      await db.run(cds.ql.INSERT.into(GENERAL).entries({
        request_ID: changeRequest,
        ...stageable(GENERAL, payload.root)
      }));

      for (const [section, config] of Object.entries(NODES)) {
        await db.run(cds.ql.DELETE.from(config.entity).where({ request_ID: changeRequest }));

        if (!config.many) {
          const single = sections[section];
          const source = Array.isArray(single) ? single[0] : single;
          if (source && Object.keys(stageable(config.entity, source)).length) {
            await db.run(cds.ql.INSERT.into(config.entity).entries({
              request_ID: changeRequest,
              ...stageable(config.entity, source)
            }));
          }
          continue;
        }

        const rows = [
          ...(Array.isArray(sections[section]) ? sections[section] : []).map((record) => ({
            request_ID: changeRequest,
            action: rowAction(record),
            ...stageable(config.entity, record)
          })),
          ...(Array.isArray(deleted[section]) ? deleted[section] : []).map((record) => ({
            request_ID: changeRequest,
            action: 'D',
            ...stageable(config.entity, record)
          }))
        ];
        if (rows.length) await db.run(cds.ql.INSERT.into(config.entity).entries(rows));
      }
    };

    /** Upserts the header and rewrites the nodes. Status is left untouched. */
    const persist = async (req) => {
      const payload = parseJsonObject(req.data.DataJson, 'DataJson');
      let changeRequest = req.data.ChangeRequest;

      if (changeRequest) {
        const existing = await db.run(
          cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest })
        );
        if (!existing) return req.reject(404, `Change request ${changeRequest} was not found.`);
        if (existing.status !== 'draft') {
          return req.reject(409, `Change request ${changeRequest} is ${existing.status} and can no longer be changed.`);
        }
        await db.run(cds.ql.UPDATE(HEADER).set({
          requestType: req.data.RequestType,
          businessPartner: req.data.BusinessPartner || null,
          reason: req.data.Reason || null
        }).where({ ID: changeRequest }));
      } else {
        changeRequest = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(HEADER).entries({
          ID: changeRequest,
          requestType: req.data.RequestType,
          status: 'draft',
          businessPartner: req.data.BusinessPartner || null,
          reason: req.data.Reason || null
        }));
      }

      await writeStagedNodes(changeRequest, payload);
      return changeRequest;
    };

    this.on('saveRequest', async (req) => {
      const changeRequest = await persist(req);
      if (!changeRequest) return;
      return { ChangeRequest: changeRequest, Status: 'draft' };
    });

    this.on('submitRequest', async (req) => {
      const changeRequest = await persist(req);
      if (!changeRequest) return;

      let processInstanceId = null;
      try {
        const result = await startWorkflow(APPROVAL_WORKFLOW_DEFINITION_ID, {
          changerequestid: changeRequest,
          requesttype: req.data.RequestType,
          businesspartner: req.data.BusinessPartner || '',
          emailadressinitiator: requestingUserEmail(req)
        });
        processInstanceId = result?.id || result?.data?.id || null;
      } catch (error) {
        // Left in draft on purpose: a request in `inApproval` with no process
        // behind it would sit in nobody's inbox and could not be resubmitted.
        return req.reject(
          502,
          `The request was saved as a draft but the approval workflow could not be started: ${error.message}`
        );
      }

      await db.run(cds.ql.UPDATE(HEADER).set({
        status: 'inApproval',
        processInstanceId,
        submittedAt: new Date().toISOString(),
        submittedBy: requestingUserEmail(req)
      }).where({ ID: changeRequest }));

      return { ChangeRequest: changeRequest, Status: 'inApproval', ProcessInstanceId: processInstanceId };
    });

    /**
     * Rebuilds the maintenance screen's own payload shape from the staged rows,
     * so the approve view renders through the existing code path rather than a
     * second, parallel one.
     */
    this.on('getRequestPayload', async (req) => {
      const changeRequest = req.data.ChangeRequest;
      const header = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest }));
      if (!header) return req.reject(404, `Change request ${changeRequest} was not found.`);

      const general = await db.run(
        cds.ql.SELECT.one.from(GENERAL).where({ request_ID: changeRequest })
      );

      const sections = {};
      const deleted = {};
      for (const [section, config] of Object.entries(NODES)) {
        const rows = await db.run(
          cds.ql.SELECT.from(config.entity).where({ request_ID: changeRequest })
        );
        const clean = rows.map((row) => {
          const { ID, request_ID, action, ...rest } = row;
          return rest;
        });
        if (config.many) {
          sections[section] = clean.filter((_, index) => rows[index].action !== 'D');
          deleted[section] = clean.filter((_, index) => rows[index].action === 'D');
        } else {
          sections[section] = clean[0] || null;
        }
      }

      const { ID, request_ID, ...root } = general || {};

      return {
        ChangeRequest: header.ID,
        RequestType: header.requestType,
        Status: header.status,
        BusinessPartner: header.businessPartner,
        Reason: header.reason,
        SubmittedBy: header.submittedBy,
        SubmittedAt: header.submittedAt,
        DataJson: JSON.stringify({ root, sections, deleted })
      };
    });

    /**
     * Posts a staged request to S/4 by replaying it through
     * BusinessPartnerService, which owns the API_BUSINESS_PARTNER connection
     * and all the payload sanitizing. Nothing here talks to S/4 directly.
     */
    const postToS4 = async (req, header) => {
      const bp = await cds.connect.to('BusinessPartnerService');
      const isCreate = header.requestType === 'create';

      const general = await db.run(
        cds.ql.SELECT.one.from(GENERAL).where({ request_ID: header.ID })
      ) || {};
      const { ID: generalId, request_ID, ...root } = general;

      const saved = await bp.send('saveBusinessPartner', {
        BusinessPartner: header.businessPartner || root.BusinessPartner || null,
        IsCreate: isCreate,
        DataJson: JSON.stringify(root)
      });

      const businessPartner = saved?.BusinessPartner
        || header.businessPartner
        || root.BusinessPartner;
      if (!businessPartner) {
        throw new Error('S/4HANA did not return a Business Partner number.');
      }

      for (const [section, config] of Object.entries(NODES)) {
        const rows = await db.run(
          cds.ql.SELECT.from(config.entity).where({ request_ID: header.ID })
        );
        for (const row of rows) {
          const { ID, request_ID: parent, action, ...data } = row;
          // Staged for context only - the user never touched it.
          if (!action) continue;
          const relationField = section === 'Customers'
            ? 'Customer'
            : section === 'Suppliers' ? 'Supplier' : 'BusinessPartner';
          if (relationField === 'BusinessPartner') data.BusinessPartner = businessPartner;

          if (action === 'D') {
            await bp.send('deleteBusinessPartnerEntity', {
              Entity: section,
              KeyJson: JSON.stringify(data)
            });
            continue;
          }

          await bp.send('saveBusinessPartnerEntity', {
            Entity: section,
            IsCreate: action !== 'U',
            KeyJson: JSON.stringify({}),
            DataJson: JSON.stringify(data)
          });
        }
      }

      return businessPartner;
    };

    this.on('decideRequest', async (req) => {
      const changeRequest = req.data.ChangeRequest;
      const decision = String(req.data.Decision || '').toLowerCase();
      if (!['approve', 'reject'].includes(decision)) {
        return req.reject(400, "Decision must be 'approve' or 'reject'.", 'Decision');
      }

      const header = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest }));
      if (!header) return req.reject(404, `Change request ${changeRequest} was not found.`);

      // Idempotency guard. SPA retries - a timed-out callback must not create a
      // second business partner.
      if (header.postedBP) {
        return { ChangeRequest: changeRequest, Status: header.status, BusinessPartner: header.postedBP };
      }
      if (header.status !== 'inApproval') {
        return req.reject(409, `Change request ${changeRequest} is ${header.status}, not awaiting approval.`);
      }

      if (decision === 'reject') {
        await db.run(cds.ql.UPDATE(HEADER).set({
          status: 'rejected',
          reason: req.data.Comment || header.reason
        }).where({ ID: changeRequest }));
        return { ChangeRequest: changeRequest, Status: 'rejected', BusinessPartner: null };
      }

      // Approved, not posted. SPA decides when its chain is finished and calls
      // completeRequest; this handler must never write to S/4.
      await db.run(cds.ql.UPDATE(HEADER).set({
        status: 'approved',
        reason: req.data.Comment || header.reason
      }).where({ ID: changeRequest }));
      return { ChangeRequest: changeRequest, Status: 'approved', BusinessPartner: header.businessPartner };
    });

    this.on('completeRequest', async (req) => {
      const changeRequest = req.data.ChangeRequest;
      const header = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest }));
      if (!header) return req.reject(404, `Change request ${changeRequest} was not found.`);

      // Idempotency guard. SPA retries - a timed-out callback must not create a
      // second business partner.
      if (header.postedBP) {
        return { ChangeRequest: changeRequest, Status: header.status, BusinessPartner: header.postedBP };
      }
      if (header.status !== 'approved') {
        return req.reject(409, `Change request ${changeRequest} is ${header.status}, not approved.`);
      }

      try {
        const businessPartner = await postToS4(req, header);
        await db.run(cds.ql.UPDATE(HEADER).set({
          status: 'posted',
          postedBP: businessPartner,
          postedAt: new Date().toISOString(),
          postError: null
        }).where({ ID: changeRequest }));
        return { ChangeRequest: changeRequest, Status: 'posted', BusinessPartner: businessPartner };
      } catch (error) {
        // Kept in `failed` rather than rolled back to `approved`: the post is
        // not atomic, so a partial write may exist in S/4 and needs a human.
        await db.run(cds.ql.UPDATE(HEADER).set({
          status: 'failed',
          postError: String(error.message || error).slice(0, 1000)
        }).where({ ID: changeRequest }));
        return req.reject(502, `The Business Partner could not be written to S/4HANA: ${error.message}`);
      }
    });

    await super.init();
  }
}

module.exports = ChangeRequestService;
