'use strict';

// View switches hide sections. A keyboard user's focus can be inside the
// section that hides (the onboarding handoff is the live path: the last
// onboarding control keeps focus while UI.show('ask') hides the
// onboarding section), and a hidden element cannot hold focus: the
// browser strands it and keyboard flow is lost. show() must land focus
// on the newly shown section when the focused element was inside a
// hidden one, and never steal focus otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const s = fs.readFileSync('renderer/dom.js', 'utf8');

test('show() moves stranded focus to the newly shown section', () => {
  const showAt = s.indexOf('function show(name)');
  assert.ok(showAt > -1, 'show() found');
  const body = s.slice(showAt, s.indexOf('window.UI', showAt));
  assert.match(body, /document\.activeElement/, 'the focused element must be read');
  assert.match(body, /inHidden|hidden.*contains|contains\(active\)/, 'focus must be checked against hidden sections');
  assert.match(body, /shown\.focus\(\)|activeSection\.focus\(\)/, 'focus must land on the shown section');
  assert.match(body, /tabindex/, 'the programmatically focused section must be made focusable');
});

test('the focus fix stays inside the textContent contract', () => {
  assert.doesNotMatch(s, /\.innerHTML/, 'dom.js must keep building DOM with textContent only');
});
