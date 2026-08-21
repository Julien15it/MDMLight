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
  // approve/reject go through inboxAPI.addAction, same as ever. resubmit/withdraw are declared
  // outcomes too - the workflow runtime has to accept them on completion - but are reported by
  // completeOutcome() after the shared screen's own Resubmit/Withdraw buttons already succeeded,
  // never by an inbox button: unlike a decision, resubmitRequest needs the requester's edits.
  assert.deepEqual(declared, ['approve', 'reject', 'resubmit', 'withdraw']);
  // Registered with the same ids, or the completion is rejected by the runtime.
  assert.match(component, /\{ id: "reject", label: "Reject", type: "reject" \}/u);
  assert.match(component, /\{ id: "approve", label: "Approve", type: "accept" \}/u);
  assert.match(component, /inbox\.addAction\(/u);
});

test('resubmit/withdraw are never wired to an inbox button', () => {
  assert.equal(/id: "resubmit"/u.test(component), false);
  assert.equal(/id: "withdraw"/u.test(component), false);
  assert.match(component, /completeOutcome: async function \(outcomeId\)/u);
});

// A task with no tasktype (every task built before rework-via-My-Inbox existed) must still open
// the approver's decision screen - nothing already working needed its input mapping touched.
test('tasktype distinguishes a rework task from the approver decision task', () => {
  assert.match(component, /context\.tasktype === "rework"/u);
  assert.match(component, /if \(context\.changerequestid\) \{\s+this\._openRework\(context\.changerequestid\);/u);
  assert.ok(manifest['sap.bpa.task'].inputs.properties.tasktype, 'tasktype is declared as an input');
  assert.equal(
    manifest['sap.bpa.task'].inputs.required.includes('tasktype'), false,
    'optional - absent still means approve'
  );
});

// Rework needs the same bypass Julien's fix gave approve: the hash belongs to the inbox shell
// embedded, so a route pattern written into it matches nothing of ours.
test('rework shows the page without touching the hash, the same way approve does', () => {
  const embedded = component.slice(component.indexOf('_openRework: function'));
  const body = embedded.slice(0, embedded.indexOf('_startupParameters'));
  assert.match(body, /if \(!this\.getModel\("env"\)\.getProperty\("\/embedded"\)\)/u);
  assert.match(body, /navTo\(\s*"ChangeRequestRework"/u);
  assert.match(body, /setProperty\("\/taskReworkChangeRequest", changeRequest\)/u);
  assert.match(body, /publish\("taskform", "rework"/u);
  assert.match(body, /targets\.display\("BusinessPartnerMaintenance"\)/u);
});

test('the rework page picks the request up by model and by event, on its own channel', () => {
  assert.match(reuseController, /subscribe\("taskform", "rework"/u);
  assert.match(reuseController, /getProperty\("\/taskReworkChangeRequest"\)/u);
  const matches = reuseController.match(
    /_loadStagedRequest\(\s*(?:data\.changeRequest|pendingRework), "rework"\)/gu
  );
  assert.equal(matches.length, 2, 'both paths must load the staged request');
});

test('resubmit and withdraw report back to an embedded rework task, only after they succeed', () => {
  assert.match(reuseController, /_completeEmbeddedOutcome: function \(outcomeId\)/u);
  // A no-op outside app/bptask: only that host's Component implements completeOutcome.
  assert.match(
    reuseController, /if \(!this\.getView\(\)\.getModel\("env"\)\.getProperty\("\/embedded"\)\) return;/u
  );
  assert.match(reuseController, /component\.completeOutcome/u);
  // Wired into each action's own success path, not called unconditionally.
  assert.match(reuseController, /_completeEmbeddedOutcome\("withdraw"\)/u);
  assert.match(reuseController, /if \(action === "resubmitRequest"\) this\._completeEmbeddedOutcome\("resubmit"\)/u);
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

// Both paths resuming the workflow would deliver the same decision twice.
test('the task form suppresses the server-side BPA trigger', () => {
  assert.match(component, /binding\.setParameter\("SignalWorkflow", false\)/u);
  assert.match(serviceCds, /SignalWorkflow : Boolean/u);
  assert.match(serviceJs, /if \(req\.data\.SignalWorkflow === false\) return;/u);
});

// Embedded, window.location is the host's — My Inbox is itself a routed app, so a hash guard
// would send the task form to the partner list instead of the request under review.
test('embedded navigation reads the task context, not the browser hash', () => {
  assert.match(component, /contextModel\.loadData\(this\._taskInstanceUrl\(\) \+ "\/context"\)/u);
  assert.match(component, /if \(context\.changerequestid\) \{\s+this\._openApprove\(context\.changerequestid\);/u);
  assert.equal(
    /window\.location\.hash && window\.location\.hash !== "#"/u.test(component),
    false,
    'the old host-hash guard must be gone'
  );
});

// The hash belongs to the inbox shell while embedded, so a route pattern written into it
// matches nothing of ours: the component renders and the approve page never activates. That
// is the "form is there, data is not" symptom, so embedded must not navigate at all.
test('embedded shows the page without touching the hash', () => {
  const embedded = component.slice(component.indexOf('_openApprove: function'));
  // The whole method, not the file: navTo must be inside the standalone guard and nowhere else.
  const body = embedded.slice(0, embedded.indexOf('_startupParameters'));

  // navTo stays, but only on the standalone side of the guard.
  assert.match(body, /if \(!this\.getModel\("env"\)\.getProperty\("\/embedded"\)\)/u);
  assert.match(body, /navTo\(/u);
  // And the embedded side displays the target and hands the id over directly.
  assert.match(body, /setProperty\("\/taskChangeRequest", changeRequest\)/u);
  assert.match(body, /publish\("taskform", "approve"/u);
  assert.match(body, /targets\.display\("BusinessPartnerMaintenance"\)/u);
});

// Both, because the context fetch is a round trip and may land either side of the page's
// own init: the model covers a late reader, the event an early one.
test('the approve page picks the request up by model and by event', () => {
  const controller = read(
    '..', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
    'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  assert.match(controller, /subscribe\("taskform", "approve"/u);
  assert.match(controller, /getProperty\("\/taskChangeRequest"\)/u);
  const matches = controller.match(/_loadStagedRequest\(\s*(?:data\.changeRequest|pending), "approve"\)/gu);
  assert.equal(matches.length, 2, 'both paths must load the staged request');
});

// A task with no id mapped is a process problem, and a blank form looks like the app lost the
// data instead. The message has to name what to fix.
test('a task with no request id says so', () => {
  assert.match(component, /carries no change request id/u);
  assert.match(component, /sap\.bpa\.task/u);
});

test('a context that cannot be loaded is reported, not left as an empty create screen', () => {
  assert.match(component, /The task could not be loaded/u);
});

// Standalone the component must behave exactly as before: the router owns the hash.
test('nothing task-related happens when the component is not embedded', () => {
  assert.match(component, /if \(!startup\.inboxAPI \|\| !startup\.taskModel\)/u);
  assert.match(component, /embedded: false/u, 'the flag is always set, so the view can bind it');
});

// My Inbox renders the outcome buttons itself; ours would be a second, divergent place to press.
test('the app hides its own decision buttons while embedded', () => {
  const guarded = view.match(
    /visible="\{= \$\{maintenance>\/showDecisionButtons\} &amp;&amp; !\$\{env>\/embedded\} \}"/gu
  );
  assert.equal(guarded.length, 2, 'both Approve and Reject');
  // Navigating to the partner list from inside a task form is a dead end.
  assert.match(view, /text="Business Partners"[\s\S]{0,140}visible="\{= !\$\{env>\/embedded\} \}"/u);
});

// An unhandled rejection in init can abort the shell's app creation and have it retried, which
// surfaces as "adding element with duplicate id ...-content" and looks nothing like the cause.
test('task form initialisation can never reject into component init', () => {
  assert.match(component, /this\._initTaskForm\(\)\.catch\(/u);
  assert.match(component, /Task form initialisation failed/u);
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

test('both apps render the one shared screen, resolved the same way', () => {
  for (const [name, descriptor] of [['task', manifest], ['partner', bpManifest]]) {
    assert.equal(
      descriptor['sap.ui5'].resourceRoots['mdm.md.businesspartner.reuse'], './reuse',
      `the ${name} app maps the reuse namespace`
    );
    const targets = descriptor['sap.ui5'].routing.targets;
    assert.equal(
      targets.BusinessPartnerMaintenance.name,
      'mdm.md.businesspartner.reuse.view.BusinessPartnerMaintenance',
      `the ${name} app targets the shared view`
    );
  }
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
    outcomes.map((outcome) => outcome.label), ['Approve', 'Reject', 'Resubmit', 'Withdraw']
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
 * Pinned on request (2026-08-21). A process in SAP Build Process Automation points its UI5 task at
 * one app version, so every bump of `applicationVersion` means re-pointing the task - the workflow
 * has been rebuilt three times over 1.0.0 -> 1.1.0 -> 1.2.0 for no gain the process could see.
 *
 * Nothing in the build derives it from `mta.yaml`, so the MTA version is free to move; this is
 * hand-maintained and now deliberately still. Raise it only when the process is going to be
 * re-pointed on purpose, and change this assertion in the same commit so the two cannot drift.
 */
test('the task app version is pinned, so the process keeps pointing at it', () => {
  assert.equal(manifest['sap.app'].applicationVersion.version, '1.2.0');
});

/**
 * The empty form in My Inbox: the maintenance model has to exist before the handover, because
 * `_loadStagedRequest` reads it on its first line and the handover calls it synchronously from
 * `onInit`. Created afterwards, the request loaded into a model that was not there yet and the
 * empty create state landed on top - "New Business Partner" with every section blank, which is
 * `_emptyState()`'s own header. A routed load cannot hit it: a pattern match arrives later.
 */
test('the maintenance model exists before the task handover reads it', () => {
  const init = reuseController.slice(reuseController.indexOf('onInit: function'));
  const body = init.slice(0, init.indexOf('_emptyState: function'));

  const modelAt = body.indexOf('setModel(new JSONModel(this._emptyState()), "maintenance")');
  const handoverAt = body.indexOf('getProperty("/taskChangeRequest")');
  assert.ok(modelAt > -1 && handoverAt > -1, 'both the model and the handover are in onInit');
  assert.ok(modelAt < handoverAt, 'the model has to be created first, or the load writes nowhere');
});


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

// The reason the fallback is needed at all: the handover runs inside onInit, where a routed load
// never does. If this ever moves out of onInit the fallback is still correct, but the comment on
// _serviceModel would be describing something that no longer happens.
test('the task handover still loads the request from onInit', () => {
  const controller = read(
    '..', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse',
    'controller', 'BusinessPartnerMaintenance.controller.js'
  );
  const init = controller.slice(controller.indexOf('onInit: function'));
  const body = init.slice(0, init.indexOf('_emptyState: function'));
  assert.match(body, /_loadStagedRequest\(pending, "approve"\)/u);
  assert.match(body, /_loadStagedRequest\(pendingRework, "rework"\)/u);
});
