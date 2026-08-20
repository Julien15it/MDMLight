// Zips every UI app's dist/ into resources/, which is what the app-content module ships to the
// HTML5 repository. Explicit on purpose: relying on mbt to archive an html5 module's build-result
// produced a 22-byte empty zip on 2026-08-17, which would have deleted both apps from the repo.
const fs = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');

const projectRoot = path.resolve(__dirname, '..');
const resourcesDir = path.join(projectRoot, 'resources');

// One entry per app: the folder to zip, and the name the HTML5 repo deployer sees.
const APPS = [
  { dist: 'app/businesspartner/dist', zip: 'mdmmdbusinesspartnermanage.zip' },
  { dist: 'app/mdmrules/dist', zip: 'mdmmdmrulesmanage.zip' },
  { dist: 'app/bptask/dist', zip: 'mdmmdbusinesspartnertask.zip' }
];

function zipApp(app) {
  const distDir = path.join(projectRoot, app.dist);
  for (const required of ['manifest.json', 'xs-app.json']) {
    if (!fs.existsSync(path.join(distDir, required))) {
      throw new Error(`${app.dist}/${required} is missing; run the app's build:cf first`);
    }
  }

  const zipPath = path.join(resourcesDir, app.zip);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const completed = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (error) => {
      if (error.code === 'ENOENT') console.warn(error.message);
      else reject(error);
    });
  });

  archive.pipe(output);
  archive.directory(distDir, false);
  archive.finalize();

  // An empty archive is the failure this script exists to catch, so it must never ship.
  return completed.then(() => {
    if (archive.pointer() < 1024) {
      throw new Error(`${app.zip} came out at ${archive.pointer()} bytes; ${app.dist} was empty`);
    }
    console.log(`Created ${zipPath} (${archive.pointer()} bytes)`);
  });
}

fs.rmSync(resourcesDir, { recursive: true, force: true });
fs.mkdirSync(resourcesDir, { recursive: true });

APPS.reduce((chain, app) => chain.then(() => zipApp(app)), Promise.resolve())
  .then(() => console.log(`Packaged ${APPS.length} app(s) into resources/`))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
