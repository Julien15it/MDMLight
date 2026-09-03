'use strict';

const cds = require('@sap/cds');
const {
  startWorkflow, triggerApprovalDecision, triggerRequesterCallback, triggerPostResult
} = require('./wf/processAutomation');
const {
  buildWorkflowInputFromRows, businessPartnerNavigationPath, normalizeRemoteResult,
  MAINTENANCE_ENTITIES
} = require('./business-partner-service')._internals;
const { candidateFromStagedRequest, duplicateSummary } = require('./ai/duplicate-check');
const { runChecks, runValidations, BLOCKING } = require('./checks/pipeline');
const { createRegistryStages } = require('./checks/registry-checks');
const { createCviStages } = require('./checks/cvi-checks');
const { createDerivationStages } = require('./checks/derivation-checks');
const { createBpCheckStage } = require('./checks/bp-check');
const { createRelationStages } = require('./checks/relation-checks');
const { createNodeRequiredStages } = require('./checks/node-required');
const { configuredStages } = require('./checks/rule-store');
const { fieldPropertyStages, resolvedProperties } = require('./checks/field-property-store');
const { fieldState } = require('./checks/field-properties');
const { dataStewardEmails, dataStewardRoles } = require('./wf/data-stewards');
const { specificRoleFor, isMemberOfRole } = require('./wf/btp-agents');

// The screen role a data steward's own step renders under, and the one step the SAP standard checks
// run on - see `stewardStep` in runRequestChecks.
const DATASTEWARD_ROLE = 'DataSteward';

// Categories a screen resolves to a literal - the only ones worth narrowing to a specific BTP role.
// `Requester` is deliberately excluded: it names who submitted, never a role collection, and
// requesterContext hardcodes it for exactly that reason. Spelled out rather than built from
// DATASTEWARD_ROLE above: test/field-property-apply.test.js pins this line literally.
const RESOLVABLE_ROLE_CATEGORIES = ['Approver', 'DataSteward'];

/**
 * Whoever `workflowContext` assigned to the step this request is CURRENTLY on - `approverSequenceJson`
 * (the same ordered `approvers` array BPA got at submit) indexed by `approvalsReceived` (2026-09-02),
 * the same index BPA's own routing script advances with its own counter. Null when there is nothing to
 * index into: no header (a create draft, never yet a change request), a request that predates this
 * column, an empty/unparsable sequence, or an index past its end (should not happen - decideRequest
 * never lets `approvalsReceived` exceed `requiredApprovals` - but a request from before either column
 * existed could carry a mismatched pair, and a bounds miss reads as "nothing to disambiguate with"
 * rather than throwing).
 */
function currentStepAssignee(header) {
  if (!header || !header.approverSequenceJson) return null;
  try {
    const sequence = JSON.parse(header.approverSequenceJson);
    return Array.isArray(sequence) ? (sequence[header.approvalsReceived || 0] || null) : null;
  } catch {
    return null;
  }
}

/**
 * Narrows the generic category a screen sends (`Approver`/`DataSteward`) into the CURRENT user's own,
 * more specific BTP role - "Approver Customer" rather than the bare "Approver" - so two Field
 * Property Profiles scoped to different functions actually apply to different people, instead of
 * both always matching the one screen every approver (or every data steward) renders. See
 * `effectiveFieldProperties` below and CLAUDE.md "Field property profiles".
 *
 * `header` (optional - the caller's own already-read `ChangeRequests` row) is tried FIRST, via
 * `currentStepAssignee`: a user holding several approver-shaped roles (say "Approver Sales" AND
 * "Approver Finance") is otherwise a case `specificRoleFor` cannot resolve at all - it returns null
 * on purpose rather than guess between them (see its own doc comment) - because nothing before this
 * knew WHICH of a user's own roles was actually assigned to THIS request's current step. Checking
 * "is it this specific user's turn" (an exact BTP membership check, `isMemberOfRole`) rather than
 * "which of this user's roles looks like an Approver" removes the guess entirely, whenever a header
 * with a stored sequence is available and the current user is who it names.
 *
 * Falls through to the old, role-only resolution whenever the step-specific answer does not apply -
 * no header, no stored sequence, or the current user does not match who it names (someone else's
 * task opened by mistake, a request from before this column existed, or genuinely ambiguous data).
 *
 * Best-effort throughout, and the fallback is the literal category the screen asked for - not an
 * error, not a blocked render: an unreachable subaccount API, a user with no specific ...-prefixed
 * role of their own, or one with SEVERAL (ambiguous, so `specificRoleFor` already returns null for
 * it) all resolve the same way this whole page rendered before any of this existed.
 */
async function resolveEffectiveRole(req, role, header) {
  if (!RESOLVABLE_ROLE_CATEGORIES.includes(role)) return role;
  try {
    const email = requestingUserEmail(req);
    if (!email || email === 'unknown') return role;

    const assignee = currentStepAssignee(header);
    if (assignee) {
      const isThisUser = assignee.includes('@')
        ? assignee.toLowerCase() === email.toLowerCase()
        : await isMemberOfRole(email, assignee);
      if (isThisUser) return assignee;
    }

    const specific = await specificRoleFor(email, role);
    return specific || role;
  } catch (error) {
    console.warn(`Could not resolve a specific ${role} role for this render:`, error.message);
    return role;
  }
}
const { approversFor } = require('./checks/workflow-rule-store');
const { currentProcessors } = require('./request-processors');
const { withFullName, fullNameOf } = require('./partner-name');
const { proposeNormalisations } = require('./checks/normalise');
const { startWarmup } = require('./checks/warmup');
const { aiAssistanceEnabled } = require('./ai/availability');
const { PAYLOAD_NODES, ROOT_SECTION, sectionRows } = require('./checks/payload-fields');
const { uiPathPrefix } = require('./ui-prefix');

const STAGING = 'mdmlight.staging.';
const FINDINGS = `${STAGING}CheckFindings`;
const COMMENTS = `${STAGING}ChangeRequestComments`;

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

/**
 * The two nodes that are themselves the Customer/Supplier record rather than something
 * hanging off it. They are the only ones where a missing relation number is a state to
 * act on instead of an error, and the only ones whose create addresses A_BusinessPartner.
 */
const ROLE_NODES = new Set(['Customers', 'Suppliers']);

// The app's own post-time required fields, checked before a submit rather than during it. Built
// once: the three inputs are all module constants, so there is nothing per-request to resolve.
const nodeRequiredStages = createNodeRequiredStages({
  entities: MAINTENANCE_ENTITIES,
  relationFields: RELATION_FIELDS,
  roleNodes: ROLE_NODES
});

/** Navigation off A_BusinessPartner used to resolve each relation field's real
 *  number - see resolveRelationNumber. */
const RELATION_NAVIGATION = Object.freeze({
  Customer: { navigation: 'to_Customer', keyField: 'Customer' },
  Supplier: { navigation: 'to_Supplier', keyField: 'Supplier' }
});

/**
 * Sections whose rows **S/4 creates for itself** before this ever posts them.
 *
 * A customer sales area runs its partner determination procedure on creation, so SP/BP/PY/SH exist
 * the moment the sales area does - and `derivation-checks.js` proposes exactly those, from the same
 * `TKUPA`/`TPAER` the procedure reads. Posting them afterwards is S/4 being handed a row it already
 * made: `Customer 295: Partner role SP already exists (only provided once)`, and the whole request
 * to rework over it (reported live 2026-09-03). Same shape on the supplier side via `T077K`.
 *
 * So these are matched against what is really there and posted as UPDATES where S/4 got there
 * first. The natural key is `matchOn`; `assignedKey` is the part of the real key S/4 owns and only
 * a read can supply - which is why an update is impossible without one (`PartnerCounter` is
 * deliberately not staged, see MAINTENANCE_ENTITIES in business-partner-service.js).
 */
const SELF_DETERMINED_NODES = Object.freeze({
  CustomerSalesPartnerFunctions: Object.freeze({
    remote: 'API_BUSINESS_PARTNER.A_CustSalesPartnerFunc',
    filterField: 'Customer',
    matchOn: ['SalesOrganization', 'DistributionChannel', 'Division', 'PartnerFunction'],
    assignedKey: 'PartnerCounter'
  }),
  SupplierPartnerFunctions: Object.freeze({
    remote: 'API_BUSINESS_PARTNER.A_SupplierPartnerFunc',
    filterField: 'Supplier',
    matchOn: ['PurchasingOrganization', 'PartnerFunction'],
    assignedKey: 'PartnerCounter'
  })
});

