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

test('catalog: exactly the thirteen roadmap views, fixed order, fresh copies', () => {
  const c = wv.catalog();
  assert.deepEqual(c.map(v => v.name), [
    'conversations', 'tasks', 'memory', 'tools', 'files', 'databases',
    'appdata', 'workflows', 'settings', 'permissions', 'activity',
    'models', 'integrations',
  ]);
  assert.equal(c.find(v => v.name === 'conversations').wired, true);
  assert.equal(c.find(v => v.name === 'integrations').wired, true);
  for (const n of ['tasks', 'memory', 'tools', 'permissions', 'activity']) {
    assert.equal(c.find(v => v.name === n).wired, true);
  }
  for (const n of ['files', 'databases', 'appdata', 'workflows', 'settings', 'models']) {
    assert.equal(c.find(v => v.name === n).wired, false);
  }
  c.push({ name: 'rogue' });
  c[0].name = 'rogue';
  assert.equal(wv.catalog()[0].name, 'conversations');
  assert.equal(wv.catalog().length, 13);
});

test('resolve: one active view at a time, unknown refused', () => {
  assert.deepEqual(wv.resolve('memory'), { ok: true, view: 'memory', label: 'Memory', wired: true });
  assert.deepEqual(wv.resolve('tasks'), { ok: true, view: 'tasks', label: 'Tasks', wired: true });
  assert.deepEqual(wv.resolve('models'), { ok: true, view: 'models', label: 'Models', wired: false });
  assert.deepEqual(wv.resolve('conversations'), { ok: true, view: 'conversations', label: 'Conversations', wired: true });
  assert.equal(wv.resolve('nope').ok, false);
  assert.equal(wv.resolve('nope').reason, 'unknown_view');
  assert.equal(wv.resolve(null).reason, 'unknown_view');
  assert.equal(wv.resolve(42).reason, 'unknown_view');
});

test('shape: unwired views refuse, wired view shapes rows', () => {
  for (const n of ['files', 'workflows', 'settings', 'models']) {
    assert.equal(wv.shape(n, [conv()]).reason, 'view_not_wired');
  }
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

// --- M8 schemas-first (approved 26 Nov 2026): the six newly wired schemas ---
// Each schema mirrors one owning module's rows exactly, outside every
// closed file: tasks <- agent-reminders, memory <- memory-session.items()
// (sensitive-flagged rows skip), tools <- tool-registry.list(),
// permissions <- device-access.list(), activity <- audit-log entries,
// integrations <- integrations.js list().

const remRow = (over = {}) => ({
  id: 'rem-000001',
  title: 'Buy oat milk',
  dueAt: 1795767600000,
  notes: null,
  createdAt: 1795737600000,
  cancelled: false,
  ...over,
});

test('tasks view: agent-reminders rows shape, malformed rows skip', () => {
  const s = wv.shape('tasks', [remRow()]);
  assert.equal(s.ok, true);
  assert.deepEqual(s.lines, ['#rem-000001 Buy oat milk (due 2026-11-27T08:20:00.000Z, active)']);
  assert.deepEqual(s.shown, 1);
  const c = wv.shape('tasks', [remRow({ id: 'rem-000002', cancelled: true })]);
  assert.deepEqual(c.lines, ['#rem-000002 Buy oat milk (due 2026-11-27T08:20:00.000Z, cancelled)']);
  const bad = [
    remRow({ id: 'rem-1' }),
    remRow({ dueAt: 'soon' }),
    remRow({ notes: 5 }),
    remRow({ cancelled: 'no' }),
    remRow({ extra: 1 }),
    { id: 'rem-000003', title: 'x', dueAt: 1, notes: null, createdAt: 2 }, // missing cancelled
  ];
  const r = wv.shape('tasks', bad);
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 0);
  assert.equal(r.skipped, bad.length);
});

test('memory view: memory-store rows shape; sensitive-flagged rows skip', () => {
  const s = wv.shape('memory', [{ id: 'm3', section: 'Preferences', text: 'Likes filter coffee' }]);
  assert.equal(s.ok, true);
  assert.deepEqual(s.lines, ['#m3 Preferences: Likes filter coffee']);
  // A row carrying the session-only sensitive flag carries an unknown
  // field: skipped and counted until M4 defines the workspace treatment.
  const r = wv.shape('memory', [
    { id: 'm4', section: 'Facts', text: 'key detail', sensitive: true },
    { id: 'm5', section: 'Facts', text: 'plain detail' },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, ['#m5 Facts: plain detail']);
  assert.equal(r.skipped, 1);
  const bad = [{ id: 'x1', section: 'Facts', text: 't' }, { id: 'm6', section: '', text: 't' }];
  assert.equal(wv.shape('memory', bad).skipped, bad.length);
});

const toolDef = (over = {}) => ({
  name: 'calendar_upcoming',
  description: 'Read-only upcoming calendar projection.',
  capability: 'read_only',
  schema: { type: 'object', properties: {} },
  ...over,
});

test('tools view: tool-registry definition rows; critical optional', () => {
  const s = wv.shape('tools', [toolDef()]);
  assert.deepEqual(s.lines, ['calendar_upcoming (read_only)']);
  const c = wv.shape('tools', [toolDef({ name: 'schedule_create', capability: 'sensitive', critical: true })]);
  assert.deepEqual(c.lines, ['schedule_create (sensitive, critical)']);
  const bad = [toolDef({ schema: [] }), toolDef({ extra: 1 }), toolDef({ name: '' }), toolDef({ critical: 'yes' })];
  const r = wv.shape('tools', bad);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, bad.length);
});

const grantRow = (over = {}) => Object.freeze({
  appId: 'com.example.notes',
  capability: 'clipboard.read',
  scopes: ['notes.local'],
  grantedAt: 1795737600000,
  ...over,
});

test('permissions view: device-access grant rows shape', () => {
  const s = wv.shape('permissions', [grantRow()]);
  assert.deepEqual(s.lines, ['com.example.notes: clipboard.read (1 scope)']);
  const two = wv.shape('permissions', [grantRow({ scopes: ['notes.local', 'notes.export'] })]);
  assert.deepEqual(two.lines, ['com.example.notes: clipboard.read (2 scopes)']);
  const bad = [grantRow({ scopes: [] }), grantRow({ grantedAt: 'yesterday' }), grantRow({ scopes: [5] }), grantRow({ appId: '' })];
  const r = wv.shape('permissions', bad);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, bad.length);
});

