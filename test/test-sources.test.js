'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A guard on the tests themselves, added 2026-09-03 after the same mistake landed FOUR times in one
 * day: a regex literal split across two lines.
 *
 * `/foo\s*` + newline + `\s*bar/u` is a syntax error, so the whole FILE fails to parse. Node reports
 * that as the file failing at `1:1` with the message `'test failed'` and no test named - so it reads
 * like a broken assertion inside code that was never loaded, and the search starts in the wrong
 * place every time. It cost three round trips before the shape was recognised.
 *
 * The cause is always the same: a `\n` meant as two characters INSIDE a regex, written as a real
 * line break. The fix is always the same too - **`\s*` already matches a newline**, so the `\n` was
 * never needed and the two lines simply join up.
 *
 * Both rules below were checked against every existing test file and flag none of them, so a hit is
 * a real break rather than a style opinion.
 */

const TEST_DIR = __dirname;

/** Regex syntax, never a valid way to begin a line of JavaScript. */
const STARTS_WITH_ESCAPE = /^[ \t]*\\/u;
/** `assert.match(x, /…` - the point where a regex argument opens. */
const OPENS_REGEX = /,\s*\/(?![/*])/u;
/** `…/u)`, `…/u,`, `…/u.test(` or a regex that simply ends the line. */
const CLOSES_REGEX = /\/[a-z]*\s*([,).]|$)/u;

const sourceLines = (file) => fs.readFileSync(file, 'utf8').split('\n');

function testFiles() {
  return fs.readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join(TEST_DIR, name));
}

/** Comments wrap freely and may begin with anything; only code is judged. */
const isComment = (line) => {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
};

test('no test file splits a regex literal across two lines', () => {
  const offenders = [];
  for (const file of testFiles()) {
    sourceLines(file).forEach((line, index) => {
      if (isComment(line)) return;
      const broken = STARTS_WITH_ESCAPE.test(line)
        || (OPENS_REGEX.test(line) && !CLOSES_REGEX.test(line));
      if (broken) offenders.push(`${path.basename(file)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    'a regex literal is split across lines, so the file will not parse. `\\s*` already matches a '
      + 'newline - join the lines and drop the `\\n`:\n' + offenders.join('\n')
  );
});

// The other half of the same class, caught before it can be mangled: `\s*` next to `\n` is always
// redundant, and it is exactly the construct that turns into a real line break.
test('no regex pairs \\s* with an adjacent \\n', () => {
  const offenders = [];
  for (const file of testFiles()) {
    sourceLines(file).forEach((line, index) => {
      if (isComment(line)) return;
      if (/\\s\*\\n|\\n\\s\*/u.test(line)) {
        offenders.push(`${path.basename(file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders, [],
    '`\\s*` already matches a newline; the `\\n` is redundant and is what gets mangled:\n'
      + offenders.join('\n')
  );
});
