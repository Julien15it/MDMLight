'use strict';

/**
 * Re-imports one remote service's $metadata into srv/external — the "run the sync again" the
 * drift check in srv/metadata-drift.js tells you to run.
 *
 *   npm run import:bp
 *   npm run import:valuehelp
 *
 * It fetches through the BTP destination rather than the raw URL, so it needs no credentials of
 * its own and works wherever the app itself works: in CF, and locally under the hybrid profile
 * (`cds bind`, see .cdsrc-private.json). Without a binding it stops and says so — it will not
 * silently leave the checked-in copy half-written.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

async function main() {
  const service = process.argv[2];
  if (!service) {
    console.error('Usage: node tools/import-metadata.js <ServiceName>');
    process.exit(2);
  }

  const config = cds.env.requires?.[service];
  if (!config?.model || !config?.credentials?.destination) {
    console.error(`${service} is not a destination-backed remote service in package.json.`);
    process.exit(2);
  }

  const model = path.resolve(config.model);
  const edmx = `${model}.edmx`;
  // Which flavour the model was generated as is already on disk; regenerating it the other way
  // would leave two models for one service and a `using` that resolves to whichever cds prefers.
  const flavour = fs.existsSync(`${model}.cds`) ? 'cds' : 'csn';
  const url = `${String(config.credentials.path || `/${service}`).replace(/\/$/u, '')}/$metadata`;

  console.log(`Reading ${url} through destination ${config.credentials.destination}…`);
  const response = await executeHttpRequest(
    { destinationName: config.credentials.destination },
    { method: 'GET', url, timeout: 60000 }
  );

  const xml = typeof response?.data === 'string' ? response.data : String(response?.data || '');
  if (!xml.includes('<EntitySet')) {
    console.error('That response carries no entity sets — not overwriting the checked-in copy.');
    process.exit(1);
  }

  const before = fs.existsSync(edmx) ? fs.readFileSync(edmx, 'utf8') : '';
  fs.writeFileSync(edmx, xml);
  console.log(`${path.relative(process.cwd(), edmx)}: ${before === xml ? 'unchanged' : 'updated'} (${xml.length} bytes)`);

  execFileSync(
    'cds',
    ['import', edmx, '--as', flavour, '--into', path.dirname(edmx), '--force'],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  );

  console.log(`Done. Review the diff in srv/external and commit both files, then run npm test — `
    + `a field that disappeared may need adding to an exclusion list in business-partner-service.cds.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
