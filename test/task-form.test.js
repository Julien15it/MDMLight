'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'app', 'businesspartner');
const read = (...segments) => fs.readFileSync(path.join(APP, ...segments), 'utf8');

const component = read('webapp', 'Component.js');
const view = read('webapp', 'ext', 'view', 'BusinessPartnerMaintenance.view.xml');
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
  assert.equal(expected, '/mdmmdbusinesspartner.mdmmdbusinesspartnermanage/api/public/workflow/rest/v1');
});

test('the inbox actions match the outcomes declared in sap.bpa.task', () => {
  const declared = manifest['sap.bpa.task'].outcomes.map((outcome) => outcome.id).sort();
  assert.deepEqual(declared, ['approve', 'reject']);
  // Registered with the same ids, or the completion is rejected by the runtime.
  assert.match(component, /\{ id: "reject", label: "Reject", type: "reject" \}/u);
  assert.match(component, /\{ id: "approve", label: "Approve", type: "accept" \}/u);
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
  assert.match(component, /if \(context\.changerequestid\) this\._openApprove\(context\.changerequestid\)/u);
  assert.equal(
    /window\.location\.hash && window\.location\.hash !== "#"/u.test(component),
    false,
    'the old host-hash guard must be gone'
  );
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
