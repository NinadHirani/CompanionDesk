'use strict';

// M5 slice 2: the pure schedules shaper for the panel.

const test = require('node:test');
const assert = require('node:assert');
const view = require('../src/schedules-view');

const rec = (over = {}) => ({
  id: 'sch-000001',
  title: 'Call the dentist',
  scope: 'reminder',
  dueAt: 1_700_000_000_000,
  notes: null,
  createdAt: 1_699_000_000_000,
  paused: false,
  cancelled: false,
  deferredTo: null,
  firedAt: null,
  ...over,
});

test('shape: bounded lines with a local due time and state markers', () => {
  const s = view.shape([rec()]);
  assert.equal(s.ok, true);
  assert.equal(s.lines.length, 1);
  assert.match(s.lines[0], /^sch-000001 reminder: Call the dentist — due \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[active\]$/);
  assert.deepEqual(s.actions, [{ id: 'sch-000001', kind: 'pause' }, { id: 'sch-000001', kind: 'cancel' }]);
  const p = view.shape([rec({ paused: true })]);
  assert.match(p.lines[0], /\[paused\]$/);
  assert.deepEqual(p.actions.map((a) => a.kind), ['resume', 'cancel']);
  const f = view.shape([rec({ firedAt: 1_700_000_100_000 })]);
  assert.match(f.lines[0], /\[fired \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/);
  assert.deepEqual(f.actions, [], 'a fired record offers no actions');
  const c = view.shape([rec({ cancelled: true })]);
  assert.match(c.lines[0], /\[cancelled\]$/);
  assert.deepEqual(c.actions, []);
  const d = view.shape([rec({ deferredTo: 1_700_030_000_000 })]);
  assert.match(d.lines[0], /\[deferred until \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/);
  assert.deepEqual(d.actions.map((a) => a.kind), ['pause', 'cancel'], 'a deferred record can still be paused or cancelled');
});

test('shape: caps at 10, counts hidden and skipped separately', () => {
  const many = [];
  for (let i = 0; i < 14; i++) many.push(rec({ id: 'sch-' + String(i + 1).padStart(6, '0') }));
  const s = view.shape(many);
  assert.equal(s.lines.length, 10);
  assert.equal(s.hidden, 4);
  assert.equal(s.skipped, 0);
  const mixed = [...many, { bad: true }];
  const s2 = view.shape(mixed);
  assert.equal(s2.hidden, 5, 'the malformed record beyond the cap was never examined: it is hidden, not skipped');
  assert.equal(s2.skipped, 0);
  const lower = view.shape(many, { max: 2 });
  assert.equal(lower.lines.length, 2);
  assert.equal(lower.hidden, 12);
  assert.equal(view.shape(many, { max: 50 }).lines.length, 10, 'a caller may only lower the cap');
});

test('shape: hostile records are skipped, never thrown on', () => {
  assert.equal(view.shape(null).lines.length, 0);
  assert.equal(view.shape('x').lines.length, 0);
  assert.equal(view.shape([null, 1, rec({ id: 'rem-000001' }), rec({ scope: 'chore' }), rec({ dueAt: 'soon' }), rec({ extra: 1 }), rec({ paused: 'yes' })]).skipped, 7);
  const getter = rec();
  Object.defineProperty(getter, 'title', { get() { return 'boom'; } });
  assert.equal(view.shape([getter]).skipped, 1);
  const sym = rec();
  sym[Symbol('s')] = 1;
  assert.equal(view.shape([sym]).skipped, 1);
  assert.equal(view.shape([Object.create({ ...rec() })]).skipped, 1, 'exotic prototype refused');
});

test('shape: never mutates the input', () => {
  const r = rec();
  const before = JSON.stringify(r);
  view.shape([r]);
  assert.equal(JSON.stringify(r), before);
});
