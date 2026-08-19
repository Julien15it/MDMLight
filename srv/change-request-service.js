'use strict';

const cds = require('@sap/cds');
const { startWorkflow, triggerApprovalDecision } = require('./wf/processAutomation');
const {
  buildWorkflowInputFromRows, businessPartnerNavigationPath, normalizeRemoteResult
} = require('./business-partner-service')._internals;
const { candidateFromStagedRequest, duplicateSummary } = require('./ai/duplicate-check');
const { runChecks, runValidations, BLOCKING } = require('./checks/pipeline');
const { createRegistryStages } = require('./checks/registry-checks');
const { configuredStages } = require('./checks/rule-store');
const { proposeNormalisations } = require('./checks/normalise');
const { PAYLOAD_NODES, ROOT_SECTION } = require('./checks/payload-fields');

const STAGING = 'mdmlight.staging.';
const FINDINGS = `${STAGING}CheckFindings`;

/**
 * Maps a maintenance-screen section id onto its staging entity. The ids are the
 * same ones app/businesspartner/scripts/generate-maintenance-metadata.js emits,
 * so the UI can post its own state without translating anything.
 */
// Derived from PAYLOAD_NODES rather than listed again: the validation and derivation tables address
// fields by section id, so a section that exists here and not there (or vice versa) would be a rule
// pointing at a node nothing stages. `General` is the payload root, not a node, so it drops out.
const NODES = Object.fromEntries(
  Object.entries(PAYLOAD_NODES)
    .filter(([section]) => section !== ROOT_SECTION)
    .map(([section, node]) => [section, { entity: node.entity, many: node.many }])
);

/** Business-partner-relation field per node, for postToS4. Anything not listed
 *  here relates via the plain BusinessPartner number. */
const RELATION_FIELDS = Object.freeze({
  Customers: 'Customer',
  Suppliers: 'Supplier',
  CustomerCompany: 'Customer',
  SupplierCompany: 'Supplier',
  CustomerSalesArea: 'Customer',
  CustomerTaxGrouping: 'Customer',
  SupplierPurchasingOrg: 'Supplier',
  CustomerText:                      'Customer',
  CustomerAddressExtIdentifier:      'Customer',
  CustomerAddressInfo:               'Customer',
  CustomerCompanyText:               'Customer',
  CustomerDunning:                   'Customer',
  CustomerWithholdingTax:            'Customer',
  CustomerSalesAreaText:             'Customer',
  CustomerTaxIndicators:             'Customer',
  CustomerSalesPartnerFunctions:     'Customer',
  CustomerSalesAreaAddressInfo:      'Customer',
  CustomerUnloadingPoint:            'Customer',
  CustomerUnloadingPointAddressInfo: 'Customer',
  SupplierText:                      'Supplier',
  SupplierCompanyText:               'Supplier',
  SupplierDunning:                   'Supplier',
  SupplierWithholdingTax:            'Supplier',
  SupplierPurchasingOrgText:         'Supplier',
  SupplierPartnerFunctions:          'Supplier'
});

/** Navigation off A_BusinessPartner used to resolve each relation field's real
 *  number - see resolveRelationNumber. */
const RELATION_NAVIGATION = Object.freeze({
  Customer: { navigation: 'to_Customer', keyField: 'Customer' },
  Supplier: { navigation: 'to_Supplier', keyField: 'Supplier' }
});

/**
 * Customer and Supplier are their own master records with their own number
 * range - Customer-Vendor Integration does not guarantee Customer/Supplier ==
 * BusinessPartner, and on systems where it does not, staging a row under the
 * BusinessPartner number would silently post it against a Customer/Supplier
 * that does not exist. A_BusinessPartner itself carries the resolved number
 * as a plain field, tried first; the to_Customer/to_Supplier navigation is
 * the fallback for a system that leaves that field blank. Returns null when
 * neither resolves anything, e.g. the role was never assigned (or, for a
 * create request, not posted yet in this same run).
 */
