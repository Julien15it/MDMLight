'use strict';

const cds = require('@sap/cds');
const {
  startWorkflow, triggerApprovalDecision, triggerRequesterCallback
} = require('./wf/processAutomation');
const {
  buildWorkflowInputFromRows, businessPartnerNavigationPath, normalizeRemoteResult
} = require('./business-partner-service')._internals;
const { candidateFromStagedRequest, duplicateSummary } = require('./ai/duplicate-check');
const { runChecks, runValidations, BLOCKING } = require('./checks/pipeline');
const { createRegistryStages } = require('./checks/registry-checks');
const { configuredStages } = require('./checks/rule-store');
const { fieldPropertyStages, resolvedProperties } = require('./checks/field-property-store');
const { approversFor } = require('./checks/workflow-rule-store');
const { proposeNormalisations } = require('./checks/normalise');
const { aiAssistanceEnabled } = require('./ai/availability');
const { PAYLOAD_NODES, ROOT_SECTION } = require('./checks/payload-fields');

const STAGING = 'mdmlight.staging.';
const FINDINGS = `${STAGING}CheckFindings`;

// Section id -> staging entity, using the generated metadata ids so nothing is translated. Derived
// from PAYLOAD_NODES so a rule cannot name a section nothing stages; General is the root, not a node.
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

// CVI does not guarantee Customer/Supplier == BusinessPartner, so posting under the BP number could
// hit a record that does not exist. Plain field first, navigation as fallback, null if neither.
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

// Payloads a requester may still change. `reworkRequired` joined `draft` because a rejection hands
// the request back rather than ending it.
const EDITABLE_STATUSES = Object.freeze(['draft', 'reworkRequired']);

// The editable ones and nothing else: anything further along carries `postedBP` (the guard against
// an SPA retry creating a second BP) or is being decided on by someone else.
const WITHDRAWABLE_STATUSES = EDITABLE_STATUSES;

// Arthur's trigger branches on this. Capitalised is his spelling; approve/reject are lowercase, so
// confirm case-sensitivity before unifying them - an unmatched signal parks a request forever.
const RESUBMITTED_SIGNAL = 'Resubmitted';

// Same requester trigger. Follows Resubmitted's capitalisation, but he never specified this one -
// confirm it, or the instance stays parked on a change request that no longer exists.
const WITHDRAWN_SIGNAL = 'Withdrawn';

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

// Only elements the staging entity has: the screen also carries unstaged S/4 fields and its own
// __state/__keys, which would fail the insert on an unknown column.
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

/** A row staged for context only. Never replayed to S/4 - see postToS4. */
const UNTOUCHED = 'N';

// 'new' -> C, any other state -> U, nothing -> N: the whole partner is staged so the approver sees it
// in full, but only touched rows may be replayed to S/4.
//
// `N` rather than null, fixed 2026-08-20: `action` is `not null` on every staged node, so a null was
// a 500 the moment a payload carried a row nobody had touched. A first submit never did - every row
// is new - but a resubmit reloads the request from staging, where nothing carries `__state`.
/**
 * The inverse of `rowAction`, for the payload the screen is served. `D` rows are handed back through
 * `deleted` and re-staged as `D` whatever they carry, so they need no state of their own.
 */
function stateOfAction(action) {
  if (action === 'C') return { __state: 'new' };
  if (action === 'U') return { __state: 'modified' };
  return {};
}

function rowAction(record) {
  if (record?.__state === 'new') return 'C';
  if (record?.__state) return 'U';
  return UNTOUCHED;
}

/**
 * The context the field property profiles are matched against on any write path. The role is
 * **always** `Requester` and is never taken from the client: whoever submits a request is its
 * requester, and a role the client could name is one it could name its way out of a mandatory
 * field with. The approve and rework screens ask for their own view through
 * `effectiveFieldProperties`, which renders but never gates.
 *
 * When the role model lands (an approver role per function, a steward role, a requester role), this
 * becomes a scope read off `req.user` and the two paths converge.
 */
const requesterContext = (req) => ({ requestType: req.data.RequestType, role: 'Requester' });

function requestingUserEmail(req) {
  return req.user?.attr?.email || req.user?.id || 'unknown';
}

