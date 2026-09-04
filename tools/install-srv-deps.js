'use strict';

// Runs from `gen/srv` (mdm-businesspartner-srv's own module path in mta.yaml). MBT's
// `builder: custom` executes each `commands:` entry directly, never through a shell (see
// deployment.md, "The srv module installs from the lockfile") - so `>`, `|` and `||` inside a
// commands string are passed through as literal characters instead of being interpreted, breaking
// any shell-style fallback written inline there (confirmed live 2026-09-04: `cp -n
// ../../package-lock.json . 2>/dev/null || true` ran `cp` with `2>/dev/null`, `||` and `true` as
// three more literal source arguments, and cp tried to use the last one, `true`, as a destination
// directory). This script holds the actual fallback logic instead - mta.yaml only ever invokes it
// plainly (`node ../../tools/install-srv-deps.js`), with nothing in the invocation for MBT to
// mishandle.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const cwd = process.cwd();
const rootLockfile = path.join(cwd, '..', '..', 'package-lock.json');
const localLockfile = path.join(cwd, 'package-lock.json');

// cds build sometimes already copies the lockfile into gen/srv; supply the root one only if not -
// mirrors `cp -n`'s own no-clobber behaviour.
if (fs.existsSync(rootLockfile) && !fs.existsSync(localLockfile)) {
  fs.copyFileSync(rootLockfile, localLockfile);
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

// `npm ci` installs the lockfile as-is, far faster than `npm install`'s re-resolve of every version
// range - but refuses outright if the generated package.json does not satisfy it. Falling back to
// `npm install` keeps the build working exactly as it did before this existed; do not remove the
// fallback, and do not turn this back into an inline `||` in mta.yaml.
try {
  run('npm', ['ci', '--omit=dev']);
} catch (error) {
  console.warn('[install-srv-deps] npm ci failed, falling back to npm install:', error.message);
  run('npm', ['install', '--omit=dev']);
}
