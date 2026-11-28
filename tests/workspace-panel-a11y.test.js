'use strict';

// Accessibility pin (28 Nov 2026): every input the workspace panel builds
// carries an aria-label (search, category filter, custom-connector form,
// action forms) except the credential password field, which had only a
// placeholder. A password field without an accessible name is announced
// as an unlabelled field, and it is the one input that takes a secret.
// The accessible name must come from the same string as its placeholder,
// so the label can never drift from what the row asks for.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workspace-panel.js'), 'utf8');

test('the credential password input carries an accessible name', () => {
  const start = src.indexOf('function passwordField');
  assert.ok(start !== -1, 'passwordField helper not found');
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, 'passwordField body not delimited');
  const body = src.slice(start, end);
  assert.match(body, /setAttribute\('aria-label'/, 'passwordField must set an aria-label');
  assert.match(body, /aria-label', placeholder/, 'the aria-label must reuse the placeholder text');
});