const sameKeyValue = (left, right) => String(left ?? '').trim() === String(right ?? '').trim();

/** The row S/4 already holds for this staged one, or null. Matched on the natural key only. */
function matchDeterminedRow(rows, config, data) {
  if (!Array.isArray(rows)) return null;
  return rows.find(
    (row) => config.matchOn.every((field) => sameKeyValue(row[field], data[field]))
  ) || null;
}

/**
 * What S/4 holds for one self-determined section, read once per post. **Null means "could not
 * ask"**, not "nothing there" - the caller falls back to the create it would have done anyway, so
 * an unreadable S/4 leaves today's behaviour rather than inventing an update with no key.
 */
async function determinedRowsFor(s4, config, relationValue) {
  if (relationValue == null) return null;
  try {
    const rows = await s4.run(
      cds.ql.SELECT.from(config.remote).where({ [config.filterField]: relationValue })
    );
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn(
      `[post] Could not read the existing ${config.remote} rows of ${relationValue}:`, error.message
    );
    return null;
  }
}

const isNotFound = (error) => [404, 400].includes(Number(error?.statusCode ?? error?.status ?? error?.code));

/**
 * The same lookup as resolveRelationNumber, but it tells "no such record" apart from "could not
 * ask". The check at submit needs that distinction: resolveRelationNumber answers null for both,
 * which is right while posting - there is nothing to post onto either way - but at submit it
 * would turn an S/4 hiccup into a blocking error on every request.
 */
async function readRelationNumber(s4, businessPartner, relationField) {
  const relation = RELATION_NAVIGATION[relationField];
  if (!relation) return businessPartner;

  let plainFailed = false;
  try {
    const root = await s4.run(
      cds.ql.SELECT.one.from('API_BUSINESS_PARTNER.A_BusinessPartner')
        .columns(relation.keyField)
        .where({ BusinessPartner: businessPartner })
    );
    if (root?.[relation.keyField]) return root[relation.keyField];
  } catch {
    // The field may simply not be selectable; the navigation below is the real answer.
    plainFailed = true;
  }

  try {
    const path = businessPartnerNavigationPath(
      { navigation: relation.navigation },
      { BusinessPartner: businessPartner }
    );
    const result = normalizeRemoteResult(await s4.send({ method: 'GET', path }));
    return result?.[relation.keyField] || null;
  } catch (error) {
    // A 404 on to_Customer is the honest "this partner has no customer record". Anything else -
    // a timeout, a 500, an unreachable destination - is not an answer and must not read as one.
    if (isNotFound(error)) return null;
    throw error;
  }
}

// CVI does not guarantee Customer/Supplier == BusinessPartner, so posting under the BP number could
// hit a record that does not exist. Plain field first, navigation as fallback, null if neither.
/**
 * How long postToS4 waits for the Customer/Supplier record to appear before deciding it is absent.
 *
 * **Why there is a wait at all.** With CVI configured, creating the business partner with an FLCU01
 * or FLVN01 role is what creates the customer or vendor - but S/4 does that in POSTPROCESSING,
 * asynchronously, after the BP create returns. So for a short window straight after the root create,
 * `to_Customer` honestly 404s on a partner that is about to have one. Read in that window, the post
 * either refused a child ("has no Customer record yet") or tried to CREATE a role node S/4 was
 * already creating, and the whole request went to rework carrying an error - while the partner
 * itself was created and active. Reported live 2026-09-03: an approver got a failure, the requester
 * opened the rework screen, and the business partner was already there.
 *
 * **Only waited for straight after a root CREATE**, which is the only moment the race exists: on a
 * retry or a change request the partner has existed for minutes, and a record that is not there by
 * then is not coming. That narrowing is what lets the budget be generous - roughly 3 seconds, spent
 * only where CVI might still be working - instead of a cautious one that has to be short because
 * every approve would otherwise pay it. Paid at most once per relation field per post either way,
 * since `resolvedRelations` caches the answer.
 */
const RELATION_WAIT_ATTEMPTS = 5;
const RELATION_WAIT_MS = 800;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * `resolveRelationNumber`, retried while the answer is "not there". Returns null once the attempts
 * are used up, which is the same answer it always gave - the caller still decides what that means
 * (nothing to hang a child on, or a role node that has to be created).
 */
async function awaitRelationNumber(s4, businessPartner, relationField, {
  attempts = RELATION_WAIT_ATTEMPTS,
  delayMs = RELATION_WAIT_MS,
  resolve = resolveRelationNumber,
  wait = sleep
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const number = await resolve(s4, businessPartner, relationField);
    if (number != null) return number;
    if (attempt < attempts) await wait(delayMs);
  }
  return null;
}

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
// the request back rather than ending it. `checkAndEnrich` joined the same way (2026-08-26): a data
// steward enriching data is editing the payload exactly like a rework, just under a different status
// so it cannot be confused with a rejection.
const EDITABLE_STATUSES = Object.freeze(['draft', 'reworkRequired', 'checkAndEnrich']);

// The editable ones and nothing else: anything further along carries `postedBP` (the guard against
// an SPA retry creating a second BP) or is being decided on by someone else. This aliases
// EDITABLE_STATUSES on purpose (test/rework.test.js pins the two as equal), so `checkAndEnrich`
// joining the one joins the other: a data steward who cannot make a request work may withdraw it the
// same way a requester withdraws a rework, rather than leaving it stuck with no way out. Nothing in
// the UI offers a Withdraw button in that mode today - only the action itself allows it.
const WITHDRAWABLE_STATUSES = EDITABLE_STATUSES;

// Arthur's trigger branches on this. Capitalised is his spelling; approve/reject are lowercase, so
// confirm case-sensitivity before unifying them - an unmatched signal parks a request forever.
const RESUBMITTED_SIGNAL = 'Resubmitted';

// Same requester trigger. Follows Resubmitted's capitalisation, but he never specified this one -
// confirm it, or the instance stays parked on a change request that no longer exists.
const WITHDRAWN_SIGNAL = 'Withdrawn';

// The data steward's own signals - placeholder names, unconfirmed like WITHDRAWN_SIGNAL above:
// nothing on Arthur's side listens for either yet (see CLAUDE.md, "Data steward enrichment"). Follows
// the same capitalisation convention as RESUBMITTED_SIGNAL/WITHDRAWN_SIGNAL on the assumption his
// process will too - confirm both before relying on either, or the instance stays parked.
const DATASTEWARD_COMPLETE_SIGNAL = 'DataStewardComplete';
const DATASTEWARD_REJECTED_SIGNAL = 'DataStewardRejected';

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

/**
 * Appends one row to the running thread rather than overwriting anything - `reason` and
 * `rejectionComment` on the header only ever held the latest side's word, which is right for them
 * (they still work exactly as before) but wrong for a rework loop that can run several rounds.
 * Silently a no-op on an empty/whitespace-only text: a blank comment is not a message anyone sent.
 */
