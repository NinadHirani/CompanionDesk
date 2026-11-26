'use strict';

// Structural guard for the memory panel, in the schedules-panel-guard
// pattern: the panel may only use the six memory channels, renders with
// textContent only, never requires Node modules, and the per-search consent
// control defaults to off (fail closed).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const s = fs.readFileSync('renderer/memory-panel.js', 'utf8');

test('the memory panel uses only the six memory channels', () => {
  const used = [...new Set([...s.matchAll(/a\.(memory_[a-z_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ['memory_add', 'memory_forget', 'memory_items', 'memory_mark', 'memory_persist', 'memory_search']);
});

test('the memory panel never writes markup and never requires Node modules', () => {
  assert.ok(!s.includes('innerHTML'), 'textContent only');
  assert.ok(!s.includes('require('), 'renderer purity');
  assert.ok(!s.includes('eval('), 'no dynamic code');
});

test('the per-search consent control defaults to off', () => {
  const i = s.indexOf('memory-search-consent');
  assert.ok(i > 0, 'the consent checkbox exists');
  const chunk = s.slice(i, i + 400);
  assert.ok(!/\.checked\s*=\s*true|checked=|checked: true|"checked"/.test(chunk), 'no default-on consent anywhere in the control');
});

test('actions and status are labelled for screen readers', () => {
  assert.ok(s.includes('aria-label'), 'buttons carry aria-labels');
  assert.ok(s.includes('aria-live'), 'the status region announces outcomes');
  assert.ok(s.includes('role'), 'the panel is a labelled region');
});
