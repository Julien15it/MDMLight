/**
 * Copies the shared maintenance screen into every app that renders it, so there is one source of
 * truth in `app/reuse` and no second copy in git.
 *
 * Why a copy and not a deployed library: an HTML5-repository library has to be addressed by its
 * version-stamped URL, and a stale version reference is exactly what made the task UI 404 on
 * 2026-08-20. Copying at build time keeps the module names stable (`mdm.md.businesspartner.reuse.*`
 * via `resourceRoots` in each manifest) and leaves nothing to resolve at runtime.
 *
 * `webapp/reuse` is generated and gitignored. Never edit it - edit `app/reuse/src`.
 */
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'app', 'reuse', 'src', 'mdm', 'md', 'businesspartner', 'reuse');

// Every app whose manifest maps `mdm.md.businesspartner.reuse` onto `./reuse`.
const CONSUMERS = ['app/businesspartner/webapp/reuse', 'app/bptask/webapp/reuse'];

if (!fs.existsSync(source)) {
  console.error(`The reuse library is missing at ${source}.`);
  process.exit(1);
}

// A file the consumer cannot run is worse than a missing one: it deploys and fails in the browser.
for (const required of ['controller/BusinessPartnerMaintenance.controller.js', 'view/BusinessPartnerMaintenance.view.xml', 'BusinessPartnerMetadata.js']) {
  if (!fs.existsSync(path.join(source, required))) {
    console.error(`The reuse library is incomplete: ${required} is missing.`);
    process.exit(1);
  }
}

for (const consumer of CONSUMERS) {
  const target = path.join(projectRoot, consumer);
  // Removed first, so a file deleted from the library cannot survive in a consumer as a stale copy.
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  console.log(`Synced the reuse library into ${consumer}`);
}
