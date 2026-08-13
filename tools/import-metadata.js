'use strict';

/**
 * Re-imports one remote service's $metadata into srv/external — the "run the sync again" that the
 * drift check in srv/metadata-drift.js tells you to run.
 *
 *   npm run import:bp                          # via the BTP destination (works in CF)
 *   npm run import:bp -- --url <base-url>      # direct, with S4_USER / S4_PASSWORD
 *   npm run import:bp -- --file saved.edmx     # from a document you already downloaded
 *
 * Three ways in, because the destination route only works where a destination *service binding*
 * exists. `cds bind` writes .cdsrc-private.json, which CAP reads and the SAP Cloud SDK does not,
 * and even `cds bind --exec` only helps once the destination service instance itself is bound. In
 * BAS the shortest path is usually --url or --file.
 *
 * Whichever route, the checked-in copy is only overwritten once a document with entity sets is in
 * hand — a login page or a gateway error never lands in srv/external.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const cds = require('@sap/cds');

const SCRIPTS = Object.freeze({
  API_BUSINESS_PARTNER: 'import:bp',
  ZSRVB_MDMLIGHT_VH: 'import:valuehelp'
});

function parseArguments(argv) {
  const options = { service: null, url: null, file: null, insecure: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--url') options.url = argv[++index];
    else if (argument === '--file') options.file = argv[++index];
    else if (argument === '--insecure') options.insecure = true;
    else if (!options.service) options.service = argument;
  }
  return options;
}

function usage() {
  return [
    'Usage: node tools/import-metadata.js <ServiceName> [--url <base-url> | --file <path>] [--insecure]',
    '',
    '  <ServiceName>   API_BUSINESS_PARTNER or ZSRVB_MDMLIGHT_VH',
    '  --url           gateway base URL, e.g. https://host:44301/sap/opu/odata/sap',
    '                  reads S4_USER and S4_PASSWORD from the environment',
    '  --file          a $metadata document already on disk',
    '  --insecure      skip TLS verification (self-signed sandbox certificates only)'
  ].join('\n');
}

async function fromDestination(destination, url) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
  try {
    const response = await executeHttpRequest(
      { destinationName: destination },
      { method: 'GET', url, timeout: 60000 }
    );
    return response?.data;
  } catch (error) {
    throw new Error(
      `${error.message}\n\n`
      + 'No destination binding reached this process. The SAP Cloud SDK reads bindings from\n'
      + 'VCAP_SERVICES, so this route needs the destination service instance\n'
      + '(mdm-businesspartner-destination-service) bound — and for an on-premise destination, the\n'
      + 'connectivity proxy, which only exists in the Cloud Foundry runtime.\n\n'
      + 'Two routes that need none of that:\n'
      + '  --url https://<host>:44301/sap/opu/odata/sap   with S4_USER and S4_PASSWORD set\n'
      + '  --file <saved-metadata.xml>                    downloaded from the browser\n\n'
      + 'To check what is bound, read .cdsrc-private.json — `cds bind` with no arguments only\n'
      + 'prints its own usage.'
    );
  }
}

async function fromUrl(baseUrl, servicePath, { insecure }) {
  const user = process.env.S4_USER;
  const password = process.env.S4_PASSWORD;
  if (!user || !password) {
    throw new Error('--url needs S4_USER and S4_PASSWORD in the environment.');
  }
  const axios = require('axios');
  const url = `${String(baseUrl).replace(/\/$/u, '')}${servicePath}`;
  if (insecure) console.warn('TLS verification is off for this request.');
  const response = await axios.get(url, {
    auth: { username: user, password },
    responseType: 'text',
    timeout: 60000,
    headers: { Accept: 'application/xml' },
    // Self-signed certificates are normal on a sandbox gateway; it stays opt-in all the same.
    ...(insecure ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {})
  });
  return response.data;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.service) {
    console.error(usage());
    process.exit(2);
  }

  const config = cds.env.requires?.[options.service];
  if (!config?.model) {
    console.error(`${options.service} is not a remote service with a model in package.json.\n\n${usage()}`);
    process.exit(2);
  }

  const model = path.resolve(config.model);
  const edmx = `${model}.edmx`;
  // Which flavour the model was generated as is already on disk; regenerating it the other way
  // would leave two models for one service and a `using` that resolves to whichever cds prefers.
  const flavour = fs.existsSync(`${model}.cds`) ? 'cds' : 'csn';
  const servicePath = `${String(config.credentials?.path || `/${options.service}`).replace(/\/$/u, '')}/$metadata`;

  let xml;
  if (options.file) {
    console.log(`Reading ${options.file}…`);
    xml = fs.readFileSync(options.file, 'utf8');
  } else if (options.url) {
    console.log(`Reading ${options.url}${servicePath} as ${process.env.S4_USER}…`);
    xml = await fromUrl(options.url, servicePath, options);
  } else {
    const destination = config.credentials?.destination;
    if (!destination) {
      throw new Error(`${options.service} has no destination configured.\n\n${usage()}`);
    }
    console.log(`Reading ${servicePath} through destination ${destination}…`);
    xml = await fromDestination(destination, servicePath);
  }

  xml = typeof xml === 'string' ? xml : String(xml || '');
  if (!xml.includes('<EntitySet')) {
    // A login page and a gateway error both arrive as 200s with a body. Neither is a model.
    console.error(
      'That response carries no entity sets, so it is not a metadata document — '
      + 'not overwriting the checked-in copy.\n'
      + `First 200 characters:\n${xml.slice(0, 200)}`
    );
    process.exit(1);
  }

  const before = fs.existsSync(edmx) ? fs.readFileSync(edmx, 'utf8') : '';
  fs.writeFileSync(edmx, xml);
  console.log(
    `${path.relative(process.cwd(), edmx)}: ${before === xml ? 'unchanged' : 'updated'} (${xml.length} bytes)`
  );

  execFileSync(
    'cds',
    ['import', edmx, '--as', flavour, '--into', path.dirname(edmx), '--force'],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  );

  console.log(
    'Done. Review the diff in srv/external and commit both files, then run npm test — a field that '
    + 'disappeared may need adding to an exclusion list in business-partner-service.cds.'
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseArguments, usage, SCRIPTS };
