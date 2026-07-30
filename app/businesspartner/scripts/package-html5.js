const fs = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const resourcesDir = path.join(projectRoot, 'resources');
const zipPath = path.join(resourcesDir, 'mdmmdbusinesspartnermanage.zip');

if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
  throw new Error('dist/manifest.json is missing; run npm run build:cf first');
}
if (!fs.existsSync(path.join(distDir, 'xs-app.json'))) {
  throw new Error('dist/xs-app.json is missing; the HTML5 repository cannot deploy this app');
}

fs.mkdirSync(resourcesDir, { recursive: true });

const output = fs.createWriteStream(zipPath);
const archive = archiver('zip', { zlib: { level: 9 } });

const completed = new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
  archive.on('warning', (error) => {
    if (error.code === 'ENOENT') {
      console.warn(error.message);
    } else {
      reject(error);
    }
  });
});

archive.pipe(output);
archive.directory(distDir, false);
archive.finalize();

completed
  .then(() => console.log(`Created ${zipPath} (${archive.pointer()} bytes)`))