/** Deep link to the approve view, sent to BPA as `bpurl` to route the approver there. */
function approveUrl(changeRequest) {
  return requestUrl(changeRequest, 'approve');
}

// Sent as `reworkurl` with the initial context, because SPA owns the rejection branch. The change
// request list is steward-gated, so this link is the requester's only way to the rework screen.
function reworkUrl(changeRequest) {
  return requestUrl(changeRequest, 'rework');
}

/**
 * A deep link into the app as the **managed** approuter serves it: the Work Zone site URL plus a
 * cross-navigation INTENT, then the app's own route after `&/`.
 *
 * The old `<approuter-host>/mdmmdbusinesspartnermanage/index.html#<route>` shape belonged to the
 * standalone approuter, which was removed on 2026-08-13 - that host now 404s, which is what a
 * requester got when they clicked a reworkurl. `APPROUTER_URL` is deliberately NOT read any more:
 * it was left set on the deployed app and kept producing the dead host. `WORKZONE_URL` is a new
 * name so a stale value cannot resurrect the bug, and an unset one degrades to an empty string -
 * a missing link is diagnosable, a 404 is not.
 *
 * `BusinessPartner-manage` is the inbound in app/businesspartner/webapp/manifest.json. Renaming
 * that inbound breaks these links.
 */
function requestUrl(changeRequest, verb) {
  const siteUrl = process.env.WORKZONE_URL;
  if (!siteUrl) return '';
  // Any existing hash is dropped, because the URL Site Manager hands you ends in `#Shell-home` -
  // the launchpad's own intent. Ours replaces it; keeping both would produce two hashes and resolve
  // to the home page. The query string (`?siteId=...`) is part of the base and stays.
  const base = siteUrl.split('#')[0].replace(/\/+$/, '');
  return `${base}#BusinessPartner-manage&/ChangeRequests/${changeRequest}/${verb}`;
}

/** Staged rows for a many-cardinality node, deletions excluded - a request in
 * review is judged on the state it is proposing, not on what it is removing. */
async function activeStagedRows(db, entity, changeRequest) {
  const rows = await db.run(cds.ql.SELECT.from(entity).where({ request_ID: changeRequest }));
  return rows.filter((row) => row.action !== 'D');
}