async function resolveRelationNumber(s4, businessPartner, relationField) {
  const relation = RELATION_NAVIGATION[relationField];
  if (!relation) return businessPartner;
  try {
    const root = await s4.run(
      cds.ql.SELECT.one.from('API_BUSINESS_PARTNER.A_BusinessPartner')
        .columns(relation.keyField)
        .where({ BusinessPartner: businessPartner })
    );
    if (root?.[relation.keyField]) return root[relation.keyField];
  } catch {
    // Falls through to the navigation-based lookup below.
  }
  try {
    const path = businessPartnerNavigationPath(
      { navigation: relation.navigation },
      { BusinessPartner: businessPartner }
    );
    const result = normalizeRemoteResult(await s4.send({ method: 'GET', path }));
    return result?.[relation.keyField] || null;
  } catch {
    return null;
  }
}

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

/**
 * The statuses whose payload a requester may still change. `reworkRequired` joined `draft` on
 * 2026-08-19: a rejection hands the request back rather than ending it, so a reworkable request has
 * to be writable by the same code path a draft is.
 */
const EDITABLE_STATUSES = Object.freeze(['draft', 'reworkRequired']);

/**
 * The statuses `withdrawRequest` will delete. Deliberately the editable ones and nothing else:
 * anything further along either carries `postedBP` - the idempotency guard that stops an SPA retry
 * creating a second business partner - or is being decided on by somebody else right now.
 */
const WITHDRAWABLE_STATUSES = EDITABLE_STATUSES;

/**
 * What `resubmitRequest` sends to the parked SPA process. Arthur's definition branches on this input
 * value and routes the request back to the approver.
 *
 * **Capitalised, and that is his spelling, not a slip.** The approve and reject signals are
 * lowercase (`approved`/`rejected`); he specified `Resubmitted` for this one on 2026-08-19. Worth
 * confirming his trigger is case-sensitive before tidying these into one convention - a signal that
 * silently fails to match leaves a request parked forever.
 */
const RESUBMITTED_SIGNAL = 'Resubmitted';

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
  return requestUrl(changeRequest, 'approve');
}

/**
 * Deep link to this request's **rework** view, sent to BPA as `reworkurl` so the
 * notification the requester gets on a rejection can point straight at it.
 *
 * Sent with the initial workflow context rather than at rejection time, because
 * the rejection happens inside SPA and it has the context to hand there. Nothing
 * else reaches this screen: the change request list is steward-gated, so this URL
 * is the requester's only way in.
 */
function reworkUrl(changeRequest) {
  return requestUrl(changeRequest, 'rework');
}

/**
 * APPROUTER_URL is provided by mta.yaml (the approuter module's own route, via
 * MTA's provides/requires) - unset in local/hybrid dev, where there is no
 * approuter, so this degrades to an empty string rather than a broken link.
 */
