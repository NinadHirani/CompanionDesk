'use strict';

// The schedules panel self-mounts <section id="schedules-panel"> the same
// way agent-panel.js and memory-panel.js do. Those panels carry accessible
// names; this one had none, so the section was invisible to screen-reader
// navigation. The same defect class shows up three more times here: the
// three form fields carry at most a placeholder (placeholders are not
// labels; the datetime-local field has nothing at all), and the status
// span announces nothing because it lacks an aria-live. Source-pin: the
// panel's security contract (textContent only, no new channels) is
// unchanged; these are attributes on existing elements, no new elements,
// no behavior change.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'schedules-panel.js'), 'utf8');

test('the self-mounted schedules section carries an accessible name', () => {
  assert.match(src, /panel\.id = 'schedules-panel'/, 'the section creation not found');
  assert.match(
    src,
    /panel\.setAttribute\('aria-label',\s*'Schedules'\)/,
    'the created schedules-panel section must set an aria-label'
  );
});

test('every form field carries a programmatic label, not just a placeholder', () => {
  assert.match(
    src,
    /title\.setAttribute\('aria-label',\s*'Schedule title'\)/,
    'the title input must set an aria-label'
  );
  assert.match(
    src,
    /scope\.setAttribute\('aria-label',\s*'Scope'\)/,
    'the scope select must set an aria-label'
  );
  assert.match(
    src,
    /when\.setAttribute\('aria-label',\s*'When'\)/,
    'the datetime-local input must set an aria-label'
  );
});

test('the status span announces itself to assistive technology', () => {
  assert.match(
    src,
    /msg\.setAttribute\('aria-live',\s*'polite'\)/,
    'the schedules-msg span must be a polite live region'
  );
});

test('the a11y change stays inside the panel contract: textContent only', () => {
  assert.doesNotMatch(src, /\.innerHTML/, 'the panel must keep rendering with textContent only');
});

test('the a11y change adds no new channel, method or event surface', () => {
  const before = src.match(/addEventListener\('click'/g);
  assert.ok(before, 'expected click listeners to exist');
  assert.equal(before.length, 3, 'the sweep must not add event listeners (create, stop-editing, action buttons)');
  assert.match(src, /const METHODS = \['schedules_list', 'schedules_create', 'schedules_update', 'schedules_pause', 'schedules_resume', 'schedules_cancel'\];/, 'the product channel set is unchanged');
});
