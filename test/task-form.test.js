'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'app', 'bptask');
const read = (...segments) => fs.readFileSync(path.join(APP, ...segments), 'utf8');

const component = read('webapp', 'Component.js');
const view = read('..', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse', 'view', 'BusinessPartnerMaintenance.view.xml');
const xsApp = JSON.parse(read('xs-app.json'));
const manifest = JSON.parse(read('webapp', 'manifest.json'));
const serviceCds = fs.readFileSync(
  path.join(__dirname, '..', 'srv', 'change-request-service.cds'), 'utf8'
);
const serviceJs = fs.readFileSync(
  path.join(__dirname, '..', 'srv', 'change-request-service.js'), 'utf8'
);

// The route SAP's task-form guide requires. Without it the inbox loads the form and every
// workflow call 404s, which is the failure that looks like "the form is broken".
// xs-app.json ships into the HTML5 apps repository and is schema-validated there. An unknown
// key in a route makes the entire app version unservable — every resource, manifest.json
// included, comes back 500 and the app never loads. JSON has no comments; explanations go in
// CLAUDE.md.
test('no route carries a key the repository will reject', () => {
  const allowed = new Set([
    'source', 'target', 'destination', 'service', 'endpoint', 'authenticationType',
    'csrfProtection', 'cacheControl', 'scope', 'localDir', 'replace', 'preferLocal', 'httpMethods'
  ]);
  xsApp.routes.forEach((route, index) => {
    for (const key of Object.keys(route)) {
      assert.ok(allowed.has(key), `route ${index} carries unsupported key "${key}"`);
    }
  });
});

test('the workflow runtime route is present and first', () => {
  const [first] = xsApp.routes;
  assert.equal(first.source, '^/api/(.*)$');
  assert.equal(first.service, 'com.sap.spa.processautomation');
  assert.equal(first.endpoint, 'api');
  assert.equal(first.csrfProtection, true);
  assert.equal(first.authenticationType, 'xsuaa');
});

// The base URL is derived, not hardcoded, so it cannot drift from the descriptor.
test('the workflow base url is built from sap.cloud.service and sap.app.id', () => {
  assert.match(component, /getManifestEntry\("\/sap\.cloud\/service"\)/u);
  assert.match(component, /getManifestEntry\("\/sap\.app\/id"\)/u);
  assert.match(component, /\/api\/public\/workflow\/rest\/v1/u);

  // What that resolves to for this app, so a rename of either is caught here.
  const expected = '/'
    + manifest['sap.cloud'].service.replaceAll('.', '')
    + '.' + manifest['sap.app'].id.replaceAll('.', '')
    + '/api/public/workflow/rest/v1';
  assert.equal(expected, '/mdmmdbusinesspartner.mdmmdbusinesspartnertask/api/public/workflow/rest/v1');
});

test('the inbox actions match the outcomes declared in sap.bpa.task', () => {
  const declared = manifest['sap.bpa.task'].outcomes.map((outcome) => outcome.id).sort();
  // All five go through inboxAPI.addAction (reverted 2026-08-24 to this, from a brief detour
  // through the object page header actions): both ARE declared outcomes, so pressing one belongs
  // in My Inbox's own action bar, the same native location as Approve/Reject - not a header
  // button that looks and behaves differently for what is, from BPA's point of view, the same
  // kind of thing. Check/Duplicate Check stay in the header: neither is an outcome, so there is
  // nowhere else for them to go. The data steward's Reject reuses the approve task type's own
  // "reject" id (2026-08-26) rather than a new one - the two task types never coexist on one task
  // instance, so the same id can be registered with a different handler each time. Only "enrich"
  // (Complete Review) is a genuinely new id, since there is no existing outcome to reuse for it.
  assert.deepEqual(declared, ['approve', 'enrich', 'reject', 'resubmit', 'withdraw']);
  // Registered with the same ids, or the completion is rejected by the runtime.
  assert.match(component, /\{ id: "reject", label: "Reject", type: "reject" \}/u);
  assert.match(component, /\{ id: "approve", label: "Approve", type: "accept" \}/u);
  assert.match(component, /\{ id: "enrich", label: "Complete Review", type: "accept" \}/u);
  // "reject" is registered twice - once per task type that uses it, each with its own handler.
  assert.equal((component.match(/\{ id: "reject", label: "Reject", type: "reject" \}/gu) || []).length, 2);
  assert.match(component, /inbox\.addAction\(/u);
});

test('the task is completed by patching the task instance', () => {
  assert.match(component, /status: "COMPLETED"/u);
  assert.match(component, /decision: outcomeId/u);
  assert.match(component, /method: "PATCH"/u);
  // A PATCH without the token is rejected; the token is fetched from the runtime.
  assert.match(component, /"X-CSRF-Token": "Fetch"/u);
  assert.match(component, /xsrf-token/u);
  // A failed completion must not look like a success.
  assert.match(component, /if \(!response\.ok\)/u);
  assert.match(component, /updateTask\("NA"/u, 'the inbox list has to be refreshed');
});

// Completing the task resumes the workflow, which calls completeRequest and posts to S/4 —
// so the request must already be `approved` when that happens.
test('CAP records the decision before the task is completed', () => {
  const decideAt = component.indexOf('this._decideOnServer(outcomeId)');
  const patchAt = component.indexOf('this._patchTaskInstance(outcomeId)');
  assert.ok(decideAt > -1 && patchAt > -1);
  assert.ok(decideAt < patchAt, 'the CAP decision has to be recorded first');
});

// --- The extraction (2026-08-20) -------------------------------------------------------
//
// The task UI used to be the Fiori Elements app itself: sap.bpa.task sat in its manifest and
// Component.js implemented the inbox contract on top of sap.fe.core.AppComponent. SAP documents
// task UIs for freestyle apps, so the contract moved to an app that is one, and the screen both
// of them render moved to app/reuse rather than being copied.

const BP_APP = path.join(__dirname, '..', 'app', 'businesspartner', 'webapp');
const bpManifest = JSON.parse(fs.readFileSync(path.join(BP_APP, 'manifest.json'), 'utf8'));
const bpComponent = fs.readFileSync(path.join(BP_APP, 'Component.js'), 'utf8');
const REUSE = path.join(__dirname, '..', 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');
const reuseController = fs.readFileSync(
  path.join(REUSE, 'controller', 'BusinessPartnerMaintenance.controller.js'), 'utf8'
);

test('the task UI is a freestyle app, not Fiori Elements', () => {
  assert.match(component, /sap\/ui\/core\/UIComponent/u);
  assert.equal(/sap\/fe\/core/u.test(component), false, 'no Fiori Elements component class');
  assert.equal(Object.hasOwn(manifest['sap.ui5'].dependencies.libs, 'sap.fe.templates'), false);
  assert.equal(manifest['sap.ui5'].rootView.viewName, 'mdm.md.businesspartner.task.view.App');
});

test('the task contract lives in the task app and nowhere else', () => {
  assert.ok(manifest['sap.bpa.task'], 'the task app declares it');
  assert.equal(Object.hasOwn(bpManifest, 'sap.bpa.task'), false, 'the partner app no longer does');
  // The inbox plumbing went with it; what stays is the bpurl query-parameter deep link.
  assert.equal(/inboxAPI/u.test(bpComponent), false);
  assert.equal(/task-instances/u.test(bpComponent), false);
  assert.match(bpComponent, /changerequestid/u, 'the deep link still opens the approve view');
});

// The whole point of the split: if the shared screen ever takes a Fiori Elements dependency, the
// task app stops working and the failure surfaces in the browser rather than here.
test('the shared screen depends on no Fiori Elements module', () => {
  assert.equal(/sap\/fe\/|sap\.fe\./u.test(reuseController), false);
  assert.equal(/sap\/fe\/|sap\.fe\./u.test(view), false);
});

test('the task app is its own app on the same business service', () => {
  assert.equal(manifest['sap.cloud'].service, bpManifest['sap.cloud'].service);
  assert.notEqual(manifest['sap.app'].id, bpManifest['sap.app'].id);
  // No inbound: My Inbox resolves it by sap.cloud.service and app id, not by intent - so the
  // one-inbound-per-app limit in Work Zone standard edition never applies to it.
  assert.equal(Object.hasOwn(manifest['sap.app'], 'crossNavigation'), false);
});

/**
 * Set by Maarten on 2026-08-20. `{{Approve}}` resolves out of the app's own i18n bundle, which is
 * not where the Lobby looks, so the outcome labels are literal text and the i18n keys went with
 * them. Pinned because "these should be translatable" is exactly the observation that would put
 * the placeholders back.
 */
test('the outcome labels are literal, not i18n placeholders', () => {
  const outcomes = manifest['sap.bpa.task'].outcomes;
  assert.deepEqual(
    outcomes.map((outcome) => outcome.label),
    ['Approve', 'Reject', 'Resubmit', 'Withdraw', 'Complete Review']
  );
  for (const outcome of outcomes) {
    assert.equal(
      /\{\{|\}\}/u.test(outcome.label), false, `${outcome.id} must not carry a placeholder`
    );
  }
  const bundle = read('webapp', 'i18n', 'i18n.properties');
  assert.equal(/^Approve=/mu.test(bundle), false, 'and the unused keys are not left behind');
});

/**
 * My Inbox does not render an embedded app's `sap.m.Page` footer. Every action in it was therefore
 * invisible on a task - Check and Duplicate Check on the approve task, Resubmit and Withdraw on a
 * rework task, and Back - while Approve/Reject survived because they come from inboxAPI.addAction.
 * Check/Duplicate Check move to the header actions (page content, so it does render) because
 * neither is a declared outcome and there is nowhere else for them to go. Resubmit/Withdraw went
 * there too on 2026-08-21, then back out on 2026-08-24: both ARE outcomes, so they belong in My
 * Inbox's own action bar via inboxAPI.addAction, the same place Approve/Reject already render -
 * not a second, differently-styled button up here for what is the same kind of thing to BPA.
 */

/**
 * Pinned on request (2026-08-21). A process in SAP Build Process Automation points its UI5 task at
 * one app version, so every bump of `applicationVersion` means re-pointing the task - the workflow
 * has been rebuilt three times over 1.0.0 -> 1.1.0 -> 1.2.0 for no gain the process could see.
 *
 * Nothing in the build derives it from `mta.yaml`, so the MTA version is free to move; this is
 * hand-maintained and now deliberately still. Raise it only when the process is going to be
 * re-pointed on purpose, and change this assertion in the same commit so the two cannot drift.
 *
 * Raised 1.2.0 -> 1.3.0 on 2026-08-25, which is such an occasion: `prefix` joined
 * sap.bpa.task.inputs, and the Lobby only re-reads that schema when the task is re-pointed. The
 * new version URL also guarantees nothing serves the old manifest from a cache.
 *
 * **Held at 1.5.0 through the 2026-09-02 multiple-approver fix, deliberately** (asked for). That
 * change removed `currentapprover`/`totalapprovers` from sap.bpa.task.inputs and moved the "is this
 * the last approval" decision server-side, where `decideRequest` counts ApprovalsReceived against
 * RequiredApprovals. Removing inputs the form no longer reads is backwards-compatible, so there is
 * nothing here the Lobby has to be shown a new schema for - and raising the number would strand the
 * Lobby on a version that no longer exists until somebody re-points the User Task by hand. 1.6.0
 * was raised and reverted the same day for that reason; do not re-raise it, and do not "fix" this
 * assertion by bumping the manifest. This is the standing bump-on-every-deploy rule's one exception,
 * and it is one because the version is an address the process resolves, not just a label.
 */
test('the task app version is pinned, so the process keeps pointing at it', () => {
  assert.equal(manifest['sap.app'].applicationVersion.version, '1.5.0');
});

test('currentapprover/totalapprovers are gone - the task form no longer decides finality', () => {
  const inputProperties = manifest['sap.bpa.task'].inputs.properties;
  assert.equal('currentapprover' in inputProperties, false);
  assert.equal('totalapprovers' in inputProperties, false);
  assert.equal(component.includes('_isFinalApprover'), false);
  assert.equal(component.includes('isIntermediateApproval'), false);
  // Every approve reaches decideRequest now, unconditionally.
  assert.match(component, /var decision = await this\._decideOnServer\(outcomeId\);/u);
});

/**
 * The empty form in My Inbox: the maintenance model has to exist before the handover, because
 * `_loadStagedRequest` reads it on its first line and the handover calls it synchronously from
 * `onInit`. Created afterwards, the request loaded into a model that was not there yet and the
 * empty create state landed on top - "New Business Partner" with every section blank, which is
 * `_emptyState()`'s own header. A routed load cannot hit it: a pattern match arrives later.
 */

/**
 * "Cannot read properties of undefined (reading 'bindContext')", in a popup, on opening a change
 * request from My Inbox (reported 2026-08-21).
 *
 * The task handover calls `_loadStagedRequest` from `onInit` - it has to, because embedded there is
 * no route to carry the request id. But a view has not inherited its component's models at that
 * point: propagation happens when the view is placed in the control tree, which for a routed view
 * is before a pattern matches and for this one is *after* onInit returns. So
 * `this.getView().getModel("cr")` answered undefined and the first action call died on it.
 *
 * The fallback is the one the rule pages already use for their own service model. Pinned because the
 * failure only shows in the inbox: every routed path works, so nothing else catches it.
 */
test('a service model is read off the component when the view has not inherited it yet', () => {
  const controller = read(
    '..', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
    'controller', 'BusinessPartnerMaintenance.controller.js'
  );

  // One accessor, and it tries the view first so a routed view keeps behaving exactly as it did.
  assert.match(controller, /_serviceModel: function \(modelName\)/u);
  const accessor = controller.slice(controller.indexOf('_serviceModel: function'));
  const body = accessor.slice(0, accessor.indexOf('\n      },'));
  assert.match(body, /this\.getView\(\)\.getModel\(modelName\)/u);
  assert.match(body, /\|\|[\s\S]{0,60}component\.getModel\(modelName\)/u);

  // Every reader that can run before the view is placed goes through it.
  assert.match(controller, /var model = this\._serviceModel\(modelName\);/u);
  assert.equal(
    /getView\(\)\.getModel\(modelName\)\.bindContext/u.test(controller),
    false,
    'no action call reads the model straight off the view any more'
  );
  // And the action names the missing service rather than letting the framework throw.
  assert.match(controller, /service is not bound to this screen/u);
});

// The OData path is built at runtime from a prefix the TASK CONTEXT carries (2026-08-25).
// Why it cannot come from the manifest, the module loader, or the MTA: CLAUDE.md, "The task app".
test('the OData sources are relative, and no model is instantiated from the manifest', () => {
  const sources = manifest['sap.app'].dataSources;
  assert.equal(sources.mainService.uri, 'service/businesspartner/');
  assert.equal(sources.changeRequestService.uri, 'service/changerequest/');
  // A dataSource-backed model would be built at init, before any prefix is known, and resolved
  // against the version-stamped path where /service/* is not proxied.
  assert.deepEqual(Object.keys(manifest['sap.ui5'].models), ['i18n']);
});

// `prefix` has to be a declared input or the Lobby cannot map it - and an unmapped input never
// becomes task context, which is the whole failure mode this input exists to avoid.
test('prefix is a declared task input, and optional like tasktype', () => {
  const inputs = manifest['sap.bpa.task'].inputs;
  assert.ok(inputs.properties.prefix, 'prefix is declared');
  assert.equal(
    inputs.required.includes('prefix'), false,
    'optional - a task built before this existed must still open far enough to report itself'
  );
});

test('the app path is composed from the context prefix and the two descriptor ids', () => {
  // From _serviceUrl, not _appPath: the uri lookup lives in the former and _appPath follows it.
  const body = component.slice(
    component.indexOf('_serviceUrl: function'),
    component.indexOf('_loadPermissions: function')
  );
  assert.match(body, /if \(!prefix\) return "";/u, 'no prefix is standalone, where relative is right');
  assert.match(body, /getManifestEntry\("\/sap\.cloud\/service"\)/u);
  assert.match(body, /getManifestEntry\("\/sap\.app\/id"\)/u);
  assert.match(body, /"\/" \+ prefix \+ "\." \+ service \+ "\." \+ app/u);
  // The service path stays declared in the manifest; only its origin is composed.
  assert.match(body, /getManifestEntry\("\/sap\.app\/dataSources\/" \+ dataSource \+ "\/uri"\)/u);
});

// Ordering is the whole design: models cannot exist before the context, and permissions and the
// router both read models, so all three move behind it.
test('nothing binds before the prefix arrives', () => {
  const init = component.slice(
    component.indexOf('init: function'),
    component.indexOf('_begin: function')
  );
  assert.equal(
    /this\._loadPermissions\(\);/u.test(init), false,
    'permissions no longer run in init - the default model does not exist yet'
  );
  assert.equal(
    /this\.getRouter\(\)\.initialize\(\);/u.test(init), false,
    'routing no longer runs in init - a route would create a view with no models'
  );
  const begin = component.slice(
    component.indexOf('_begin: function'),
    component.indexOf('_initServiceModels: function')
  );
  const modelsAt = begin.indexOf('_initServiceModels(prefix)');
  const permsAt = begin.indexOf('_loadPermissions()');
  const routerAt = begin.indexOf('getRouter().initialize()');
  assert.ok(modelsAt > -1 && permsAt > -1 && routerAt > -1, 'all three happen in _begin');
  assert.ok(modelsAt < permsAt && modelsAt < routerAt, 'the models come first, or the rest read none');
  // Embedded: after the context resolves. Standalone: with no prefix at all.
  assert.match(component, /this\._begin\(context\.prefix\);/u);
  assert.match(component, /this\._begin\(""\);/u);
});

// Tried the other way round on 2026-09-03 (eager on `cr`, since that is what the first paint waits
// on) and reverted the same day: the data steward task opened with "The change request service is
// not bound to this screen" - the `cr` model was missing from the component entirely. A model that
// does not exist cannot be fast, so this pins the arrangement that binds.
test('both service models are constructed, and cr is the lazy one', () => {
  const models = component.slice(
    component.indexOf('_initServiceModels: function'),
    component.indexOf('_serviceSettings: function')
  );
  assert.match(models, /_serviceSettings\("mainService", prefix, true\)/u);
  assert.match(models, /_serviceSettings\("changeRequestService", prefix, false\),\s*"cr"/u);
});

// A missing prefix must not read as a broken service: relative resolves against the launchpad
// root and 404s every call, which is what sent the last diagnosis to the wrong place.
test('a task carrying no prefix says so rather than 404ing', () => {
  assert.match(component, /if \(!context\.prefix\)/u);
  assert.match(component, /no service prefix/u);
  assert.match(component, /task input `prefix` declared in sap\.bpa\.task/u);
});
