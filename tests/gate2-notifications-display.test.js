'use strict';
// Gate 2 delivery display store (blueprint 3j.3): proves the main-owned,
// in-memory display store is strictly separate from the persisted
// notification desk, refuses hostile input, keeps bounded deterministic
// retention, survives duplicate delivery, cannot be mutated through
// returned references, closes fail-closed, and reaches the renderer only
// through the EXISTING notifications:read channel as an additive display
// section, with no ack/markRead semantics and no new privileged IPC.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createNotificationsDisplayStore, MAX_RECORDS } = require('../src/agent-notifications-display');
const { createNotificationDesk } = require('../src/agent-notifications');
const { createAgentSurface } = require('../src/agent-surface.js');
const { RENDERER_CHANNELS } = require('../src/ipc-contract.js');
const view = require('../src/agent-notifications-view');

function rec(i, over = {}) {
  return Object.assign({
    id: 'ntf-' + String(i).padStart(6, '0'),
    title: 'T' + i,
    body: 'B' + i,
    priority: 'normal',
    createdAt: 1000 + i,
  }, over);
}

function readers(store, over = {}) {
  return Object.assign({
    status: () => ({ agentActive: true, stopped: false, activeRun: null, notificationsPending: 0, remindersScheduled: 0, auditEntries: 0 }),
    listRuns: () => [],
    readAudit: () => ({ base: { seq: 0, hash: null }, entries: [], lastHash: null, verified: true }),
    listProviders: () => [],
    listNotifications: () => [],
    listReminders: () => [],
    listDisplayNotifications: (limit) => store.list(limit),
  }, over);
}

test('display store: valid records append in insertion order and list oldest first', () => {
  const st = createNotificationsDisplayStore();
  assert.equal(st.append(rec(1)).accepted, true);
  assert.equal(st.append(rec(2)).accepted, true);
  assert.equal(st.size(), 2);
  const listed = st.list();
  assert.equal(listed[0].id, 'ntf-000001');
  assert.equal(listed[1].id, 'ntf-000002');
  assert.equal(MAX_RECORDS, 50);
});

test('display store: hostile and malformed input is refused with a reason, never thrown on', () => {
  const st = createNotificationsDisplayStore();
  const hostile = [
    null, 42, 'record', [], () => {},
    Object.create({ inherited: true }, { id: { value: 'ntf-000001', enumerable: true } }),
    Object.assign(rec(1), { apiKey: 'sk-secret' }),
    Object.assign(rec(1), { internal: 'meta' }),
    (() => { const r = rec(1); r[Symbol('s')] = 'x'; return r; })(),
    Object.defineProperty(rec(1), 'title', { get() { return 'T'; } }),
    Object.defineProperty({}, '__proto__', { value: rec(1), enumerable: true }),
    rec(1, { id: 'X' }), rec(1, { id: 7 }), rec(1, { priority: 'urgent' }),
    rec(1, { createdAt: 'not-a-number' }), rec(1, { createdAt: NaN }),
    rec(1, { title: '' }), rec(1, { title: 'x'.repeat(201) }), rec(1, { body: 'y'.repeat(501) }),
    rec(1, { read: false }), // read is a DESK field: the display store refuses it
  ];
  for (const h of hostile) {
    const out = st.append(h);
    assert.equal(out.accepted, false, 'must refuse ' + JSON.stringify(typeof h));
    assert.equal(out.reason, 'invalid_record');
  }
  assert.equal(st.size(), 0);
});

test('display store: duplicate ids are ignored and the first record stands', () => {
  const st = createNotificationsDisplayStore();
  st.append(rec(1, { title: 'first' }));
  const dup = st.append(rec(1, { title: 'second' }));
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'duplicate_id');
  assert.equal(st.size(), 1);
  assert.equal(st.list()[0].title, 'first');
});

test('display store: capacity is bounded with deterministic FIFO eviction', () => {
  const st = createNotificationsDisplayStore();
  for (let i = 1; i <= MAX_RECORDS + 10; i++) {
    const out = st.append(rec(i));
    assert.equal(out.accepted, true);
  }
  assert.equal(st.size(), MAX_RECORDS);
  const listed = st.list();
  assert.equal(listed[0].id, 'ntf-000011'); // oldest eleven evicted
  assert.equal(listed[MAX_RECORDS - 1].id, 'ntf-000060'); // newest retained
});

