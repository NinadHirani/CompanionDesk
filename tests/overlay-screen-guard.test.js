'use strict';
// The overlay runs one ask at a time. The input and mic button already
// respect that, but the Screen button did not: during an in-flight ask it
// opened the window picker, and choosing a window silently no-oped while
// the preview claimed "Sending only this window..." with nothing sent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const ov = fs.readFileSync('renderer/overlay.js', 'utf8');

test('the Screen button refuses while an ask is in flight and says so in place', () => {
  const i = ov.indexOf("getElementById('ov-screen').addEventListener('click'");
  assert.ok(i > 0, 'the Screen click handler exists');
  const chunk = ov.slice(i, i + 800);
  assert.ok(chunk.includes('if (busy || starting)'), 'the in-flight guard runs before anything else');
  assert.ok(chunk.includes('is still answering'), 'the refusal is reported in the hint, not silently');
});
