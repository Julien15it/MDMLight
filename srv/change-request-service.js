'use strict';

const cds = require('@sap/cds');
const { startWorkflow, triggerApprovalDecision } = require('./wf/processAutomation');
const { buildWorkflowInputFromRows } = require('./business-partner-service')._internals;
const { candidateFromStagedRequest, duplicateSummary } = require('./ai/duplicate-check');
const { runChecks, runValidations, BLOCKING } = require('./checks/pipeline');
const { createRegistryStages } = require('./checks/registry-checks');
const { proposeNormalisations, mergeProposals } = require('./checks/normalise');

const STAGING = 'mdmlight.staging.';
const FINDINGS = `${STAGING}CheckFindings`;

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

// staging.cds also declares block and delete: both reserved, and meaningless to postToS4. Checked
// here because RequestType is a String(10), so a bad value otherwise fails at the database instead.
const SUPPORTED_REQUEST_TYPES = Object.freeze(['create', 'change']);

// A finding also carries candidateName and reasons for the SPA payload; neither is a column, and
// spreading them into the insert would fail. Whitelisted, so a new field cannot break a submit.
const FINDING_COLUMNS = Object.freeze([
  'checkName', 'severity', 'message', 'nodeName', 'fieldName',
  'candidateBP', 'candidateRequest', 'verdict', 'score'
]);

const stagedFinding = (finding) => Object.fromEntries(
  FINDING_COLUMNS.filter((column) => finding[column] !== undefined)
    .map((column) => [column, finding[column]])
);

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

/**
 * Deep link to this request's approve view. Sent to BPA as `bpurl` so the
 * workflow can route the approver to it. APPROUTER_URL is provided by
 * mta.yaml (the approuter module's own route, via MTA's provides/requires) -
 * unset in local/hybrid dev, where there is no approuter, so this degrades to
 * an empty string rather than a broken link.
 */
function approveUrl(changeRequest) {
  const approuterUrl = process.env.APPROUTER_URL;
  if (!approuterUrl) return '';
  return `${approuterUrl.replace(/\/$/, '')}/mdmmdbusinesspartnermanage/index.html#ChangeRequests/${changeRequest}/approve`;
}

/** Staged rows for a many-cardinality node, deletions excluded - a request in
 * review is judged on the state it is proposing, not on what it is removing. */
async function activeStagedRows(db, entity, changeRequest) {
  const rows = await db.run(cds.ql.SELECT.from(entity).where({ request_ID: changeRequest }));
  return rows.filter((row) => row.action !== 'D');
}

/**
 * Builds the same businesspartnerinput the approval workflow expects for a
 * direct create/edit (see business-partner-service.js), but sourced from
 * this request's staged rows instead of a live S/4 read - at submitRequest
 * time a `create` request has no S/4 record yet to read from. `businessPartner`
 * (known up front for change/block/delete, null for create) is backfilled
 * onto staged child rows that do not carry their own key so the approver's
 * preview still shows which BP each row belongs to.
 */
async function buildBusinessPartnerInput(db, s4, header) {
  const changeRequest = header.ID;
  const businessPartner = header.businessPartner || null;
  const withBusinessPartner = (row) => (row && businessPartner ? { BusinessPartner: businessPartner, ...row } : row);

  const general = await db.run(cds.ql.SELECT.one.from(GENERAL).where({ request_ID: changeRequest }));
  const customer = await db.run(cds.ql.SELECT.one.from(NODES.Customers.entity).where({ request_ID: changeRequest }));
  const supplier = await db.run(cds.ql.SELECT.one.from(NODES.Suppliers.entity).where({ request_ID: changeRequest }));
  const industries = await activeStagedRows(db, NODES.Industries.entity, changeRequest);

  const rowsByEntity = {
    A_BusinessPartner: withBusinessPartner(general),
    A_BusinessPartnerAddress: (await activeStagedRows(db, NODES.Addresses.entity, changeRequest)).map(withBusinessPartner),
    A_BusinessPartnerRole: (await activeStagedRows(db, NODES.BusinessPartnerRoles.entity, changeRequest)).map(withBusinessPartner),
    A_BusinessPartnerBank: (await activeStagedRows(db, NODES.BankDetails.entity, changeRequest)).map(withBusinessPartner),
    A_BusinessPartnerTaxNumber: (await activeStagedRows(db, NODES.TaxNumbers.entity, changeRequest)).map(withBusinessPartner),
    A_BuPaIdentification: (await activeStagedRows(db, NODES.Identifications.entity, changeRequest)).map(withBusinessPartner),
    // The workflow schema models A_BuPaIndustry as a single object even
    // though S/4 (and this app's own staging) allow several - take the first.
    A_BuPaIndustry: withBusinessPartner(industries[0] || null),
    A_Customer: customer,
    A_Supplier: supplier
  };

  return buildWorkflowInputFromRows(s4, rowsByEntity);
}

