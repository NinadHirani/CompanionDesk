'use strict';

// M2/M4 memory panel shaper tests: the pure view-model only. Status labels,
// action lists, consent/budget headers, matched terms, outcome lines.

const test = require('node:test');
const assert = require('node:assert');
const view = require('../src/memory-view');

const plain = { id: 'm1', section: 'Facts', text: 'likes filter coffee', persisted: true };
const marked = { id: 'm2', section: 'Facts', text: 'private health note', sensitive: true, persisted: true };
const sessOnly = { id: 'm3', section: 'Facts', text: 'session note', sensitive: true, persisted: false };

test('shapeItems: a plain bullet is [saved] with mark and forget actions only', () => {
  const s = view.shapeItems([plain]);
  assert.equal(s.ok, true);
  assert.deepEqual(s.lines, ['m1 [saved] Facts: likes filter coffee']);
  assert.deepEqual(s.actions, [{ id: 'm1', kind: 'mark' }, { id: 'm1', kind: 'forget' }]);
  assert.equal(s.hidden, 0);
  assert.equal(s.skipped, 0);
});

test('shapeItems: a sensitive mark on a saved bullet says the mark itself is session-only', () => {
  const s = view.shapeItems([marked]);
  assert.match(s.lines[0], /m2 \[saved\] \[sensitive\] Facts: private health note \(mark is session-only; a restart drops it\)/);
  assert.deepEqual(s.actions, [{ id: 'm2', kind: 'unmark' }, { id: 'm2', kind: 'forget' }],
    'a saved bullet offers no save attempt: the bullet is already on disk');
});

test('shapeItems: a session-only entry is labelled not saved and offers the save attempt', () => {
  const s = view.shapeItems([sessOnly]);
  assert.match(s.lines[0], /m3 \[session-only, not saved\] \[sensitive\] Facts: session note$/);
  assert.deepEqual(s.actions.map((a) => a.kind), ['unmark', 'forget', 'persist']);
});

test('shapeItems: malformed rows are skipped and counted, never rendered', () => {
  const s = view.shapeItems([plain, null, {}, { id: 'm9', section: 5, text: 'x' }]);
  assert.equal(s.lines.length, 1);
  assert.equal(s.skipped, 3);
});

test('shapeItems: bounded at MAX_ITEMS with a hidden count', () => {
  const many = [];
  for (let i = 0; i < 70; i++) many.push({ id: 'm' + i, section: 'Facts', text: 'bullet ' + i, persisted: true });
  const s = view.shapeItems(many);
  assert.equal(s.lines.length, view.MAX_ITEMS);
  assert.equal(s.hidden, 10);
});

test('shapeSearch: budget and consent lines are explicit', () => {
  const res = {
    ok: true, task: 'chat', budget: 12, requested: 12,
    candidates: 3, sensitiveTotal: 2, sensitiveIncluded: 0,
    results: [{ id: 'm1', section: 'Facts', text: 'likes filter coffee', score: 3.14159, matched: ['filter', 'coffee'] }],
  };
  const s = view.shapeSearch(res);
  assert.equal(s.ok, true);
  assert.match(s.header, /task budget: chat keeps 12/);
  assert.match(s.header, /shown 1 of 3/);
  assert.match(s.header, /2 sensitive entries hidden \(no consent for this search\)/);
  assert.match(s.lines[0], /m1 \[Facts\] likes filter coffee \(score 3\.14 — matched: filter, coffee\)/);
});

test('shapeSearch: consented sensitive entries are named as included', () => {
  const res = { ok: true, task: 'chat', budget: 12, requested: 12, candidates: 2, sensitiveTotal: 1, sensitiveIncluded: 1,
    results: [{ id: 'm2', section: 'Facts', text: 'private health note', score: 2, matched: ['health'] }] };
  const s = view.shapeSearch(res);
  assert.match(s.header, /1 sensitive entry included with consent/);
});

test('shapeSearch: no sensitive entries reads plainly', () => {
  const res = { ok: true, task: 'chat', budget: 12, requested: 12, candidates: 1, sensitiveTotal: 0, sensitiveIncluded: 0, results: [] };
  const s = view.shapeSearch(res);
  assert.match(s.header, /no sensitive entries/);
  assert.deepEqual(s.lines, []);
});

test('shapeSearch: an unavailable search shapes to a clean failure', () => {
  assert.equal(view.shapeSearch(null).ok, false);
  assert.equal(view.shapeSearch({ ok: false }).ok, false);
});

test('shapeOutcome: outcomes read as plain status lines', () => {
  assert.equal(view.shapeOutcome(null), 'memory: no response');
  assert.equal(view.shapeOutcome({ ok: true }), 'memory: done');
  assert.equal(view.shapeOutcome({ ok: true, persisted: false }), 'memory: kept session-only (not saved)');
  const refusal = view.shapeOutcome({ ok: false, error: 'sensitive_storage_blocked', detail: 'no on-disk format preserves the sensitive mark yet; the entry stays session-only' });
  assert.match(refusal, /^memory: refused \(sensitive_storage_blocked\): no on-disk format preserves the sensitive mark yet/);
  const unmark = view.shapeOutcome({ ok: false, error: 'session_only_entry', detail: 'a session-only sensitive entry stays sensitive; forget it instead' });
  assert.match(unmark, /session_only_entry/);
  assert.match(unmark, /forget it instead/);
});
