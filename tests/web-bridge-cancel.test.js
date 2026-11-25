'use strict';
// A file picker the user cancels must settle, not hang. The browser fires a
// 'cancel' event on the hidden input when the picker is dismissed; both web
// pickers (syllabus files, calendar .ics) must listen for it and resolve, or
// the syllabus import sits at "Importing" forever and the calendar import
// dies silently.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'web', 'bridge.js'), 'utf8');

for (const fn of ['function pickFiles()', 'function pickIcsFile()']) {
  test(`a cancelled file picker resolves (${fn})`, () => {
    const at = src.indexOf(fn);
    assert.ok(at !== -1, `${fn} exists`);
    const chunk = src.slice(at, at + 900);
    assert.ok(
      chunk.includes("addEventListener('cancel'"),
      `${fn} must listen for the browser's cancel event`
    );
  });
}