const auditRow = (over = {}) => Object.freeze({
  at: '2026-11-26T10:00:00.000Z',
  actor: 'agent',
  action: 'schedule.create',
  seq: 12,
  hash: 'a'.repeat(64),
  ...over,
});

test('activity view: audit-log entries shape; unknown payload keys refuse', () => {
  const s = wv.shape('activity', [auditRow({ tool: 'schedule_create', decision: 'allowed', detail: { schedule_id: 3 } })]);
  assert.deepEqual(s.lines, ['agent schedule.create allowed']);
  const bare = wv.shape('activity', [auditRow()]);
  assert.deepEqual(bare.lines, ['agent schedule.create']);
  const f = wv.shape('activity', [auditRow({ action: 'file.write', decision: 'allowed', detail: { name: 'a.txt', bytes: 12 } })]);
  assert.deepEqual(f.lines, ['agent file.write allowed']);
  const bad = [
    auditRow({ actor: 'robot' }),
    auditRow({ action: 'SCHEDULE.CREATE' }),
    auditRow({ extra: true }),
    auditRow({ detail: [] }),
    auditRow({ seq: '12' }),
  ];
  const r = wv.shape('activity', bad);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, bad.length);
});

const integRow = (over = {}) => Object.freeze({
  id: 'notes-sync',
  name: 'Notes Sync',
  version: '1.2.3',
  declaredScopes: ['contacts.read'],
  connected: false,
  revoked: false,
  grantedScopes: [],
  consentedAt: null,
  ...over,
});

test('integrations view: integrations.js list rows shape', () => {
  const s = wv.shape('integrations', [integRow()]);
  assert.deepEqual(s.lines, ['notes-sync Notes Sync 1.2.3 (registered)']);
  const c = wv.shape('integrations', [integRow({ connected: true, grantedScopes: ['contacts.read'], consentedAt: 1795737600000 })]);
  assert.deepEqual(c.lines, ['notes-sync Notes Sync 1.2.3 (connected)']);
  const rv = wv.shape('integrations', [integRow({ revoked: true })]);
  assert.deepEqual(rv.lines, ['notes-sync Notes Sync 1.2.3 (revoked)']);
  const bad = [integRow({ version: 'x' }), integRow({ consentedAt: 'now' }), integRow({ declaredScopes: 'contacts.read' })];
  const r = wv.shape('integrations', bad);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, bad.length);
});