test('display store: returned list entries are fresh copies; mutation cannot reach the store', () => {
  const st = createNotificationsDisplayStore();
  st.append(rec(1));
  const listed = st.list();
  assert.notEqual(listed[0], st.list()[0]);
  listed.push({ id: 'ntf-999999', title: 'x', body: 'y', priority: 'low', createdAt: 1 });
  listed[0].title = 'HACKED';
  listed[0].apiKey = 'leak';
  assert.equal(st.size(), 1);
  assert.equal(st.list()[0].title, 'T1');
  assert.equal(st.list()[0].apiKey, undefined);
});

test('display store: list bounds and limit handling', () => {
  const st = createNotificationsDisplayStore();
  for (let i = 1; i <= 10; i++) st.append(rec(i));
  assert.equal(st.list(5).length, 5);
  assert.equal(st.list(5)[0].id, 'ntf-000001'); // oldest first even when bounded
  assert.equal(st.list(0).length, 10);
  assert.equal(st.list(-1).length, 10);
  assert.equal(st.list('x').length, 10);
  assert.equal(st.list(1000).length, 10);
});

test('display store: close() is explicit lifecycle and fails closed for appends', () => {
  const st = createNotificationsDisplayStore();
  st.append(rec(1));
  const closed = st.close();
  assert.equal(closed.ok, true);
  assert.equal(st.isClosed(), true);
  const after = st.append(rec(2));
  assert.equal(after.ok, false);
  assert.equal(after.reason, 'closed');
  assert.equal(st.size(), 1); // snapshot preserved, readable
  assert.equal(st.list().length, 1);
  st.close(); // idempotent
  assert.equal(st.isClosed(), true);
});

test('display store: carries no read semantics and exports no write surface', () => {
  const st = createNotificationsDisplayStore();
  st.append(rec(1));
  assert.equal('read' in st.list()[0], false);
  assert.equal(st.list()[0].markRead, undefined);
  const mod = require('../src/agent-notifications-display');
  for (const key of Object.keys(mod)) {
    assert.equal(['createNotificationsDisplayStore', 'MAX_RECORDS'].includes(key), true, 'unexpected export ' + key);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent-notifications-display.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const banned of ['markRead', 'acknowledg', 'ipcMain', 'ipcRenderer', 'writeFile', 'appendFile', 'setTimeout', 'setInterval', 'fetch(', 'require(\'electron']) {
    assert.equal(src.includes(banned), false, 'display store must not contain ' + banned);
  }
});

test('display store: fuzzing never throws', () => {
  const st = createNotificationsDisplayStore();
  const nasty = [undefined, NaN, Infinity, -0, new Date(), /re/, new Map(), new Set(), Buffer.alloc(4), { length: 3 }, Proxy, Reflect, JSON, Math, Symbol('x'), 1n];
  for (const n of nasty) {
    assert.doesNotThrow(() => st.append(n));
  }
  assert.equal(st.size(), 0);
});

test('isolation: the display store and the persisted desk never touch each other', () => {
  const desk = createNotificationDesk({ clock: () => 1000 });
  const st = createNotificationsDisplayStore();
  assert.equal(desk.create({ title: 'desk note', body: 'body', priority: 'normal' }).ok, true);
  st.append(rec(1, { title: 'display note' }));
  // store appends leave the desk untouched, including its read flags
  const deskList = desk.list();
  assert.equal(deskList.length, 1);
  assert.equal(deskList[0].read, false);
  assert.equal(deskList[0].title, 'desk note');
  // desk records never appear in the store and vice versa
  assert.equal(st.list().length, 1);
  assert.equal(st.list()[0].title, 'display note');
  assert.equal(desk.list().some((r) => r.title === 'display note'), false);
  assert.equal(st.list().some((r) => r.title === 'desk note'), false);
});

test('agent surface: the display reader is required (fail closed)', () => {
  const base = readers(createNotificationsDisplayStore());
  delete base.listDisplayNotifications;
  assert.throws(() => createAgentSurface(base), TypeError);
});

