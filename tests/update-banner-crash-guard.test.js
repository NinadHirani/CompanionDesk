'use strict';
// The update banner's four action calls are fired and forgotten: a bridge
// or transport crash on a click is an unhandled rejection and a silent
// no-op. The main process reports its own failures as error states, but a
// crashed renderer-side call reaches it never. Every other ask path in the
// app reports in place; the banner must too.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const s = fs.readFileSync('renderer/update.js', 'utf8');

test('every action click is caught, and a crash reports in place', () => {
  const i = s.indexOf('function run(');
  assert.ok(i > 0, 'run exists');
  const end = s.indexOf('function ', i + 1);
  const chunk = s.slice(i, end);
  const bare = chunk.replace(/'/g, '');
  for (const kind of ['install', 'download', 'open-download-page', 'check']) {
    assert.ok(bare.includes(`${kind}:`), `the ${kind} action is still dispatched`);
  }
  assert.ok(chunk.includes('catch'), 'a thrown bridge error is caught, not an unhandled rejection');
  assert.ok(chunk.includes("bar.hidden = false"), 'the banner stays visible to show the failure');
  assert.ok(chunk.includes("'update-bar error'"), 'the failure renders with the error class');
  const catchAt = chunk.indexOf('.catch(');
  assert.ok(chunk.indexOf('Try again', catchAt) > catchAt, 'the failed action stays offered as a retry');
});