class ChangeRequestService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const s4 = await cds.connect.to('API_BUSINESS_PARTNER');

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
      const requestType = req.data.RequestType;
      if (!SUPPORTED_REQUEST_TYPES.includes(requestType)) {
        return req.reject(400, `Request type “${requestType}” is not supported.`);
      }
      // Otherwise postToS4 only discovers it after approval - the worst moment to find out.
      if (requestType === 'change' && !req.data.BusinessPartner) {
        return req.reject(400, 'A change request needs the Business Partner it changes.');
      }
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
          requestType,
          businessPartner: req.data.BusinessPartner || null,
          reason: req.data.Reason || null
        }).where({ ID: changeRequest }));
      } else {
        changeRequest = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(HEADER).entries({
          ID: changeRequest,
          requestType,
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

    /**
     * Runs the one duplicate check over the staged record and records what it found. A `Duplicate`
     * verdict raises an `error` finding for the approver to clear; it deliberately does not block
     * the submit, because the approver is the override and there is no other way past it.
     *
     * Best-effort on purpose: a duplicate check that cannot run must not strand a request in
     * `draft` with an approval workflow already waiting for it.
     */
    const recordDuplicateFindings = async (changeRequest, businessPartner) => {
      let findings = [];
      try {
        const general = await db.run(
          cds.ql.SELECT.one.from(GENERAL).where({ request_ID: changeRequest })
        );
        if (!general) return findings;
        const nodes = {};
        for (const [section, config] of Object.entries(NODES)) {
          if (!config.many) continue;
          nodes[section] = await db.run(
            cds.ql.SELECT.from(config.entity).where({ request_ID: changeRequest })
          );
        }
        const bp = await cds.connect.to('BusinessPartnerService');
        const answer = await bp.send('checkBusinessPartnerDuplicates', {
          CandidateJson: JSON.stringify(candidateFromStagedRequest(general, nodes)),
          // A change request must never report the partner it is changing as its own duplicate,
          // nor itself: it is already staged and in an active status by the time this runs.
          ExcludeBP: businessPartner || general.BusinessPartner || null,
          ExcludeRequest: changeRequest
        });
        findings = JSON.parse(answer || '{}').findings || [];
        // Supersede rather than delete, so an earlier verdict stays auditable after a resubmit.
        await db.run(cds.ql.UPDATE(FINDINGS)
          .set({ isStale: true })
          .where({ request_ID: changeRequest, checkName: 'duplicate_check' }));
        if (!findings.length) return findings;
        await db.run(cds.ql.INSERT.into(FINDINGS).entries(findings.map((finding) => ({
          ID: cds.utils.uuid(),
          request_ID: changeRequest,
          ...stagedFinding(finding)
        }))));
      } catch (error) {
        // A check that could not run must not silently read as "no duplicates": the caller is
        // told, and the submit goes through rather than stranding the request.
        console.warn('[changerequest] Duplicate check did not run:', error.message);
        return [{
          checkName: 'duplicate_check',
          severity: 'info',
          message: `The duplicate check could not run (${error.message}). Submitted without it.`
        }];
      }
      return findings;
    };

    /**
     * The Check button. Same pipeline the submit will grow into, but over the payload on screen:
     * it stages nothing, starts nothing and can be pressed as often as anyone likes.
     */
    this.on('checkRequest', async (req) => {
      const data = parseJsonObject(req.data.DataJson, 'DataJson');
      // Created per request: the pair shares one VIES/GLEIF lookup between the validation and the
      // derivation, and must not carry it over to the next press of the button.
      const registry = createRegistryStages();
      const result = await runChecks(
        { root: data.root || {}, sections: data.sections || {} },
        {
          validations: registry.validations,
          derivations: registry.derivations,
          // Check is where a human is looking, which is the only place a proposal to rewrite
          // what someone typed makes sense. The register goes first and wins the field: it knows
          // what the value should be, the model only knows how it should look.
          propose: async (derived) => mergeProposals(
            await registry.propose(derived),
            await proposeNormalisations({ payload: derived })
          ),
          checkDuplicates: async (payload) => {
            const bp = await cds.connect.to('BusinessPartnerService');
            const answer = await bp.send('checkBusinessPartnerDuplicates', {
              // The derived payload, not the typed one: a country filled in from VIES is exactly
              // the field a conditioned duplicate rule needs.
              CandidateJson: JSON.stringify(
                candidateFromStagedRequest(payload.root || {}, payload.sections || {})
              ),
              // Same exclusions as the submit: a change request is not its own duplicate, and
              // neither is the partner it is changing.
              ExcludeBP: req.data.BusinessPartner || data.root?.BusinessPartner || null,
              ExcludeRequest: req.data.ChangeRequest || null
            });
            return JSON.parse(answer || '{}').findings || [];
          }
        }
      );

      return {
        Valid: result.valid,
        RanDuplicateCheck: result.ranDuplicateCheck,
        ValidationsJson: JSON.stringify(result.validations),
        DerivationsJson: JSON.stringify(result.derivations),
        NormalisationsJson: JSON.stringify(result.normalisations),
        DuplicatesJson: JSON.stringify(result.duplicates)
      };
    });

    this.on('submitRequest', async (req) => {
      const changeRequest = await persist(req);
      if (!changeRequest) return;

      // The same validations the Check button runs, over the payload being submitted.
      // Derivations are deliberately NOT run here: a derivation changes the data, and the
      // requester has to have seen what they are asking for. Check is the derivation
      // trigger; when there are more triggers they get decided on their own merits.
      const data = parseJsonObject(req.data.DataJson, 'DataJson');
      const registry = createRegistryStages();
      const validations = await runValidations(
        { root: data.root || {}, sections: data.sections || {} },
        registry.validations
      );
      if (validations.some((message) => message.severity === BLOCKING)) {
        return {
          ChangeRequest: changeRequest,
          Status: 'draft',
          NeedsConfirmation: false,
          Valid: false,
          ValidationsJson: JSON.stringify(validations),
          MessagesJson: JSON.stringify([])
        };
      }

      const findings = await recordDuplicateFindings(changeRequest, req.data.BusinessPartner);
      // Only a verdict-bearing finding asks for a second press. A check that could not run reports
      // itself but must not hold the request hostage to an outage.
      const duplicates = findings.filter((finding) => finding.verdict);
      if (duplicates.length && !req.data.Confirm) {
        return {
          ChangeRequest: changeRequest,
          Status: 'draft',
          NeedsConfirmation: true,
          Valid: true,
          ValidationsJson: JSON.stringify(validations),
          MessagesJson: JSON.stringify(findings)
        };
      }

      const header = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest }));

      // Best-effort, like every other piece of the workflow payload: a
      // problem shaping the preview data must not block submission, it
      // should just leave the approver with a thinner (but still working)
      // businesspartnerinput. Built after the duplicate gate, so an
      // unconfirmed submit never pays for a payload it will not send.
      let businessPartnerInput = {};
      try {
        businessPartnerInput = await buildBusinessPartnerInput(db, s4, header);
      } catch (error) {
        console.error(`Could not build businesspartnerinput for change request ${changeRequest}:`, error);
      }

      let processInstanceId = null;
      try {
        const result = await startWorkflow(APPROVAL_WORKFLOW_DEFINITION_ID, {
          changerequestid: changeRequest,
          requesttype: req.data.RequestType,
          businesspartner: req.data.BusinessPartner || '',
          emailadressinitiator: requestingUserEmail(req),
          bpurl: approveUrl(changeRequest),
          businesspartnerinput: businessPartnerInput,
          // One entry per matched partner, so the approver sees what was flagged and why. Empty
          // when nothing matched, never absent - SPA can then bind it without a null check.
          bpduplicates: duplicateSummary(findings)
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

      return {
        ChangeRequest: changeRequest,
        Status: 'inApproval',
        ProcessInstanceId: processInstanceId,
        NeedsConfirmation: false,
        Valid: true,
        ValidationsJson: JSON.stringify(validations),
        MessagesJson: JSON.stringify(findings)
      };
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

      // Resumes the paused BPA workflow with the human's decision. Best-effort
      // and fired regardless of what happens to the S/4 post afterwards - the
      // workflow is waiting on the approve/reject decision itself, not on
      // whether posting later succeeds. A signalling failure must not stop us
      // from recording the decision locally (same reasoning as every other
      // workflow side effect in this app).
      const notifyWorkflow = async (workflowResult) => {
        // The task form completes the task in My Inbox, which resumes the workflow on its
        // own; signalling from here too would deliver the decision twice.
        if (req.data.SignalWorkflow === false) return;
        if (!header.processInstanceId) return;
        try {
          await triggerApprovalDecision(header.processInstanceId, workflowResult);
        } catch (error) {
          console.error('Could not signal the approval workflow with the decision:', error);
        }
      };

      if (decision === 'reject') {
        await db.run(cds.ql.UPDATE(HEADER).set({
          status: 'rejected',
          reason: req.data.Comment || header.reason
        }).where({ ID: changeRequest }));
        await notifyWorkflow('rejected');
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
        await notifyWorkflow('approved');
        return { ChangeRequest: changeRequest, Status: 'posted', BusinessPartner: businessPartner };
      } catch (error) {
        // Kept in `failed` rather than rolled back to `approved`: the post is
        // not atomic, so a partial write may exist in S/4 and needs a human.
        await db.run(cds.ql.UPDATE(HEADER).set({
          status: 'failed',
          postError: String(error.message || error).slice(0, 1000)
        }).where({ ID: changeRequest }));
        // The human still approved - S/4 rejected the post, which is a
        // separate failure the workflow itself did not cause and cannot fix.
        await notifyWorkflow('approved');
        return req.reject(502, `The Business Partner could not be created in S/4HANA: ${error.message}`);
      }
    });

    await super.init();
  }
}

ChangeRequestService._internals = {
  approveUrl,
  buildBusinessPartnerInput,
  activeStagedRows,
  SUPPORTED_REQUEST_TYPES,
  FINDING_COLUMNS,
  stagedFinding
};

module.exports = ChangeRequestService;