test('agent surface: notifications:read carries both sections, display bounded and clipped', async () => {
  const st = createNotificationsDisplayStore();
  for (let i = 1; i <= 30; i++) st.append(rec(i, { body: 'z'.repeat(400) }));
  const s = createAgentSurface(readers(st));
  const out = await s.handlers['notifications:read']({ limit: 20 });
  assert.equal(out.ok, true);
  assert.equal(Array.isArray(out.data.notifications), true);
  assert.equal(out.data.display.length, 20); // bounded by the request limit
  assert.equal(out.data.display[0].id, 'ntf-000001'); // oldest first on the wire
  assert.ok(out.data.display[0].body.length <= 200); // boundedRecords clipped
});

test('agent surface: reading twice never mutates the store', () => {
  const st = createNotificationsDisplayStore();
  st.append(rec(1));
  const s = createAgentSurface(readers(st));
  s.handlers['notifications:read']({ limit: 20 });
  s.handlers['notifications:read']({ limit: 20 });
  assert.equal(st.size(), 1);
  assert.equal(st.isClosed(), false);
});

test('ipc contract: the channel set is unchanged and display is not a channel', () => {
  assert.deepEqual(RENDERER_CHANNELS, ['status:get', 'runs:get', 'audit:read', 'providers:get', 'notifications:read', 'reminders:read']);
});

test('main wiring: the store is created in main, exposed read-only, and closed at quit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(src.includes("require('./agent-notifications-display')"));
  assert.ok(src.includes('const notificationsDisplay = createNotificationsDisplayStore()'));
  assert.ok(src.includes('listDisplayNotifications: (limit) => notificationsDisplay.list(limit)'));
  assert.ok(src.includes('notificationsDisplay.close()'));
  // main must not grow any write path toward the store or the desk here
  assert.equal(src.includes('notificationsDisplay.append'), false);
});

test('renderer panel: the display section is read-only presentation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'agent-panel.js'), 'utf8');
  assert.ok(src.includes('notifications.data.display'));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const banned of ['markRead', 'acknowledg', 'invoke', 'send(']) {
    assert.equal(code.includes(banned), false, 'panel code must not reference ' + banned);
  }
});

test('end to end: store to surface to renderer shaping renders display records and never the desk', async () => {
  const desk = createNotificationDesk({ clock: () => 1000 });
  desk.create({ title: 'desk note', body: 'desk body', priority: 'normal' });
  const st = createNotificationsDisplayStore();
  st.append(rec(1, { title: 'display note', body: 'display body', priority: 'high' }));
  const s = createAgentSurface(readers(st, { listNotifications: () => desk.list() }));
  const out = await s.handlers['notifications:read']({ limit: 20 });
  // the desk section still carries its own read field, untouched
  assert.equal(out.data.notifications[0].read, false);
  // the display section renders without any (read) marker
  const shaped = view.shape(out.data.display);
  assert.equal(shaped.ok, true);
  assert.equal(shaped.shown, 1);
  assert.ok(shaped.lines[0].includes('[high] display note'));
  assert.ok(shaped.lines[0].includes('(read)') === false);
  // mixed shaping: desk and display records both render, marker only on desk
  const mixed = view.shape(out.data.notifications.concat(out.data.display));
  assert.equal(mixed.shown, 2);
  // the desk note is UNREAD at this point, so neither line carries a marker
  assert.ok(mixed.lines.some((l) => l.includes('desk note') && !l.includes('(read)')));
  assert.ok(mixed.lines.some((l) => l.includes('display note') && !l.includes('(read)')));
  // nothing anywhere flipped the desk: its fresh note is still unread
  assert.equal(desk.list()[0].read, false);
  // marking the DESK note read (the desk's own API, called directly in
  // this test) shows its marker, while the display record still claims
  // nothing: the two sections' read semantics stay separate
  assert.equal(desk.markRead(desk.list()[0].id).ok, true);
  const after = await s.handlers['notifications:read']({ limit: 20 });
  const reshaped = view.shape(after.data.notifications.concat(after.data.display));
  assert.ok(reshaped.lines.some((l) => l.includes('(read) desk note')));
  assert.ok(reshaped.lines.some((l) => l.includes('display note') && !l.includes('(read)')));
  assert.equal(after.data.display[0].read, undefined);
});
