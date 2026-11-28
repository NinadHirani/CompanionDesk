'use strict';

// Live-region pin (28 Nov 2026): the update banner renders pushed state
// changes (update available, download progress, errors) asynchronously;
// without a live region a screen reader never announces them, because
// focus sits elsewhere when the text changes. role="status" on the
// banner's text element gives the changes implicit polite-live semantics
// (announced without stealing focus), matching the repo's other a11y
// slices (agent-panel aria-label, credential-field accessible name).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'update.js'), 'utf8');

test('the update banner text is a live region', () => {
  assert.match(src, /text\.setAttribute\('role', 'status'\)/, 'the update text element must carry role="status"');
});