function requestUrl(changeRequest, verb) {
  const approuterUrl = process.env.APPROUTER_URL;
  if (!approuterUrl) return '';
  return `${approuterUrl.replace(/\/$/, '')}/mdmmdbusinesspartnermanage/index.html#ChangeRequests/${changeRequest}/${verb}`;
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
              action: rowAction(source),
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
    /**
     * The BP context SPA gets about a request. **One builder for both paths**, because a resubmit
     * has to hand the approver the same shape a first submit does - Arthur binds the same fields
     * either way, and two copies of this object would drift the first time one grew a key.
     *
     * At submit it is the `startWorkflow` context; at resubmit it is spread flat into `inputs`
     * alongside `result`. Rebuild it *after* `persist()` on a resubmit, or the approver is shown the
     * data from before the rework - the whole point of the loop is that the requester changed it.
     */
    const workflowContext = async (req, changeRequest, header, findings) => {
      // Best-effort, like every other piece of the workflow payload: a problem shaping the preview
      // data must not block the submit, it should just leave the approver with a thinner (but still
      // working) businesspartnerinput. Built after the duplicate gate, so an unconfirmed submit
      // never pays for a payload it will not send.
      let businessPartnerInput = {};
      try {
        businessPartnerInput = await buildBusinessPartnerInput(db, s4, header);
      } catch (error) {
        console.error(`Could not build businesspartnerinput for change request ${changeRequest}:`, error);
      }
      return {
        changerequestid: changeRequest,
        requesttype: req.data.RequestType,
        businesspartner: req.data.BusinessPartner || '',
        emailadressinitiator: requestingUserEmail(req),
        bpurl: approveUrl(changeRequest),
        // Where to send the requester if the approver rejects. Sent with the context rather than at
        // rejection time because SPA owns the rejection branch, and this is the requester's only
        // route in.
        reworkurl: reworkUrl(changeRequest),
        businesspartnerinput: businessPartnerInput,
        // One entry per matched partner, so the approver sees what was flagged and why. Empty when
        // nothing matched, never absent - SPA can then bind it without a null check.
        bpduplicates: duplicateSummary(findings)
      };
    };

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
        // `reworkRequired` is editable for the same reason `draft` is: nobody has accepted it. A
        // rejection sends the request back to the requester, so this is the one guard that decides
        // whether rework is possible at all - it used to be draft-only.
        if (!EDITABLE_STATUSES.includes(existing.status)) {
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

    // Both buttons, one pipeline: each runs only the stages its answer needs, and neither stages
    // anything. Derivations run for both — a rule needs them even when the screen never shows them.
    const runRequestChecks = async (req, { propose, duplicates, scope = null }) => {
      const data = parseJsonObject(req.data.DataJson, 'DataJson');
      // Created per request: the pair shares one VIES/GLEIF lookup between the validation and the
      // derivation, and must not carry it over to the next press of the button.
      const registry = createRegistryStages();
      // The steward's tables plus the registries, and configured first in both lists.
      //
      // Validations: these are deterministic and offline, so a request that fails one is reported
      // without a VIES call being spent on it. Derivations: the pipeline never overwrites, so
      // whichever stage fills a field first wins — and an explicitly configured rule is a decision
      // somebody made about this field, where the registry is a lookup that happens to have one.
      const configured = await configuredStages();
      return runChecks(
        { root: data.root || {}, sections: data.sections || {} },
        {
          validations: [...configured.validations, ...registry.validations],
          derivations: [...configured.derivations, ...registry.derivations],
          // Check is where a human is looking, which is the only place a proposal to rewrite
          // what someone typed makes sense. The register never proposes: it validates and derives.
          propose: propose
            ? (derived) => proposeNormalisations({ payload: derived, scope: scope || null })
            : undefined,
          checkDuplicates: duplicates ? async (payload) => {
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
          } : undefined
        }
      );
    };

    this.on('checkRequest', async (req) => {
      const result = await runRequestChecks(req, {
        propose: req.data.Propose !== false,
        duplicates: false,
        scope: req.data.Scope || null
      });
      return {
        Valid: result.valid,
        ValidationsJson: JSON.stringify(result.validations),
        DerivationsJson: JSON.stringify(result.derivations),
        NormalisationsJson: JSON.stringify(result.normalisations)
      };
    });

    this.on('duplicateCheckRequest', async (req) => {
      const result = await runRequestChecks(req, { propose: false, duplicates: true });
      return {
        Valid: result.valid,
        RanDuplicateCheck: result.ranDuplicateCheck,
        ValidationsJson: JSON.stringify(result.validations),
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
      const configured = await configuredStages();
      const validations = await runValidations(
        { root: data.root || {}, sections: data.sections || {} },
        [...configured.validations, ...registry.validations]
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
      const context = await workflowContext(req, changeRequest, header, findings);

      let processInstanceId = null;
      try {
        const result = await startWorkflow(APPROVAL_WORKFLOW_DEFINITION_ID, context);
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
     * Rework: back into approval.
     *
     * Everything a first submit gates on is gated on again - the validations and the duplicate
     * check with its confirming second press - because a reworked request is one nobody has judged.
     * The requester may well have changed the very fields the duplicate check reads.
     *
     * What differs is the last step, and only that: the SPA process instance is still parked
     * waiting for this request, so it is **signalled rather than started**. One instance per change
     * request means one audit thread on Arthur's side across however many rework rounds happen.
     */
    this.on('resubmitRequest', async (req) => {
      const requested = req.data.ChangeRequest;
      const before = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: requested }));
      if (!before) return req.reject(404, `Change request ${requested} was not found.`);
      if (before.status !== 'reworkRequired') {
        return req.reject(409,
          `Change request ${requested} is ${before.status}, not awaiting rework. Only a request the`
          + ' approver sent back can be resubmitted.');
      }
      // The parked instance IS the resubmit target. Without it there is nothing to hand back to,
      // and silently starting a fresh workflow would give one request two audit threads and
      // possibly two approver tasks.
      if (!before.processInstanceId) {
        return req.reject(409,
          `Change request ${requested} has no approval process to hand back to, so it cannot be`
          + ' resubmitted. Withdraw it and raise a new request.');
      }

      const changeRequest = await persist(req);
      if (!changeRequest) return;

      // The same gates as a submit, in the same order. Derivations still do not run here.
      const data = parseJsonObject(req.data.DataJson, 'DataJson');
      const registry = createRegistryStages();
      const configured = await configuredStages();
      const validations = await runValidations(
        { root: data.root || {}, sections: data.sections || {} },
        [...configured.validations, ...registry.validations]
      );
      if (validations.some((message) => message.severity === BLOCKING)) {
        return {
          ChangeRequest: changeRequest,
          Status: 'reworkRequired',
          NeedsConfirmation: false,
          Valid: false,
          ValidationsJson: JSON.stringify(validations),
          MessagesJson: JSON.stringify([])
        };
      }

      const findings = await recordDuplicateFindings(changeRequest, req.data.BusinessPartner);
      const duplicates = findings.filter((finding) => finding.verdict);
      if (duplicates.length && !req.data.Confirm) {
        return {
          ChangeRequest: changeRequest,
          Status: 'reworkRequired',
          NeedsConfirmation: true,
          Valid: true,
          ValidationsJson: JSON.stringify(validations),
          MessagesJson: JSON.stringify(findings)
        };
      }

      // Re-read and rebuilt AFTER persist, so what the approver is handed is the reworked data.
      // Sending `before` here would show them exactly the version they had already rejected.
      const header = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest }));
      const context = await workflowContext(req, changeRequest, header, findings);

      // Left in `reworkRequired` if the signal fails, for the same reason a failed start leaves a
      // submit in `draft`: a request in `inApproval` that no process is actually waiting on sits in
      // nobody's inbox, and the requester would have no way to try again.
      try {
        // The BP context goes flat inside `inputs`, next to `result` - Arthur's shape. `executionId`
        // is the parked process instance, which is what he calls the CR id.
        await triggerApprovalDecision(before.processInstanceId, RESUBMITTED_SIGNAL, context);
      } catch (error) {
        return req.reject(502,
          `The reworked request was saved but the approval process could not be notified:`
          + ` ${error.message}`);
      }

      await db.run(cds.ql.UPDATE(HEADER).set({
        status: 'inApproval',
        // Overwritten on purpose: the resubmit is the submission that matters now, and the original
        // timestamp is of no use to anyone once the request has been round the loop.
        submittedAt: new Date().toISOString(),
        submittedBy: requestingUserEmail(req)
      }).where({ ID: changeRequest }));

      return {
        ChangeRequest: changeRequest,
        Status: 'inApproval',
        ProcessInstanceId: before.processInstanceId,
        NeedsConfirmation: false,
        Valid: true,
        ValidationsJson: JSON.stringify(validations),
        MessagesJson: JSON.stringify(findings)
      };
    });

    /**
     * Rework: out of existence.
     *
     * The children are deleted explicitly rather than left to the compositions' cascade. Every node
     * here is linked by an explicit `request` backlink with its own ON condition (see
     * db/staging.cds), and relying on cascade semantics through that would be trusting the one part
     * of this model that already had to be spelled out by hand.
     */
    this.on('withdrawRequest', async (req) => {
      const changeRequest = req.data.ChangeRequest;
      const header = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest }));
      // Already gone. Idempotent rather than a 404, so a double-press or a retried call is not an
      // error the requester has to interpret.
      if (!header) return { ChangeRequest: changeRequest, Deleted: false };

      // The guard that must never be relaxed: deleting a posted request destroys `postedBP`, and an
      // SPA retry would then create a second business partner for the same request.
      if (header.postedBP) {
        return req.reject(409,
          `Change request ${changeRequest} has already created business partner ${header.postedBP}`
          + ' and cannot be withdrawn.');
      }
      if (!WITHDRAWABLE_STATUSES.includes(header.status)) {
        return req.reject(409,
          `Change request ${changeRequest} is ${header.status} and cannot be withdrawn.`
          + ' Only a draft or a request sent back for rework can be.');
      }

      /**
       * Signalled before the delete, and best-effort either way.
       *
       * There is no ordering here that cannot strand something: signal first and a failed delete
       * leaves SPA thinking the request is gone while the row lives on; delete first and a failed
       * signal leaves a process pointing at nothing. Both end as a stuck task a human clears, so
       * this follows the rule every other workflow side effect here follows - the local record is
       * what must be right, and a BPA outage must not stop a requester withdrawing their own
       * request. The failure is surfaced rather than swallowed.
       */
      if (header.processInstanceId) {
        try {
          await triggerApprovalDecision(header.processInstanceId, 'withdrawn');
        } catch (error) {
          console.error(`Could not tell the approval process that ${changeRequest} was withdrawn:`, error);
          req.info(200,
            'The request was withdrawn, but the approval process could not be notified. Any open'
            + ' approver task may need clearing by hand.');
        }
      }

      for (const node of Object.values(NODES)) {
        await db.run(cds.ql.DELETE.from(node.entity).where({ request_ID: changeRequest }));
      }
      await db.run(cds.ql.DELETE.from(GENERAL).where({ request_ID: changeRequest }));
      await db.run(cds.ql.DELETE.from(FINDINGS).where({ request_ID: changeRequest }));
      await db.run(cds.ql.DELETE.from(HEADER).where({ ID: changeRequest }));

      return { ChangeRequest: changeRequest, Deleted: true };
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
        RejectionComment: header.rejectionComment,
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

      // Resolved lazily, once per relation field, on first use below - by the
      // time a Customer/Supplier-related node is reached, an earlier node in
      // this same run may have just posted the role that creates the record.
      const resolvedRelations = {};

      for (const [section, config] of Object.entries(NODES)) {
        const rows = await db.run(
          cds.ql.SELECT.from(config.entity).where({ request_ID: header.ID })
        );
        for (const row of rows) {
          const { ID, request_ID: parent, action, ...data } = row;
          // Staged for context only - the user never touched it.
          if (!action) continue;
          const relationField = RELATION_FIELDS[section] || 'BusinessPartner';

          if (!(relationField in resolvedRelations)) {
            resolvedRelations[relationField] = await resolveRelationNumber(s4, businessPartner, relationField);
          }
          const relationValue = resolvedRelations[relationField];
          if (relationValue == null) {
            throw new Error(
              `Cannot post ${section}: Business Partner ${businessPartner} has no ${relationField} record yet.`
            );
          }
          data[relationField] = relationValue;

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

      /**
       * A rejection is a loop, not an end (2026-08-19). The request goes to `reworkRequired` and
       * back to the requester, who edits it and either resubmits or withdraws it. `rejected` is
       * never written any more - it stays in the enum only because cds-deploy refuses to drop it.
       *
       * The approver's comment goes to `rejectionComment`, NOT over `reason`. Overwriting was
       * harmless while a rejection was terminal; now the requester reopens this record, and they
       * would find their own justification replaced by the verdict on it - and then resubmit the
       * approver's words as their reason.
       *
       * The workflow is still signalled, and it must NOT be completed: the instance stays parked
       * waiting for the requester, which is what `resubmitRequest` hands back to.
       */
      if (decision === 'reject') {
        await db.run(cds.ql.UPDATE(HEADER).set({
          status: 'reworkRequired',
          rejectionComment: req.data.Comment || null
        }).where({ ID: changeRequest }));
        await notifyWorkflow('rejected');
        return { ChangeRequest: changeRequest, Status: 'reworkRequired', BusinessPartner: null };
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
  reworkUrl,
  buildBusinessPartnerInput,
  activeStagedRows,
  SUPPORTED_REQUEST_TYPES,
  EDITABLE_STATUSES,
  WITHDRAWABLE_STATUSES,
  RESUBMITTED_SIGNAL,
  FINDING_COLUMNS,
  stagedFinding,
  resolveRelationNumber,
  RELATION_NAVIGATION,
  RELATION_FIELDS
};

module.exports = ChangeRequestService;