async function appendComment(db, changeRequest, role, author, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  await db.run(cds.ql.INSERT.into(COMMENTS).entries({
    request_ID: changeRequest,
    role,
    author,
    text: trimmed
  }));
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

// Sent as `datastewardurl`, for a workflow step that routes to a data steward instead of straight
// back to the approver - not built on Arthur's side yet, like the process side of rework itself.
function dataStewardUrl(changeRequest) {
  return requestUrl(changeRequest, 'datasteward');
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
    // The composed name, because a pending create has none: S/4 derives BusinessPartnerFullName and
    // staging has no column for it, so the workflow was being handed a blank where the partner's name
    // should be. Composed onto the workflow row ONLY - see srv/partner-name.js for why it must never
    // reach the staged payload. A change request over an existing partner keeps S/4's own value.
    A_BusinessPartner: withFullName(withBusinessPartner(general)),
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

    // Not awaited, for the same reason checkMetadataDrift is not: this must never delay or fail
    // boot. It fills the four customizing caches the check pipeline reads and keeps them filled, so
    // the ~4.5s cold bootstrap a `checkRequest` used to charge the first requester after any pause
    // is paid here instead. See warmup.js for the measurement it was built from.
    startWarmup();

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
      // SBPA now resolves BTP role collection membership itself (confirmed with Arthur,
      // 2026-08-31), so a `role` entry (e.g. "Approver Customer", picked from the Workflow Agent
      // Determination cell) is sent as its bare name again, not expanded here into member e-mails -
      // reverting the 2026-08-27 fix now that the side that needed the expansion no longer does. A
      // `user` entry is already an e-mail and travels unchanged either way. `kind` stays implicit on
      // both sides of the wire, derivable from the `@` the same way it always was.
      const approverValues = [...new Set(approvers.map((approver) => approver.value))];
      // `criticalField` is a scalar 'X'/' ' input parameter on Arthur's side, not a list - so this
      // asks one question, not one per entity: does THIS request fill in an entity the field property
      // profiles mark critical? 'X' when at least one does, ' ' otherwise (including when nothing is
      // marked critical at all, or the profile table cannot be read). It is a marker only - CAP itself
      // blocks or warns on nothing here; see "Critical fields" for why an empty critical entity is not
      // an error. Best-effort like `approvers`, off the same requester context every other submit-time
      // field-property read uses.
      let criticalField = ' ';
      try {
        const resolved = await resolvedProperties(requesterContext(req));
        const critical = resolved.criticalEntities || [];
        if (critical.some((section) => sectionRows(payload, section).length > 0)) criticalField = 'X';
      } catch (error) {
        console.error(`Could not resolve the critical fields for change request ${changeRequest}:`, error);
      }
      // The names of every BTP role collection carrying this app's own DataSteward role template -
      // not resolved to member e-mails (reverted 2026-08-31, same conversation with Arthur as
      // `approvers` above: SBPA resolves BTP role collection membership itself now). Read straight
      // from the subaccount's role collections, not through the WorkflowRules table, unlike
      // `approvers`. `dataStewardRoles` is already best-effort (see srv/wf/data-stewards.js): never
      // throws, resolves to `[]` when nothing matches or the subaccount API is unreachable.
      const datastewards = await dataStewardRoles();

      return {
        changerequestid: changeRequest,
        requesttype: req.data.RequestType,
        businesspartner: req.data.BusinessPartner || '',
        emailadressinitiator: requestingUserEmail(req),
        bpurl: approveUrl(changeRequest),
        // Where the requester goes if rejected. Sent now because SPA owns the rejection branch.
        reworkurl: reworkUrl(changeRequest),
        // Where a data steward goes to enrich this request, if a future step of the process routes
        // there. Sent unconditionally like reworkurl/bpurl - CAP builds every deep link it can name
        // up front rather than only the ones the current process definition happens to use.
        datastewardurl: dataStewardUrl(changeRequest),
        // The task UI cannot discover its own OData path; this is the only call it can make unaided.
        prefix: uiPathPrefix(),
        businesspartnerinput: businessPartnerInput,
        // One entry per matched partner, so the approver sees what was flagged and why. Empty when
        // nothing matched, never absent - SPA can then bind it without a null check.
        bpduplicates: duplicateSummary(findings),
        // Flattened to plain strings, because the deployed process declares `approvers` as an array
        // of strings and the runtime validates against that: sending `{ step, kind, value }` fails
        // the whole submit with "/approvers/0 The value must be of string type, but actual type is
        // object", which is every create refused over a routing hint.
        //
        // A role entry travels as its bare name (e.g. "Approver Customer") again, not expanded into
        // member e-mails - reverted 2026-08-31 now that SBPA resolves BTP role collection membership
        // itself; see "A role entry is resolved to real e-mails before it crosses the wire" in
        // CLAUDE.md for why the expansion existed and was later undone. What is still lost either
        // way is `step`: two steps' approvers arrive as one flat list. Restoring it means declaring
        // `approvers` as an array of objects in the process context, after which the flattening
        // comes off again - resolveApprovers itself still returns the structured list.
        approvers: approverValues,
        // 'X' when a critical entity was filled in on this request, ' ' otherwise - a scalar flag,
        // not a list, because that is what the process input expects (see the comment above).
        // Lowercase on the wire, like every other key in this context - the local variable keeps
        // its camelCase name for readability, only the JSON key changes.
        criticalfield: criticalField,
        // Array of strings, like `approvers` - the same lesson applies: the deployed process
        // validates the shape it was given, and an array of objects is not what an array-of-strings
        // input accepts. Never absent, empty when nobody carries the role or the subaccount API
        // could not be read, so SPA can bind it without a null check.
        datastewards
      };
    };

    /**
     * Who is responsible for the request right now, for the strip at the top of the screen. The
     * approvers come from the same `WorkflowRules` table `workflowContext` sends, resolved against
     * the payload as it stands - so it is what CAP told the workflow, not who the workflow assigned
     * the task to. Only read while a request is in approval; see srv/request-processors.js.
     *
     * Best-effort, like every other read of that table: a screen must still open if it fails.
     */
    const processorsFor = async (header, payload) => {
      let approvers = [];
      if (header.status === 'inApproval') {
        try {
          approvers = await approversFor({
            requestType: header.requestType,
            payload: { root: payload.root || {}, sections: payload.sections || {} }
          });
        } catch (error) {
          console.warn(`[processors] Could not resolve the approvers of ${header.ID}:`, error.message);
        }
      }
      let dataStewards = [];
      if (header.status === 'checkAndEnrich') {
        try {
          dataStewards = await dataStewardEmails();
        } catch (error) {
          console.warn(`[processors] Could not resolve the data stewards of ${header.ID}:`, error.message);
        }
      }
      return currentProcessors(header, approvers, dataStewards);
    };

    /**
     * The duplicate findings still standing on a request, so the approver sees what the requester was
     * warned about. They were written at submit and never read back: the approve screen built its
     * panel only from a check it ran itself, which it does not, so the panel was empty on every task.
     *
     * `duplicate_check` only - CheckFindings also holds the validation and registry findings, which
     * are a different report - and the same `isStale` filter the exposed view applies, or a resubmit's
     * superseded verdicts come back alongside the current ones and one pair reads as several.
     */
    const currentDuplicateFindings = async (changeRequest) => {
      try {
        return await db.run(
          cds.ql.SELECT.from(FINDINGS)
            .where`request_ID = ${changeRequest} and checkName = 'duplicate_check'
                   and (isStale is null or isStale = false)`
            .orderBy({ score: 'desc' })
        );
      } catch (error) {
        // Best-effort like the rest of this screen's extras: no panel beats no request.
        console.warn(`[findings] Could not read the findings of ${changeRequest}:`, error.message);
        return [];
      }
    };

    /** Everything the request was submitted with EXCEPT the duplicates, which have their own panel. */
    const currentValidationFindings = async (changeRequest) => {
      try {
        return await db.run(
          cds.ql.SELECT.from(FINDINGS)
            .where`request_ID = ${changeRequest} and checkName != 'duplicate_check'
                   and (isStale is null or isStale = false)`
        );
      } catch (error) {
        console.warn(`[findings] Could not read the validations of ${changeRequest}:`, error.message);
        return [];
      }
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

    /**
     * The validations a submit passed WITH warnings - a VAT number VIES could not confirm, a
     * register name that disagrees with the one typed, a configured rule set to `warning`. They were
     * returned to the requester and then dropped on the floor: `CheckFindings` only ever held
     * `duplicate_check` rows, so an approver judged a request without the findings it was submitted
     * with. Nothing blocking can be here by construction - a blocking validation leaves the request
     * a draft and this is only reached once that gate has passed.
     *
     * Superseded rather than deleted on a resubmit, the same way the duplicates are, so an earlier
     * verdict stays auditable. Best-effort: a request that reached the workflow must not be undone
     * because its findings could not be written.
     */
    const recordValidationFindings = async (changeRequest, validations) => {
      try {
        await db.run(cds.ql.UPDATE(FINDINGS)
          .set({ isStale: true })
          .where`request_ID = ${changeRequest} and checkName != 'duplicate_check'`);
        const rows = (validations || []).filter((finding) => finding && finding.message);
        if (!rows.length) return;
        await db.run(cds.ql.INSERT.into(FINDINGS).entries(rows.map((finding) => ({
          ID: cds.utils.uuid(),
          request_ID: changeRequest,
          // A validation stage names itself; a row with no name would be unfilterable afterwards.
          ...stagedFinding({ checkName: 'validation', ...finding })
        }))));
      } catch (error) {
        console.warn(`[findings] Could not record the validations of ${changeRequest}:`, error.message);
      }
    };

    // CVI's business-partner-to-customer/vendor assignment, asked at submit rather than while
    // posting. See srv/checks/relation-checks.js for why that timing is the whole point.
    const relationStages = (businessPartner) => createRelationStages({
      relationFields: RELATION_FIELDS,
      roleNodes: ROLE_NODES,
      businessPartner: businessPartner || null,
      resolve: async (relationField, partner) => {
        const s4 = await cds.connect.to('API_BUSINESS_PARTNER');
        return readRelationNumber(s4, partner, relationField);
      }
    });

    // Both buttons, one pipeline: each runs only the stages its answer needs, and neither stages
    // anything. Derivations run for both — a rule needs them even when the screen never shows them.
    const runRequestChecks = async (req, {
      propose, duplicates, scope = null, standard = false, stewardStep: forceStewardStep = false
    }) => {
      const data = parseJsonObject(req.data.DataJson, 'DataJson');
      // Created per request: the pair shares one VIES/GLEIF lookup between the validation and the
      // derivation, and must not carry it over to the next press of the button.
      const registry = createRegistryStages();
      // These three are independent of each other and are started together. Two are 60s-cached, so
      // the steady-state gain is small; `resolveEffectiveRole` is the one that reaches BTP, and it
      // is what this stops sitting behind the other two. `renderResolved` below still has to wait
      // for `renderRole` - that one IS a dependency.
      //
      //
      // `properties` runs on the requester - who is pressing the button, always. A role the client
      // could name would be one it could also name its way out of - see `requesterProperties`.
      //
      // `stepHeader` (just the two columns `resolveEffectiveRole` needs) is a fourth independent
      // read, local to Postgres and cheap - fetched here rather than inside `resolveEffectiveRole`
      // so that function stays a plain, DB-free helper the caller feeds. `renderRole` still has to
      // wait for it, the same dependency `renderResolved` below has on `renderRole` itself.
      const [configured, properties, stepHeader] = await Promise.all([
        configuredStages(),
        fieldPropertyStages(requesterContext(req)),
        req.data.ChangeRequest
          ? db.run(cds.ql.SELECT.one.from(HEADER)
            .columns('approvalsReceived', 'approverSequenceJson')
            .where({ ID: req.data.ChangeRequest }))
          : null
      ]);
      // The SCREEN's own role, separate from `properties` above: gating what a derivation may
      // propose is not the security boundary the mandatory-field check is, so the caller's own Role
      // is trusted here - narrowed to their specific BTP role the same way effectiveFieldProperties
      // narrows it, so "Approver Customer" is gated by its own profile rather than by every
      // "Approver" profile in the table. Nothing sent -> role stays null -> only `*` profiles apply.
      const renderRole = await resolveEffectiveRole(req, req.data.Role || null, stepHeader);
      // The screen the button was pressed on, before that narrowing: the SAP standard checks run on
      // the data steward step alone, so a specific "DataSteward Customer" must gate them too.
      //
      // `forceStewardStep` is the SERVER saying so instead of the screen: decideDataStewardReview
      // knows it is the data steward step from the request's own status, and a gate that asked the
      // client whether to gate would be no gate at all. `req.data.Role` stays the trust level it
      // always was - a rendering hint that can only ever ADD this cost to its own press.
      const stewardStep = forceStewardStep || String(req.data.Role || '').startsWith(DATASTEWARD_ROLE);
      const renderResolved = await resolvedProperties({
        requestType: req.data.RequestType || null,
        role: renderRole
      });
      const fieldEditable = (target, field) => fieldState(renderResolved, target, field).editable;
      return runChecks(
        { root: data.root || {}, sections: data.sections || {} },
        {
          fieldEditable,
          // CVI before the registry: its configuration is cached for 60s, so it is effectively
          // offline after the first read, and a role this partner's category cannot carry is worth
          // saying before spending a VIES call on an address that will never synchronise anyway.
          validations: [...properties.validations, ...configured.validations, ...nodeRequiredStages.validations,
            ...createCviStages().validations, ...registry.validations,
            ...relationStages(req.data.BusinessPartner || data.root?.BusinessPartner).validations],
          // The CVI derivation last: an explicit rule and a registry lookup should both win over
          // it, and the pipeline never overwrites what an earlier derivation already wrote.
          // A second createCviStages() call is not a second read: the 60s cache lives in the
          // module, not in the object, so this derivation and the validation above judge the same
          // configuration.
          // The SPRO derivations go LAST, after CVI. Same reasoning that puts the configured rules
          // first: the pipeline never overwrites, so a steward's explicit rule and a register
          // lookup both outrank a country default. A country's address language is the weakest
          // claim on that field of anything here.
          derivations: [...configured.derivations, ...registry.derivations,
            ...createCviStages().derivations, ...createDerivationStages().derivations],
          // Check is where a human is looking, which is the only place a proposal to rewrite
          // what someone typed makes sense. The register never proposes: it validates and derives.
          propose: propose
            ? async (derived) => proposeNormalisations({
              payload: derived,
              scope: scope || null,
              aiEnabled: await aiAssistanceEnabled(),
              // Same predicate as the derivations above: a normalisation rewrites a value too, so a
              // field the caller's role cannot touch (hidden or read-only) gets no proposal either.
              fieldEditable
            })
            : undefined,
          // Only where a human is looking, only for the whole record, and only on the DATA STEWARD
          // step (2026-09-01, asked for): a requester's Check and Submit no longer pay for them. A
          // scoped call must not pay for a remote round trip either, and the submit path has its own
          // stage list. Roles and relations ARE sent, so the customer and vendor tiers run and each
          // press costs a vendor number -- see INCLUDE_ROLES in bp-check.js.
          checkStandard: standard && !scope && stewardStep
            ? createBpCheckStage({ requestId: req.data.ChangeRequest || null })
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
     * The validation half of "the check", shared by submitRequest, resubmitRequest and decideRequest's
     * approve path so the three cannot drift on what a submit actually gates on - they used to carry
     * three copies of this exact stage list. Derivations deliberately never run here: they change the
     * data, and only a requester who pressed Check has actually seen what they are asking for. Approve
     * has nobody left to show a proposal to even if it ran them, which is the same reasoning taken one
     * step further - see CLAUDE.md, "Derivations/Proposals... geblocked... in Approval stap".
     */
    /**
     * The `{ root, sections }` shape the pipeline reads, reconstructed from what is actually
     * persisted for a change request - shared by getRequestPayload and decideRequest's approve gate
     * (below) so the two read staging exactly the same way. `deleted` rows are left out: neither
     * caller validates a row on its way out.
     */
    const loadStagedPayload = async (changeRequest) => {
      const general = await db.run(
        cds.ql.SELECT.one.from(GENERAL).where({ request_ID: changeRequest })
      );
      const sections = {};
      for (const [section, config] of Object.entries(NODES)) {
        const rows = await db.run(
          cds.ql.SELECT.from(config.entity).where({ request_ID: changeRequest })
        );
        const clean = rows
          .filter((row) => row.action !== 'D')
          .map((row) => {
            const { ID, request_ID, action, ...rest } = row;
            return { ...rest, ...stateOfAction(action) };
          });
        // Always an array, even for a !config.many section (Customers/Suppliers) - the same shape
        // _loadStagedRequest always normalises a section into on the client before it is ever fed
        // to a check. getRequestPayload's own bare-object-or-null for a to-one node is fine because
        // the client re-wraps it; this reader feeds runSubmitValidations directly, with no client in
        // between to do that - and relation-checks.js's own loop, unlike sectionRows, requires an
        // array and silently skips anything else. Without this, an approve-time validation of a
        // Suppliers/Customers row could not see it at all (fixed 2026-08-31, reported live:
        // "SupplierPurchasingOrg needs a Supplier record" on a request that plainly had one).
        sections[section] = clean;
      }
      const { ID, request_ID, ...root } = general || {};
      return { root, sections };
    };

    const runSubmitValidations = async (req, payload) => {
      const registry = createRegistryStages();
      const configured = await configuredStages();
      const properties = await fieldPropertyStages(requesterContext(req));
      return runValidations(
        payload,
        [...properties.validations, ...configured.validations, ...nodeRequiredStages.validations,
        ...createCviStages().validations, ...registry.validations,
        ...relationStages(req.data.BusinessPartner || payload.root?.BusinessPartner).validations]
      );
    };

    /**
     * What the screen has to show, hide, freeze and star, for one request type and one role. Purely
     * a rendering answer: the gate is `field_properties` in the validation list, which runs on the
     * requester's own context whatever a screen was told.
     */
    this.on('effectiveFieldProperties', async (req) => {
      // Approver/DataSteward is narrowed to the CURRENT user's own specific BTP role first (e.g.
      // "Approver Customer"), so a profile scoped to that specific function actually applies only to
      // people who carry it - see resolveEffectiveRole above. Tried first, inside that: whether THIS
      // request's own stored approver sequence names this exact user for its current step.
      const stepHeader = req.data.ChangeRequest
        ? await db.run(cds.ql.SELECT.one.from(HEADER)
          .columns('approvalsReceived', 'approverSequenceJson')
          .where({ ID: req.data.ChangeRequest }))
        : null;
      const role = await resolveEffectiveRole(req, req.data.Role || null, stepHeader);
      const resolved = await resolvedProperties({
        requestType: req.data.RequestType || null,
        role
      });
      return JSON.stringify(resolved);
    });

    this.on('checkRequest', async (req) => {
      const result = await runRequestChecks(req, {
        propose: req.data.Propose !== false,
        duplicates: false,
        scope: req.data.Scope || null,
        standard: true
      });
      // The standard findings travel SEPARATELY here (2026-08-28), so the screen can hold them
      // back while the proposals dialog is open: a city the derivations are offering to fill must
      // not be reported as missing at the same time. Filtered by identity rather than re-derived --
      // `runChecks` merges the same objects into `validations`, so this cannot drift from it.
      const isStandard = new Set(result.standard);
      return {
        Valid: result.valid,
        ValidationsJson: JSON.stringify(result.validations.filter((entry) => !isStandard.has(entry))),
        StandardJson: JSON.stringify(result.standard),
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
      const validations = await runSubmitValidations(
        req, { root: data.root || {}, sections: data.sections || {} }
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

      // After the gate, so nothing blocking is ever stored - and before the duplicate check, so an
      // outage in that check cannot cost the warnings this submit already produced.
      await recordValidationFindings(changeRequest, validations);

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
        submittedBy: requestingUserEmail(req),
        // The "before" a data steward's or a reworking requester's changes get judged against, for
        // the ENTIRE remaining lifetime of this request - see baselineDataJson in db/staging.cds.
        // Nothing later ever resets it (not resubmitRequest, not decideDataStewardReview's own
        // complete branch), so this is the only write it ever gets. A first submit's baseline is
        // trivially its own data, which is exactly why nothing is highlighted on a brand new create
        // until someone edits it.
        baselineDataJson: req.data.DataJson,
        // The count decideRequest gates posting on - same array BPA gets as `approvers` in this
        // same context, so CAP's idea of "how many" never disagrees with what actually got routed.
        requiredApprovals: context.approvers.length,
        approvalsReceived: 0,
        // Who is assigned to which level, in order - see resolveEffectiveRole and db/staging.cds.
        approverSequenceJson: JSON.stringify(context.approvers)
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

      // The same gates as a submit, in the same order (shared via runSubmitValidations). Derivations
      // still do not run here.
      const data = parseJsonObject(req.data.DataJson, 'DataJson');
      const validations = await runSubmitValidations(
        req, { root: data.root || {}, sections: data.sections || {} }
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

      // After the gate, so nothing blocking is ever stored - and before the duplicate check, so an
      // outage in that check cannot cost the warnings this submit already produced.
      await recordValidationFindings(changeRequest, validations);

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

      // Best-effort, like `withdrawRequest`'s own callback (2026-08-24) - it used to block the whole
      // resubmit on this succeeding, which meant a rejected request stayed stuck at `reworkRequired`
      // whenever the parked instance was not (yet, or ever) actually waiting on this exact message.
      // The rework task itself completing - the PATCH to task-instances that _completeEmbeddedOutcome
      // sends once this action returns - is what resumes the process now; this signal is a second,
      // optional path for a process that still listens for it, not the one CAP depends on.
      try {
        // The requester's own trigger, not the approver's. Context goes flat inside `inputs` next to
        // `result`; `executionId` is the parked process instance, which Arthur calls the CR id.
        await triggerRequesterCallback(before.processInstanceId, RESUBMITTED_SIGNAL, context);
      } catch (error) {
        console.error(`Could not signal the approval process that ${changeRequest} was resubmitted:`, error);
      }

      // baselineDataJson is deliberately NOT touched here (reversed 2026-08-27, having shipped
      // resetting it the same day) - see db/staging.cds. It was reset on the reasoning that a resubmit
      // starts a fresh round, so whoever reviews it next should see only what changed since then - but
      // that is backwards from what was actually asked for: the requester's OWN rework edits are
      // exactly what the next reviewer (an approver, or a data steward again) is meant to see
      // highlighted, the same way a data steward's edits already stay visible through to the approver.
      // Leaving it alone means the baseline set at the very first successful submitRequest is what a
      // create request compares against for its ENTIRE lifetime, however many rework rounds it takes.
      await db.run(cds.ql.UPDATE(HEADER).set({
        status: 'inApproval',
        // Overwritten on purpose: the resubmit is the submission that matters now, and the original
        // timestamp is of no use to anyone once the request has been round the loop.
        submittedAt: new Date().toISOString(),
        submittedBy: requestingUserEmail(req),
        // A fresh approval cycle: the reworked payload can change WHO approves (a different country,
        // a different role match), so the count is rebuilt from this resubmit's own context, same as
        // submitRequest, and the counter starts over.
        requiredApprovals: context.approvers.length,
        approvalsReceived: 0,
        approverSequenceJson: JSON.stringify(context.approvers)
      }).where({ ID: changeRequest }));
      await appendComment(db, changeRequest, 'Requester', requestingUserEmail(req), req.data.Reason);

      return {
        ChangeRequest: changeRequest,
        Status: 'inApproval',
        ProcessInstanceId: before.processInstanceId,
        NeedsConfirmation: false,
        Valid: true,
        ValidationsJson: JSON.stringify(validations),
        MessagesJson: JSON.stringify(findings),
        // The reworked businesspartnerinput, so the requester's rework task can carry it back to
        // BPA as an output on completion instead of only through the signal above - see
        // _completeEmbeddedOutcome in the shared controller and sap.bpa.task.outputs in app/bptask.
        ContextJson: JSON.stringify(context)
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

    // A data steward's own loop, parallel to rework rather than a step inside it - see
    // ChangeRequestStatus's `checkAndEnrich` in db/staging.cds for why it is its own status. Placed
    // after withdrawRequest rather than beside claimRework, so the resubmit->withdraw span other
    // tests slice stays exactly what it already pinned.

    // The same shortcut as claimRework, for the data steward step instead: nothing on Arthur's side
    // calls this yet, so opening the data steward screen is what moves the status - the process
    // routing a task here is taken as the evidence, the same way arriving on the rework screen is.
    this.on('claimDataStewardReview', async (req) => {
      const changeRequest = req.data.ChangeRequest;
      const header = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest }));
      if (!header) return req.reject(404, `Change request ${changeRequest} was not found.`);

      // A posted request has a business partner behind it, whatever its status says.
      if (header.postedBP || header.status !== 'inApproval') {
        return { ChangeRequest: changeRequest, Status: header.status, Claimed: false };
      }

      // No workflow signal: the process is the one routing the task here, and a status this screen
      // sets to catch up is not a decision it is waiting for.
      await db.run(cds.ql.UPDATE(HEADER).set({ status: 'checkAndEnrich' }).where({ ID: changeRequest }));
      return { ChangeRequest: changeRequest, Status: 'checkAndEnrich', Claimed: true };
    });

    /**
     * The data steward's decision, from `checkAndEnrich`. `complete` is resubmitRequest's own shape -
     * persist, the same gates, rebuild the context, hand the SAME parked instance back to `inApproval`
     * - because a steward enriching data is a rework of the payload, just under a status of its own.
     * `reject` is decideRequest's reject branch instead: no payload to persist, straight to
     * `reworkRequired`, because the steward could not make the request work and it goes back to
     * whoever raised it, not back to the approver.
     */
    this.on('decideDataStewardReview', async (req) => {
      const changeRequest = req.data.ChangeRequest;
      const decision = String(req.data.Decision || '').toLowerCase();
      if (!['complete', 'reject'].includes(decision)) {
        return req.reject(400, "Decision must be 'complete' or 'reject'.", 'Decision');
      }

      const before = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequest }));
      if (!before) return req.reject(404, `Change request ${changeRequest} was not found.`);
      if (before.status !== 'checkAndEnrich') {
        return req.reject(409,
          `Change request ${changeRequest} is ${before.status}, not awaiting data steward review.`);
      }

      if (decision === 'reject') {
        await db.run(cds.ql.UPDATE(HEADER).set({
          status: 'reworkRequired',
          rejectionComment: req.data.Reason || null
        }).where({ ID: changeRequest }));
        await appendComment(db, changeRequest, 'DataSteward', requestingUserEmail(req), req.data.Reason);
        if (before.processInstanceId) {
          try {
            await triggerRequesterCallback(before.processInstanceId, DATASTEWARD_REJECTED_SIGNAL, {
              changerequestid: changeRequest
            });
          } catch (error) {
            console.error(`Could not signal that data steward review of ${changeRequest} was rejected:`, error);
          }
        }
        return {
          ChangeRequest: changeRequest,
          Status: 'reworkRequired',
          ProcessInstanceId: before.processInstanceId,
          NeedsConfirmation: false,
          Valid: true,
          ValidationsJson: JSON.stringify([]),
          MessagesJson: JSON.stringify([]),
          ContextJson: null
        };
      }

      // decision === 'complete', resubmitRequest's own body from here down.
      if (!before.processInstanceId) {
        return req.reject(409,
          `Change request ${changeRequest} has no approval process to hand back to, so it cannot be`
          + ' completed. Reject it, or withdraw it and raise a new request.');
      }

      const changeRequestId = await persist(req);
      if (!changeRequestId) return;

      const data = parseJsonObject(req.data.DataJson, 'DataJson');
      const validations = await runSubmitValidations(
        req, { root: data.root || {}, sections: data.sections || {} }
      );
      if (validations.some((message) => message.severity === BLOCKING)) {
        return {
          ChangeRequest: changeRequestId,
          Status: 'checkAndEnrich',
          NeedsConfirmation: false,
          Valid: false,
          ValidationsJson: JSON.stringify(validations),
          MessagesJson: JSON.stringify([])
        };
      }

      // S/4's own verdict is the other half of what this step is for, and an ERROR from it must stop
      // the request HERE rather than travel on to an approver (asked for 2026-09-03, after two live
      // requests were approved and then refused at the post: a partner role that already existed,
      // and a missing standard address). The screen's `_standardBlocks` is the courtesy version of
      // this; a direct service call walks straight past it, which is why the gate is here too.
      //
      // Through `runRequestChecks`, not `createBpCheckStage` directly, because the standard checks
      // must see `systemDerived` - typed values plus the `cvi_account_group` system derivation that
      // CREATES the Customers/Suppliers node. Handed the raw staged payload they would send no
      // relation node at all and the customer and vendor tiers would silently examine nothing,
      // which is the one answer this whole step exists to avoid. `stewardStep: true` because the
      // server knows what step this is from the request's own status.
      //
      // Wrapped, because this gate must never be able to 500 the action. It did (reported live
      // 2026-09-03): a steward pressing Complete Review got "internal server error" AND lost the
      // findings off the screen - no verdict and no data, which is worse than either alone. A check
      // that could not RUN is not a check that failed: it is logged and stepped over, because
      // blocking a completion on an unreachable S/4 leaves a steward nothing to fix and no way past.
      let stewardStandard = [];
      try {
        const stewardCheck = await runRequestChecks(req, {
          propose: false, duplicates: false, standard: true, stewardStep: true
        });
        stewardStandard = stewardCheck.standard || [];
      } catch (error) {
        console.error(
          `[steward-gate] The SAP standard checks could not run for ${changeRequestId}:`, error
        );
      }
      const blockingStandard = stewardStandard.filter((finding) => finding.severity === BLOCKING);
      if (blockingStandard.length) {
        return {
          ChangeRequest: changeRequestId,
          Status: 'checkAndEnrich',
          NeedsConfirmation: false,
          Valid: false,
          // The instruction leads, then what to fix. The screen renders these as strips in the order
          // they arrive and they stay up until the next action, so an unresolved error is still on
          // screen when the steward looks back at the form - which is the whole point of returning
          // them rather than throwing.
          ValidationsJson: JSON.stringify([
            {
              check: 'sap_standard_checks',
              severity: BLOCKING,
              message: 'Resolve the errors below before submitting this request.'
            },
            ...validations,
            ...blockingStandard
          ]),
          MessagesJson: JSON.stringify([])
        };
      }

      await recordValidationFindings(changeRequestId, validations);

      const findings = await recordDuplicateFindings(changeRequestId, req.data.BusinessPartner);
      const duplicates = findings.filter((finding) => finding.verdict);
      if (duplicates.length && !req.data.Confirm) {
        return {
          ChangeRequest: changeRequestId,
          Status: 'checkAndEnrich',
          NeedsConfirmation: true,
          Valid: true,
          ValidationsJson: JSON.stringify(validations),
          MessagesJson: JSON.stringify(findings)
        };
      }

      const header = await db.run(cds.ql.SELECT.one.from(HEADER).where({ ID: changeRequestId }));
      const context = await workflowContext(req, changeRequestId, header, findings);

      // Best-effort, like resubmitRequest's own signal - the data steward task itself completing is
      // what resumes the process, this is a second, optional path for a process that listens for it.
      try {
        await triggerRequesterCallback(before.processInstanceId, DATASTEWARD_COMPLETE_SIGNAL, context);
      } catch (error) {
        console.error(`Could not signal that data steward review of ${changeRequestId} was completed:`, error);
      }

      // baselineDataJson is deliberately NOT touched here - nor is it anywhere past the very first
      // submitRequest any more (resubmitRequest included, reversed 2026-08-27) - so the approver
      // receiving it next is meant to see the data steward's own edits highlighted too, on top of
      // whatever the requester changed getting here - see "Highlighting what changed" in CLAUDE.md.
      await db.run(cds.ql.UPDATE(HEADER).set({
        status: 'inApproval',
        submittedAt: new Date().toISOString(),
        submittedBy: requestingUserEmail(req),
        // Same reasoning as resubmitRequest: a fresh approval cycle, rebuilt from this completed
        // review's own context, counter reset.
        requiredApprovals: context.approvers.length,
        approvalsReceived: 0,
        approverSequenceJson: JSON.stringify(context.approvers)
      }).where({ ID: changeRequestId }));
      await appendComment(db, changeRequestId, 'DataSteward', requestingUserEmail(req), req.data.Reason);

      return {
        ChangeRequest: changeRequestId,
        Status: 'inApproval',
        ProcessInstanceId: before.processInstanceId,
        NeedsConfirmation: false,
        Valid: true,
        ValidationsJson: JSON.stringify(validations),
        MessagesJson: JSON.stringify(findings),
        ContextJson: JSON.stringify(context)
      };
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
      // 31 sequential SELECTs, one per staged node, on every screen open - and MEASURED, not
      // guessed: 25-28ms for the whole loop, no section above 2ms (2026-09-03, on the dev BTP
      // Postgres with real requests). That is round-trip latency spread evenly, not a missing
      // index, and it is too little of it to be worth reading the sections in one composition
      // expand. Leave the loop alone unless a section count or a row count changes the shape.
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

      const comments = await db.run(
        cds.ql.SELECT.from(COMMENTS).where({ request_ID: changeRequest }).orderBy('createdAt')
      );

      return {
        ChangeRequest: header.ID,
        RequestType: header.requestType,
        Status: header.status,
        BusinessPartner: header.businessPartner,
        Reason: header.reason,
        RejectionComment: header.rejectionComment,
        PostError: header.postError,
        SubmittedBy: header.submittedBy,
        SubmittedAt: header.submittedAt,
        ProcessorsJson: JSON.stringify(await processorsFor(header, { root, sections })),
        FindingsJson: JSON.stringify(await currentDuplicateFindings(changeRequest)),
        ValidationsJson: JSON.stringify(await currentValidationFindings(changeRequest)),
        CommentsJson: JSON.stringify(comments.map((comment) => ({
          role: comment.role,
          author: comment.author,
          text: comment.text,
          createdAt: comment.createdAt
        }))),
        DataJson: JSON.stringify({ root, sections, deleted }),
        BaselineDataJson: header.baselineDataJson || null
      };
    });

    // Replayed through BusinessPartnerService, which owns the S/4 connection and payload sanitizing.
    const postToS4 = async (req, header) => {
      const bp = await cds.connect.to('BusinessPartnerService');
      // A create that already carries a number is a retry over a partial post, not a create. Since
      // a failed post sends the request back to `reworkRequired` (2026-08-25) that retry is a
      // normal path, and without this a resubmit would make a second business partner.
      const isCreate = header.requestType === 'create' && !header.businessPartner;

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

      // Persisted before the child nodes run, because they can still throw. The number is the only
      // thing that makes the retry above possible, and it exists in S/4 whether the rest succeeds
      // or not -- losing it here is what would turn one failed post into two business partners.
      if (!header.businessPartner) {
        await db.run(cds.ql.UPDATE(HEADER).set({ businessPartner }).where({ ID: header.ID }));
        header.businessPartner = businessPartner;
      }

      // Lazily, once per relation field: an earlier node in this run may have just created the record.
      const resolvedRelations = {};
      // Lazily, once per self-determined section: what S/4's own determination procedure already
      // put there. See SELF_DETERMINED_NODES.
      const determinedRows = {};
      // Whether THIS run created the partner, captured before the loop shadows `isCreate`. It is
      // what decides whether waiting for a customer/vendor record can possibly help - see
      // awaitRelationNumber. A retry's partner has existed for minutes.
      const createdRootNow = isCreate;

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
            // Waited for, not read once: CVI creates the customer/vendor in postprocessing, after
            // the root create has already returned. A single attempt outside that window, because
            // there is nothing to wait for then. See awaitRelationNumber.
            resolvedRelations[relationField] = await awaitRelationNumber(
              s4, businessPartner, relationField,
              { attempts: createdRootNow ? RELATION_WAIT_ATTEMPTS : 1 }
            );
          }
          const relationValue = resolvedRelations[relationField];

          // Customers and Suppliers ARE the record the relation field names - the others hang
          // off it. So a missing number means different things: for a child there is nothing to
          // hang it on and posting it would be wrong, but for the role node itself it simply
          // does not exist yet, which is something to create.
          const isRoleNode = ROLE_NODES.has(section);
          if (relationValue == null && !isRoleNode) {
            throw new Error(
              `Cannot post ${section}: Business Partner ${businessPartner} has no ${relationField} record yet.`
            );
          }
          if (relationValue != null) data[relationField] = relationValue;
          // What a create of the role node addresses its parent by: to_Customer hangs off
          // A_BusinessPartner, not off A_Customer. Dropped again by sanitizeEntityPayload for
          // every node whose entity has no such element.
          if (isRoleNode) data.BusinessPartner = businessPartner;

          if (action === 'D') {
            await bp.send('deleteBusinessPartnerEntity', {
              Entity: section,
              KeyJson: JSON.stringify(data)
            });
            // Gone from S/4, so a retry over a LATER node's failure must not try to delete it a
            // second time (a 404-shaped refusal, same class of bug as the create one below) - the
            // row is removed here rather than left behind with nothing left to represent.
            await db.run(cds.ql.DELETE.from(config.entity).where({ ID }));
            continue;
          }

          // The same question for a row S/4 determines itself: SP/BP/PY/SH exist as soon as the
          // sales area does, so a staged 'C' is a create of something already there. Read once per
          // section, matched on the natural key, and the counter S/4 assigned is merged in - an
          // update cannot address the row without it.
          const selfDetermined = SELF_DETERMINED_NODES[section];
          let determined = null;
          if (selfDetermined) {
            if (!(section in determinedRows)) {
              determinedRows[section] = await determinedRowsFor(s4, selfDetermined, relationValue);
            }
            determined = matchDeterminedRow(determinedRows[section], selfDetermined, data);
            if (determined) data[selfDetermined.assignedKey] = determined[selfDetermined.assignedKey];
          }

          // Whether the record is already there decides this for the role node, not what the
          // requester did on screen: with CVI configured, adding the role is what creates the
          // customer, so by the time this runs S/4 already has one and a POST would be refused.
          // Without CVI nothing else creates it, and the same line still posts. Every other node
          // follows the staged action, which is the only thing that knows about it - unless S/4
          // determined the row itself, which only a read can know and which outranks the action.
          const isCreate = isRoleNode
            ? relationValue == null
            : (determined ? false : action !== 'U');

          const sendRow = (create) => bp.send('saveBusinessPartnerEntity', {
            Entity: section,
            IsCreate: create,
            // The keys travel in `data` - the relation field plus whatever the row staged. Sent
            // empty until now, so every update failed on "Missing key field(s)" rather than
            // updating anything; the delete path has always passed them.
            KeyJson: JSON.stringify(data),
            DataJson: JSON.stringify(data)
          });

          try {
            await sendRow(isCreate);
          } catch (error) {
            // Second chance for a self-determined node, and only for a CREATE that failed. The
            // read above can legitimately have come back empty: S/4 runs the partner determination
            // procedure when CVI creates the sales area, asynchronously, so SP/BP/PY/SH can appear
            // between our read and our write. Re-read now - the failure itself is the evidence
            // something changed - and if the row IS there this was a duplicate, not a fault.
            //
            // Deliberately NOT matched on the message text: `Partner role SP already exists (only
            // provided once)` is one S/4 language away from unrecognisable, and "the create failed
            // and the row is now there" says the same thing without reading prose. Anything else
            // rethrows untouched, so a real failure still fails.
            if (!selfDetermined || !isCreate) throw error;
            const fresh = await determinedRowsFor(s4, selfDetermined, relationValue);
            const existing = matchDeterminedRow(fresh, selfDetermined, data);
            if (!existing) throw error;
            console.warn(
              `[post] ${section} ${data[selfDetermined.matchOn[selfDetermined.matchOn.length - 1]]}`
              + ` already existed on ${relationValue}; posting it as an update instead.`
            );
            data[selfDetermined.assignedKey] = existing[selfDetermined.assignedKey];
            await sendRow(false);
          }

          // Persisted immediately, the same reasoning as header.businessPartner above: a LATER
          // node in this same run can still throw, sending the request back to reworkRequired, and
          // a resubmitted retry must not try to CREATE a row S/4 already has. Fixed 2026-08-31,
          // reported live: "BP role FLVN01 already exists for partner" on a resubmit's approve,
          // because BusinessPartnerRoles is not a ROLE_NODE (that set is Customers/Suppliers only,
          // whose own retry-safety already comes for free from `relationValue` resolving non-null
          // once CVI has created them) - every OTHER section, roles included, decided create-vs-
          // update purely from the staged `action` column, which never learned that THIS node's
          // create had, in fact, already gone through on an earlier partial post. Flipping it to
          // 'U' here makes the next retry an update instead - the same way header.businessPartner
          // turns the whole post from create to update once it is known.
          if (isCreate) {
            await db.run(cds.ql.UPDATE(config.entity).set({ action: 'U' }).where({ ID }));
          }
        }
      }

      return businessPartner;
    };

    /**
     * How long `postAndRecord` waits before telling BPA the outcome of the S/4 post, once it is
     * known (2026-08-25). The task-instances PATCH that actually resumes the workflow past the
     * approval task is sent by the client, and only after it has received this action's response --
     * so signalling from inside the same request is always too early: no instance is waiting on
     * `waitForResult` yet, and BPA correctly answers "no matching workflow instance found for
     * message" (seen in production the same day, executionId 4d0082e2-...). Delaying narrows the
     * race, it does not close it -- a client that never sends the PATCH (tab closed, PATCH itself
     * failing) still leaves nothing to signal, however long this waits. The real fix is a process
     * definition where the receive activity for `waitForResult` is already active before the
     * decision task completes; this is a stopgap until that lands.
     */
    const SIGNAL_POST_RESULT_DELAY_MS = 30_000;

    /**
     * What the parked instance is waiting on: the outcome of the S/4 post, not the human decision.
     *
     * Best effort, and it never throws. The business partner exists in S/4 (or does not) whatever
     * this call does, and losing a created partner because a signal timed out would be the worse
     * failure of the two. `businesspartnerfullname` is composed rather than read: staging has no
     * such column -- the screen's read-only field is composed there too.
     */
    const signalPostResult = async (header, { businessPartner, errorMessage } = {}) => {
      // Said out loud rather than returned silently. A request submitted while startWorkflow
      // answered a shape `result?.id || result?.data?.id` does not recognise lands here with a null
      // instance and no process to signal -- and "nothing arrived in BPA" with nothing in the log
      // is the hardest version of that to diagnose.
      if (!header.processInstanceId) {
        console.warn(
          `Change request ${header.ID} has no processInstanceId, so the post result was not sent to BPA.`
        );
        return;
      }
      const general = await db.run(
        cds.ql.SELECT.one.from(GENERAL).where({ request_ID: header.ID })
      ) || {};
      try {
        await triggerPostResult(header.processInstanceId, {
          businesspartnerid: businessPartner || '',
          businesspartnerfullname: fullNameOf(general) || '',
          status: errorMessage ? 'error' : 'success',
          errormessage: errorMessage ? String(errorMessage).slice(0, 1000) : ''
        });
      } catch (error) {
        console.error('Could not signal the workflow with the result of the S/4 post:', error);
      }
    };

    /**
     * Create the partner and record what happened, for the approve path and for SPA's
     * completeRequest callback alike. One function because the two must not drift: they write the
     * same statuses and send the same signal.
     *
     * A failure lands the request in `reworkRequired` and is reported back in `ErrorMessage`
     * rather than as a rejected action. That is deliberate: `req.reject` throws, CAP rolls the
     * transaction back with it, and the status write would be lost -- the request would sit in
     * `approved` with nothing saying why nothing happened.
     */
    const postAndRecord = async (req, header) => {
      const changeRequest = header.ID;
      const { tenant, user } = req;
      // Detached and delayed (see SIGNAL_POST_RESULT_DELAY_MS above) rather than awaited: this
      // request's response is what triggers the client's task-instances PATCH, so waiting here
      // would push that PATCH back by the same amount and win nothing. cds.spawn re-establishes
      // tenant/user for the delayed run, since the request's own context is gone by the time it fires.
      const spawnSignal = (fn) => cds.spawn({ after: SIGNAL_POST_RESULT_DELAY_MS, tenant, user }, fn);
      try {
        const businessPartner = await postToS4(req, header);
        await db.run(cds.ql.UPDATE(HEADER).set({
          status: 'posted',
          postedBP: businessPartner,
          postedAt: new Date().toISOString(),
          postError: null
        }).where({ ID: changeRequest }));
        spawnSignal(() => signalPostResult(header, { businessPartner }));
        return {
          ChangeRequest: changeRequest, Status: 'posted', BusinessPartner: businessPartner, ErrorMessage: null
        };
      } catch (error) {
        const message = String(error.message || error);
        // postToS4 persists the number the moment the ROOT create succeeds, so a header carrying one
        // here means the partner exists in S/4 and something AFTER it failed - a child node, or a
        // customer/vendor record that had not appeared yet. Saying "could not be created" then is
        // simply false, and it is what sent a requester looking for a partner that was already
        // there, active, under the number this message never mentioned (reported live 2026-09-03).
        // The status is still reworkRequired either way: something in the request did not land and
        // a human has to finish it, and the retry path is built for exactly that.
        const created = header.businessPartner || null;
        const summary = created
          ? `Approved. Business Partner ${created} WAS created in S/4HANA, but the rest of the `
            + `request could not be posted: ${message.slice(0, 1000)}`
          : `Approved, but the Business Partner could not be created in S/4HANA: ${message.slice(0, 1000)}`;
        await db.run(cds.ql.UPDATE(HEADER).set({
          status: 'reworkRequired',
          postError: message.slice(0, 1000)
        }).where({ ID: changeRequest }));
        // Into the shared thread too, not only the header's single `postError` -- so whoever opens
        // the request next, approver or requester, sees WHAT failed rather than just THAT it did.
        // Authored as the system, never the approver: nobody rejected anything here.
        await appendComment(db, changeRequest, 'System', 'SYSTEM', summary);
        spawnSignal(() => signalPostResult(header, { errorMessage: message }));
        return {
          ChangeRequest: changeRequest,
          Status: 'reworkRequired',
          // The client branches on this to decide which of the two sentences above to show, so it
          // must stay the partner number and not be blanked out because the action "failed".
          BusinessPartner: created,
          ErrorMessage: message.slice(0, 1000)
        };
      }
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
        await appendComment(db, changeRequest, 'Approver', requestingUserEmail(req), req.data.Comment);
        await notifyWorkflow('rejected');
        return { ChangeRequest: changeRequest, Status: 'reworkRequired', BusinessPartner: null };
      }

      // "Very important" (2026-08-31, asked for directly): re-run the same validations submit and
      // resubmit already gate on, against the data exactly as it is persisted right now - the
      // configuration behind a rule (a mandatory field, a CVI account group mapping) can have changed
      // since the request was submitted, and approving is the last moment before S/4 ever sees it.
      // Nothing has been written yet at this point, so a plain reject is safe: the request stays
      // `inApproval`, the task stays open, and the approver can reject or wait for the data to be
      // fixed instead. Derivations deliberately do not run here either - see runSubmitValidations.
      const approvalPayload = await loadStagedPayload(changeRequest);
      const approvalValidations = await runSubmitValidations(req, approvalPayload);
      if (approvalValidations.some((message) => message.severity === BLOCKING)) {
        return req.reject(
          422,
          `Change request ${changeRequest} no longer passes validation and cannot be approved: `
            + approvalValidations
              .filter((message) => message.severity === BLOCKING)
              .map((message) => message.message)
              .join('; ')
        );
      }

      // CAP decides finality itself (2026-09-02, asked for) - not a client, not what BPA happens to
      // put in the task context. A multi-approver chain used to rely on `app/bptask` reading
      // `currentapprover`/`totalapprovers` off the task and only calling decideRequest on the last
      // one; that value depended on the SBPA Lobby being re-pointed at a task-form version that
      // declares the two inputs, and a reverted version meant every approver read as "the only one" -
      // see CLAUDE.md, "Several approvers, sequentially". Counting here removes that dependency
      // entirely: every approve is recorded, and only the Nth one - N counted by CAP itself - posts.
      // A request that predates `requiredApprovals` reads as needing exactly one, matching every
      // request's behaviour before this column existed.
      //
      // Accepted, not solved: two decisions for the SAME approver arriving concurrently (a genuine
      // double-click before the UI reacts) could double-count, because nothing here identifies WHO
      // is deciding, only that a decision arrived. This is the same trust level `postedBP`'s guard
      // already accepts for the final step; a human-paced sequential approval chain makes the window
      // narrow, and BPA does not hand out a second open task for an approver who already completed
      // theirs.
      const requiredApprovals = header.requiredApprovals || 1;
      const approvalsReceived = (header.approvalsReceived || 0) + 1;
      await appendComment(db, changeRequest, 'Approver', requestingUserEmail(req), req.data.Comment);

      if (approvalsReceived < requiredApprovals) {
        // Not yet - one or more approvers still owe a decision. Status stays `inApproval`, so the
        // NEXT approver's own decideRequest call still passes the status guard above, and nothing
        // reaches S/4 on the strength of this one decision alone.
        await db.run(cds.ql.UPDATE(HEADER).set({ approvalsReceived }).where({ ID: changeRequest }));
        return {
          ChangeRequest: changeRequest,
          Status: 'inApproval',
          BusinessPartner: null,
          ApprovalsReceived: approvalsReceived,
          RequiredApprovals: requiredApprovals
        };
      }

      // Approved, and posted from here (changed 2026-08-25, on Julien's ask). It used to stop at
      // `approved` and leave the S/4 write to SPA's completeRequest callback; pressing Approve now
      // creates the partner and the instance is told the outcome through `waitForResult` rather
      // than the bare decision. `approved` is still written first, so a request whose post throws
      // hard was at least recorded as decided, and completeRequest stays for the SPA callback -
      // its postedBP guard makes it a no-op once this has run.
      await db.run(cds.ql.UPDATE(HEADER).set({
        status: 'approved',
        reason: req.data.Comment || header.reason,
        approvalsReceived
      }).where({ ID: changeRequest }));
      return postAndRecord(req, { ...header, status: 'approved' });
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

      // The same step the approve path runs, so the two cannot drift on what they write or signal.
      // Reachable only for a request `approved` without a post -- one decided before 2026-08-25, or
      // one whose approve handler died between the status write and the post.
      //
      // Two things here were broken until 2026-08-25 and are gone with the shared step: it called a
      // `notifyWorkflow` declared inside the decideRequest handler, so every completion threw a
      // ReferenceError *after* creating the partner; and it wrote `failed` immediately before
      // `req.reject`, which rolls the transaction back and took that write with it.
      return postAndRecord(req, header);
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
  dataStewardUrl,
  buildBusinessPartnerInput,
  activeStagedRows,
  SUPPORTED_REQUEST_TYPES,
  EDITABLE_STATUSES,
  WITHDRAWABLE_STATUSES,
  RESUBMITTED_SIGNAL,
  DATASTEWARD_COMPLETE_SIGNAL,
  DATASTEWARD_REJECTED_SIGNAL,
  WITHDRAWN_SIGNAL,
  FINDING_COLUMNS,
  stagedFinding,
  resolveRelationNumber,
  awaitRelationNumber,
  matchDeterminedRow,
  SELF_DETERMINED_NODES,
  RELATION_WAIT_ATTEMPTS,
  RELATION_WAIT_MS,
  RELATION_NAVIGATION,
  RELATION_FIELDS,
  resolveEffectiveRole,
  currentStepAssignee
};

module.exports = ChangeRequestService;
