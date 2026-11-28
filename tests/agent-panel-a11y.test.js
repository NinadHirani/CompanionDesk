'use strict';

// The agent status panel self-mounts a <section id="agent-status"> into
// every app load (agent-panel.js runs from index.html and appends the
// section to document.body when absent). A landmark section without an
// accessible name is invisible to screen-reader navigation, so the
// created section must carry an aria-label. Source-pin: the panel's
// security contract (textContent only, no new channels) is unchanged.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'agent-panel.js'), 'utf8');

test('the self-mounted agent status section carries an accessible name', () => {
  assert.match(src, /panel\.id = 'agent-status'/, 'the section creation not found');
  assert.match(
    src,
    /panel\.setAttribute\('aria-label',\s*'Agent status'\)/,
    'the created agent-status section must set an aria-label'
  );
});

test('the a11y change stays inside the panel contract: textContent only', () => {
  assert.doesNotMatch(src, /\.innerHTML/, 'the panel must keep rendering with textContent only');
});