// The workflow's businesspartnerinput, built from staged rows rather than a live S/4 read - a create
// has no S/4 record yet. `businessPartner` is backfilled onto child rows carrying no key of their own.
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

    // Wholesale replace: a save always carries the complete screen state, so rewriting beats diffing
    // and no stale row can survive.
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
    // One builder for submit (the startWorkflow context) and resubmit (spread flat into `inputs`), so
    // the shapes cannot drift. On a resubmit build it AFTER persist(), or it carries pre-rework data.
    const workflowContext = async (req, changeRequest, header, findings) => {
      // Best-effort: a shaping problem leaves the approver a thinner preview rather than blocking the
      // submit. After the duplicate gate, so an unconfirmed submit never pays for a payload it discards.
      let businessPartnerInput = {};
      try {
        businessPartnerInput = await buildBusinessPartnerInput(db, s4, header);
      } catch (error) {
        console.error(`Could not build businesspartnerinput for change request ${changeRequest}:`, error);
      }
      // Who approves this one, from the WorkflowRules table. Determined HERE rather than earlier, so
      // it is decided on the payload actually being submitted: after the validations and the
      // duplicate gate, and after a rework rather than on the version the approver rejected.
      // Best-effort like `businesspartnerinput`. An empty list is what an installation with no rules
      // configured sends, and what every submit sent before this table existed, so SPA falls back to
      // its own routing rather than a requester losing a submit over a routing hint.
      let payload = {};
      try {
        payload = parseJsonObject(req.data.DataJson, 'DataJson');
      } catch (error) {
        console.warn(`Could not read the payload to determine the approvers of ${changeRequest}:`, error.message);
      }
      const approvers = await approversFor({
        requestType: req.data.RequestType,
        payload: { root: payload.root || {}, sections: payload.sections || {} }
      });

      return {
        changerequestid: changeRequest,
        requesttype: req.data.RequestType,
        businesspartner: req.data.BusinessPartner || '',
        emailadressinitiator: requestingUserEmail(req),
        bpurl: approveUrl(changeRequest),
        // Where the requester goes if rejected. Sent now because SPA owns the rejection branch.
        reworkurl: reworkUrl(changeRequest),
        businesspartnerinput: businessPartnerInput,
        // One entry per matched partner, so the approver sees what was flagged and why. Empty when
        // nothing matched, never absent - SPA can then bind it without a null check.
        bpduplicates: duplicateSummary(findings),
        // Flattened to the values, because the deployed process declares `approvers` as an array of
        // strings and the runtime validates against that: sending `{ step, kind, value }` fails the
        // whole submit with "/approvers/0 The value must be of string type, but actual type is
        // object", which is every create refused over a routing hint.
        //
        // So this is the boundary, not the design. resolveApprovers still returns the structured
        // list, and `kind` is still derivable the way it is derived here - an entry carrying an `@`
        // is a user. What is genuinely lost is `step`: two steps arrive as one list. Restoring it
        // means declaring `approvers` as an array of objects in the process context, after which
        // this map comes off again.
        approvers: approvers.map((approver) => approver.value)
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
        // The one guard that decides whether rework is possible at all; it used to be draft-only.
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

    // A `Duplicate` verdict raises an error finding for the approver to clear rather than blocking the
    // submit - the approver is the override. Best-effort: a failed check must not strand the request.
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
      // Configured first in both lists: the validations are offline, so a failure costs no VIES call;
      // and the pipeline never overwrites, so an explicit rule should win over a registry lookup.
      const configured = await configuredStages();
      // The requester is who is pressing the button, always. A role the client could name would be
      // one it could also name its way out of - see `requesterProperties`.
      const properties = await fieldPropertyStages(requesterContext(req));
      return runChecks(
        { root: data.root || {}, sections: data.sections || {} },
        {
          validations: [...properties.validations, ...configured.validations, ...registry.validations],
          derivations: [...configured.derivations, ...registry.derivations],
          // Check is where a human is looking, which is the only place a proposal to rewrite
          // what someone typed makes sense. The register never proposes: it validates and derives.
          propose: propose
            ? async (derived) => proposeNormalisations({
              payload: derived,
              scope: scope || null,
              aiEnabled: await aiAssistanceEnabled()
            })
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

    /**
     * What the screen has to show, hide, freeze and star, for one request type and one role. Purely
     * a rendering answer: the gate is `field_properties` in the validation list, which runs on the
     * requester's own context whatever a screen was told.
     */
    this.on('effectiveFieldProperties', async (req) => {
      const resolved = await resolvedProperties({
        requestType: req.data.RequestType || null,
        role: req.data.Role || null
      });
      return JSON.stringify(resolved);
    });

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

      // The Check button's validations, over the payload being submitted. Derivations deliberately do
      // NOT run: they change the data, and the requester has to have seen what they are asking for.
      const data = parseJsonObject(req.data.DataJson, 'DataJson');
      const registry = createRegistryStages();
      const configured = await configuredStages();
      const properties = await fieldPropertyStages(requesterContext(req));
      const validations = await runValidations(
        { root: data.root || {}, sections: data.sections || {} },
        [...properties.validations, ...configured.validations, ...registry.validations]
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

    // Rework, back into approval. Every gate a first submit runs, runs again - a reworked request is
    // one nobody has judged. Only the last step differs: the parked instance is signalled, not started.
    this.on('resubmitRequest', async (req) => {
      const requested = req.data.ChangeRequest;
      const before = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: requested }));
      if (!before) return req.reject(404, `Change request ${requested} was not found.`);
      if (before.status !== 'reworkRequired') {
        return req.reject(409,
          `Change request ${requested} is ${before.status}, not awaiting rework. Only a request the`
          + ' approver sent back can be resubmitted.');
      }
      // The parked instance IS the target; starting a fresh workflow would give one request two threads.
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
      const properties = await fieldPropertyStages(requesterContext(req));
      const validations = await runValidations(
        { root: data.root || {}, sections: data.sections || {} },
        [...properties.validations, ...configured.validations, ...registry.validations]
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

      // Left in `reworkRequired` on failure: `inApproval` with no process waiting sits in nobody's inbox.
      try {
        // The requester's own trigger, not the approver's. Context goes flat inside `inputs` next to
        // `result`; `executionId` is the parked process instance, which Arthur calls the CR id.
        await triggerRequesterCallback(before.processInstanceId, RESUBMITTED_SIGNAL, context);
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

    // The rework screen's way of learning what SPA never told us. Arthur's rejection branch notifies
    // the requester with the `reworkurl` but does not call `decideRequest`, so the request is still
    // `inApproval` when they arrive - and every gate downstream reads the status. Opening that link is
    // taken as the evidence: it is only ever sent on a rejection.
    //
    // Cost of the shortcut, accepted 2026-08-20: the link is in the requester's mailbox for good, so
    // clicking it again after a resubmit pulls a live approval back into rework. Remove this handler
    // once the reject callback exists - `decideRequest` is the real transition.
    this.on('claimRework', async (req) => {
      const changeRequest = req.data.ChangeRequest;
      const header = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest }));
      if (!header) return req.reject(404, `Change request ${changeRequest} was not found.`);

      // A posted request has a business partner behind it, whatever its status says.
      if (header.postedBP || header.status !== 'inApproval') {
        return { ChangeRequest: changeRequest, Status: header.status, Claimed: false };
      }

      // No workflow signal: the process already branched on the approver's rejection, and a second
      // decision on the parked instance is not one it is waiting for.
      await db.run(cds.ql.UPDATE(HEADER).set({ status: 'reworkRequired' }).where({ ID: changeRequest }));
      return { ChangeRequest: changeRequest, Status: 'reworkRequired', Claimed: true };
    });

    // Rework, out of existence. Children are deleted explicitly rather than by cascade: every node is
    // linked by a hand-written `request` backlink with its own ON condition, so cascade is not trusted.
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

      // Signalled before the delete, best-effort: no ordering avoids stranding something, so the local
      // record is what must be right. A BPA outage must not stop a requester withdrawing their request.
      if (header.processInstanceId) {
        try {
          await triggerRequesterCallback(header.processInstanceId, WITHDRAWN_SIGNAL, {
            // The CR id, because by the time Arthur reads this the row is gone and `executionId`
            // alone leaves him nothing to log it against.
            changerequestid: changeRequest
          });
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

    // Staged rows back into the screen's own payload shape, so the approve view reuses one code path.
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
          // The stored action comes back as the screen's own `__state`, or a resubmit would stage
          // every untouched row as `N` and the approved request would post a partner without its
          // addresses. The screen keeps `new` through further edits (it only ever promotes to
          // `modified`), so a round trip cannot turn a create into an update either.
          return { ...rest, ...stateOfAction(action) };
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

    // Replayed through BusinessPartnerService, which owns the S/4 connection and payload sanitizing.
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

      // Lazily, once per relation field: an earlier node in this run may have just created the record.
      const resolvedRelations = {};

      for (const [section, config] of Object.entries(NODES)) {
        const rows = await db.run(
          cds.ql.SELECT.from(config.entity).where({ request_ID: header.ID })
        );
        for (const row of rows) {
          const { ID, request_ID: parent, action, ...data } = row;
          // Staged for context only - the user never touched it. Null covers rows staged before
          // `N` existed; both mean the same thing and neither may reach S/4.
          if (!action || action === UNTOUCHED) continue;
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

      // Resumes the paused workflow with the decision. Best-effort and fired regardless of the S/4 post:
      // the workflow waits on the decision, not on posting, and a signalling failure must not lose it.
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

      // A rejection is a loop, not an end: back to the requester, instance left parked for the resubmit.
      // The comment goes to `rejectionComment`, never over the requester's own `reason`.
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
  rowAction,
  stateOfAction,
  UNTOUCHED,
  reworkUrl,
  buildBusinessPartnerInput,
  activeStagedRows,
  SUPPORTED_REQUEST_TYPES,
  EDITABLE_STATUSES,
  WITHDRAWABLE_STATUSES,
  RESUBMITTED_SIGNAL,
  WITHDRAWN_SIGNAL,
  FINDING_COLUMNS,
  stagedFinding,
  resolveRelationNumber,
  RELATION_NAVIGATION,
  RELATION_FIELDS
};

module.exports = ChangeRequestService;
