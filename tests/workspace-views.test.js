'use strict';

// M8 slice 3: the pure workspace-views groundwork.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const wv = require('../src/workspace-views');

const conv = (over = {}) => ({
  id: 1,
  title: 'QAOA notes',
  created_at: '2026-11-24T09:00:00Z',
  updated_at: '2026-11-24T09:30:00Z',
  message_count: 4,
  ...over,
});

test('catalog: exactly the eleven roadmap views, fixed order, fresh copies', () => {
  const c = wv.catalog();
  assert.deepEqual(c.map(v => v.name), [
    'conversations', 'tasks', 'memory', 'tools', 'files', 'workflows',
    'settings', 'permissions', 'activity', 'models', 'integrations',
  ]);
  assert.equal(c.find(v => v.name === 'conversations').wired, true);
  assert.equal(c.find(v => v.name === 'integrations').wired, false);
  c.push({ name: 'rogue' });
  c[0].name = 'rogue';
  assert.equal(wv.catalog()[0].name, 'conversations');
  assert.equal(wv.catalog().length, 11);
});

test('resolve: one active view at a time, unknown refused', () => {
  assert.deepEqual(wv.resolve('memory'), { ok: true, view: 'memory', label: 'Memory', wired: false });
  assert.deepEqual(wv.resolve('conversations'), { ok: true, view: 'conversations', label: 'Conversations', wired: true });
  assert.equal(wv.resolve('nope').ok, false);
  assert.equal(wv.resolve('nope').reason, 'unknown_view');
  assert.equal(wv.resolve(null).reason, 'unknown_view');
  assert.equal(wv.resolve(42).reason, 'unknown_view');
});

test('shape: unwired views refuse, wired view shapes rows', () => {
  assert.equal(wv.shape('tasks', [conv()]).reason, 'view_not_wired');
  assert.equal(wv.shape('models', [conv()]).reason, 'view_not_wired');
  assert.equal(wv.shape('nope', [conv()]).reason, 'unknown_view');
  const s = wv.shape('conversations', [conv({ id: 7, title: 'Wake plan', message_count: 1 })]);
  assert.equal(s.ok, true);
  assert.equal(s.view, 'conversations');
  assert.deepEqual(s.lines, ['#7 Wake plan (1 message, updated 2026-11-24T09:30:00Z)']);
  assert.equal(s.shown, 1);
  assert.equal(s.skipped, 0);
  assert.equal(s.total, 1);
});

test('shape: empty list is ok with zero lines', () => {
  const s = wv.shape('conversations', []);
  assert.equal(s.ok, true);
  assert.deepEqual(s.lines, []);
  assert.equal(s.total, 0);
});

test('shape: records must be an array', () => {
  assert.equal(wv.shape('conversations', conv()).reason, 'bad_input');
  assert.equal(wv.shape('conversations', null).reason, 'bad_input');
  assert.equal(wv.shape('conversations', 'x').reason, 'bad_input');
});

test('shape: cap defaults to 10 and a caller may only lower it', () => {
  const rows = Array.from({ length: 14 }, (_, i) => conv({ id: i + 1 }));
  const d = wv.shape('conversations', rows);
  assert.equal(d.shown, 10);
  assert.equal(d.skipped, 4);
  assert.equal(d.lines.length, 10);
  const low = wv.shape('conversations', rows, 3);
  assert.equal(low.shown, 3);
  const wide = wv.shape('conversations', rows, 15);
  assert.equal(wide.reason, 'bad_cap');
  for (const bad of [0, -1, 2.5, '3', NaN]) {
    assert.equal(wv.shape('conversations', rows, bad).reason, 'bad_cap');
  }
});

test('shape: malformed records are skipped and counted, never thrown on', () => {
  const rows = [
    conv(),
    conv({ id: 0 }),                    // id below range
    conv({ id: 1.5 }),                  // non-integer id
    conv({ title: '' }),                // empty title ok? title only length-capped, empty allowed by schema
    conv({ message_count: -1 }),        // negative count
    conv({ extra: true }),              // unknown key
    Object.assign(Object.create(null), conv()),  // null-prototype object is allowed by the precedent
    { ...conv(), [Symbol('s')]: 1 },    // symbol key
    'not an object',
    null,
  ];
  const s = wv.shape('conversations', rows);
  assert.equal(s.ok, true);
  // exact count depends on which the schema refuses: null-prototype passes,
  // empty title passes, the rest fail.
  assert.equal(s.skipped, 7);
  assert.equal(s.shown, 3);
});

test('shape: empty title passes, long titles and stamps refuse', () => {
  const ok = wv.shape('conversations', [conv({ title: '' })]);
  assert.equal(ok.shown, 1);
  const longTitle = wv.shape('conversations', [conv({ title: 'x'.repeat(201) })]);
  assert.equal(longTitle.skipped, 1);
  const longStamp = wv.shape('conversations', [conv({ updated_at: 'x'.repeat(41) })]);
  assert.equal(longStamp.skipped, 1);
});

test('shape: accessor properties and exotic prototypes refuse', () => {
  const acc = conv();
  Object.defineProperty(acc, 'title', { get() { return 'sneaky'; } });
  assert.equal(wv.shape('conversations', [acc]).skipped, 1);
  class Fake {}
  const fake = Object.assign(new Fake(), conv());
  assert.equal(wv.shape('conversations', [fake]).skipped, 1);
  const arr = [conv()];
  arr[0] = ['nope'];
  assert.equal(wv.shape('conversations', arr).skipped, 1);
});

test('shape: inputs are never mutated', () => {
  const rows = [conv()];
  const before = JSON.stringify(rows);
  wv.shape('conversations', rows, 1);
  assert.equal(JSON.stringify(rows), before);
});

test('wiring lock: the module requires no other app module', () => {
  const src = fs.readFileSync('src/workspace-views.js', 'utf8');
  assert.match(src, /module\.exports = factory\(\)/);
  assert.doesNotMatch(src, /require\(['"]\.\//);
  assert.doesNotMatch(src, /require\(['"]\.\.\//);
  assert.doesNotMatch(src, /ipcRenderer|electron/);
});
