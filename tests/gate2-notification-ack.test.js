'use strict';

// Gate 2 delivery gate, slice 3j.5: the acknowledgement gate (blueprint
// 3j.4 option C, the user's decision of 24 Nov 2026). The renderer's ONE
// non-read capability is an id-only notifications:ack REQUEST driven by an
// explicit per-record user gesture. Rendering, listing, opening the panel,
// polling, focus, visibility and receiving NEVER acknowledge anything.
// These tests prove, adversarially:
//   - the persistence layer records the acknowledgement durably BEFORE the
//     desk flips (log-before-commit), and a durability failure preserves
//     the unread state with no silent fallback;
//   - replays are idempotent and never create a second audit entry;
//   - unknown, stale and malformed ids are refused with nothing changed;
//   - acknowledgement state stays OUT of the display store, and the
//     persisted desk's existing read flag is the only canonical state;
//   - the surface handler accepts nothing but a well-formed id and reports
//     only bounded plain data; renderer claims are never trusted;
//   - a restart reopens from the persisted read flag with the audit chain
//     intact, and a failed save reports honestly instead of claiming.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LocalDb = require('../src/db');
const { createRegistry } = require('../src/tool-registry');
const { createPolicyEngine } = require('../src/policy-engine');
const { createApprovalDesk } = require('../src/approval');
const { createAuditLog } = require('../src/audit');
const { createEmergencyStop } = require('../src/emergency-stop');
const { createNotificationDesk } = require('../src/agent-notifications');
const { createReminderBook } = require('../src/agent-reminders');
const { createAgentPersistence } = require('../src/agent-persistence');
const { createAgentSurface } = require('../src/agent-surface.js');
const { createNotificationsDisplayStore } = require('../src/agent-notifications-display');
const { createAgentStack } = require('../src/agent-runtime');

const NOW = 1_700_000_000_000;

function fixtures() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 } } } });
  return registry;
}

// A full world with a notifications desk, exactly like the app builds it.
async function world({ savedBytes } = {}) {
  const state = { bytes: savedBytes === undefined ? null : savedBytes, now: NOW };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const clock = () => state.now;
  const registry = fixtures();
  const audit = createAuditLog({ clock });
  const approvals = createApprovalDesk({ clock });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock });
  const notifications = createNotificationDesk({ clock });
  const reminders = createReminderBook({ clock });
  const p = createAgentPersistence({ db, clock, registry, audit, approvals, engine, emergencyStop: stop, notifications, reminders });
  return { db, storage, saved: state, state, audit, approvals, stop, engine, notifications, reminders, p };
}

function seeded(w) {
  const c = w.notifications.create({ title: 'title one', body: 'body one', priority: 'normal' });
  assert.equal(c.ok, true);
  return c.notification.id;
}

test('ack: the app-built stack exposes the writer and the read flag is the only canonical state', async () => {
  const storage = { load: async () => null, save: async (b) => { saved.bytes = b; } };
  const saved = { bytes: null };
  const state = { bytes: null, now: NOW };
  storage.save = async (b) => { state.bytes = b; };
  storage.load = async () => state.bytes;
  const db = await LocalDb.open({ storage });
  const stack = createAgentStack({ db, clock: () => NOW });
  assert.equal(typeof stack.persistence.acknowledgeNotification, 'function');
  const id = stack.notifications.create({ title: 't', body: 'b' }).notification.id;
  const before = stack.persistence.acknowledgeNotification(id);
  assert.equal(before.ok, true);
  // The read flag lives on the desk record only: exportAll shows it, and
  // no parallel ack ledger exists anywhere in the persistence surface.
  const rec = stack.notifications.exportAll().find((r) => r.id === id);
  assert.equal(rec.read, true);
  const exported = Object.keys(stack.persistence);
  for (const k of exported) assert.equal(/ackledger|ackstate/i.test(k), false, k);
});

test('ack: happy path records the acknowledgement durably before the desk flips, then converges the row', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const id = seeded(w);
  const res = w.p.acknowledgeNotification(id);
  assert.equal(res.ok, true);
  assert.equal(res.idempotent, false);
  assert.equal(res.persisted, true);
  // The audit entry exists, is the user's gesture, and carries ONLY the id.
  const snap = w.audit.snapshot();
  const entry = snap.entries[snap.entries.length - 1];
  assert.equal(entry.actor, 'user');
  assert.equal(entry.action, 'notification.acknowledge');
  assert.deepEqual(Object.keys(entry.detail), ['notification_id']);
  assert.equal(entry.detail.notification_id, id);
  assert.equal('title' in entry.detail, false);
  assert.equal('body' in entry.detail, false);
  assert.equal(w.audit.verify().ok, true);
  // The desk is read and the persisted row agrees after load from bytes.
  assert.equal(w.notifications.exportAll().find((r) => r.id === id).read, true);
  w.db.flush();
  const w2 = await world({ savedBytes: w.saved.bytes });
  const loaded = w2.p.load();
  assert.equal(loaded.ok, true);
  assert.equal(w2.notifications.exportAll().find((r) => r.id === id).read, true);
  assert.equal(w2.audit.verify().ok, true);
});

test('ack: a replay is idempotent and never appends a second audit entry', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const id = seeded(w);
  assert.equal(w.p.acknowledgeNotification(id).ok, true);
  const count = w.audit.snapshot().entries.length;
  const res = w.p.acknowledgeNotification(id);
  assert.equal(res.ok, true);
  assert.equal(res.idempotent, true);
  assert.equal(w.audit.snapshot().entries.length, count, 'no misleading duplicate audit entry');
  assert.equal(w.audit.verify().ok, true);
});

test('ack: unknown, stale and malformed ids are refused with nothing changed', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const id = seeded(w);
  const before = w.audit.snapshot().entries.length;
  const badIds = [
    'ntf-999999', // never existed
    'ntf-000002', // a future id (stale/unknown to this desk)
    'rem-000001', // another desk's id shape
    'ntf-00000x',
    'NTF-000001',
    'ntf-1',
    'ntf-0000011', // seven digits
    'x'.repeat(64),
    '',
    null,
    undefined,
    42,
    { id: 'ntf-000001' },
    ['ntf-000001'],
    (() => { const s = Symbol('x'); return s; })(),
  ];
  for (const bad of badIds) {
    const r = w.p.acknowledgeNotification(bad);
    assert.equal(r.ok, false, 'refused: ' + String(bad));
    assert.equal(typeof r.reason, 'string');
  }
  // Nothing changed anywhere.
  assert.equal(w.audit.snapshot().entries.length, before, 'no audit entry for a refused ack');
  assert.equal(w.notifications.exportAll().find((r) => r.id === id).read, false, 'still unread');
});

test('ack: a durability failure preserves the unread state with no silent fallback', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const id = seeded(w);
  const before = w.audit.snapshot().entries.length;
  // Break ONLY the file flush: the transaction may commit, but the append
  // never became durable, so the wrapper must roll it back and the ack
  // must refuse with the desk still unread.
  const realFlush = w.db.flush.bind(w.db);
  let broken = false;
  w.db.flush = function () { if (broken) throw new Error('simulated flush failure'); return realFlush(); };
  broken = true;
  const res = w.p.acknowledgeNotification(id);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'audit_not_durable');
  assert.equal(w.audit.snapshot().entries.length, before, 'the unacknowledged append left the log');
  assert.equal(w.audit.verify().ok, true);
  assert.equal(w.notifications.exportAll().find((r) => r.id === id).read, false, 'still unread');
  // Repair the flush: the SAME record can be acknowledged for real.
  broken = false;
  const ok = w.p.acknowledgeNotification(id);
  assert.equal(ok.ok, true);
  assert.equal(ok.persisted, true);
  assert.equal(w.notifications.exportAll().find((r) => r.id === id).read, true);
});

test('ack: a failed save reports honestly and never claims convergence', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const id = seeded(w);
  const realFlush = w.db.flush.bind(w.db);
  let broken = false;
  w.db.flush = function () { if (broken) throw new Error('simulated flush failure'); return realFlush(); };
  // Pre-seed one durable audit entry so the ack append is not the first
  // thing the broken flush touches: the ack's own append must succeed
  // (it flushes before the desk flips), so break the flush only AFTER
  // one acknowledged append.
  const seed = w.p.appendAudit({ actor: 'system', action: 'fixture.note', decision: 'allowed' });
  assert.equal(seed.ok, true);
  broken = true;
  const res = w.p.acknowledgeNotification(id);
  // The durable append succeeded (flushed), the desk flipped, but the
  // desk-row save could not converge: report persisted:false, never a
  // silent success.
  if (res.ok === true) {
    assert.equal(res.persisted, false);
  } else {
    // appendAudit failed first (its flush broke): desk must be unread.
    assert.equal(res.reason, 'audit_not_durable');
    assert.equal(w.notifications.exportAll().find((r) => r.id === id).read, false);
  }
  // Either way the desk state and the audit chain agree and verify.
  assert.equal(w.audit.verify().ok, true);
});

test('ack: integrity failure refuses fail-closed', async () => {
  // A valid persisted world, then a tampered row INSIDE the database image
  // (the stored chain hash no longer matches its entry): load() must fail
  // closed and every later ack must refuse with nothing changed.
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const id = seeded(w);
  assert.equal(w.p.acknowledgeNotification(id).ok, true);
  w.db.flush();
  const w2 = await world({ savedBytes: w.saved.bytes });
  // Break the persisted chain before load(): rewrite one stored hash.
  w2.db.run("UPDATE agent_audit SET hash = 'aaaa' || substr(hash, 5) WHERE seq = (SELECT MAX(seq) FROM agent_audit)");
  const loaded = w2.p.load();
  assert.equal(loaded.ok, false, 'the tampered chain must fail closed');
  assert.equal(w2.p.status().ok, false);
  const before = w2.audit.snapshot().entries.length;
  // Even a well-formed, previously known id is refused: integrity gates
  // every write, no matter what the request asks for.
  const r = w2.p.acknowledgeNotification(id);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'integrity_failure');
  assert.equal(w2.audit.snapshot().entries.length, before, 'no audit entry under integrity failure');
  assert.equal(w2.notifications.exportAll().find((x) => x && x.id === id) === undefined, true, 'the desk never hydrated');
});

test('ack: restart idempotency, an acked record stays read and replays add no audit entry', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const id = seeded(w);
  assert.equal(w.p.acknowledgeNotification(id).ok, true);
  w.db.flush();
  const w2 = await world({ savedBytes: w.saved.bytes });
  const loaded = w2.p.load();
  assert.equal(loaded.ok, true);
  const entriesAfterLoad = w2.audit.snapshot().entries.length;
  const res = w2.p.acknowledgeNotification(id);
  assert.equal(res.ok, true);
  assert.equal(res.idempotent, true);
  assert.equal(w2.audit.snapshot().entries.length, entriesAfterLoad, 'replay across restart adds no audit entry');
});

test('ack: the desk stays out of reach of reads-only paths and the display store keeps no ack state', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const id = seeded(w);
  const st = createNotificationsDisplayStore();
  const appended = st.append({ id: 'ntf-000099', title: 'd', body: 'd', priority: 'normal', createdAt: NOW });
  assert.equal(appended.accepted, true, 'fixture record must be accepted');
  const s = createAgentSurface({
    status: () => ({ agentActive: true, stopped: false, activeRun: null, notificationsPending: w.notifications.pending().length, remindersScheduled: 0, auditEntries: 0 }),
    listRuns: () => [],
    readAudit: () => ({ base: { seq: 0, hash: 'x'.repeat(64) }, entries: [], lastHash: 'x'.repeat(64), verified: true }),
    listProviders: () => [],
    listNotifications: () => w.notifications.exportAll(),
    listReminders: () => [],
    listDisplayNotifications: () => st.list(20),
    acknowledgeNotification: (nid) => w.p.acknowledgeNotification(nid),
  });
  // Rendering and listing NEVER acknowledge: reads leave the desk unread.
  await s.handlers['notifications:read']({});
  await s.handlers['status:get']({});
  await s.handlers['audit:read']({});
  assert.equal(w.notifications.exportAll().find((r) => r.id === id).read, false, 'reads never ack');
  assert.equal(st.list(20)[0].read, undefined, 'the display store record has no ack state at all');
  // Only the explicit request acknowledges.
  const ack = await s.handlers['notifications:ack']({ id });
  assert.equal(ack.ok, true);
  assert.equal(ack.data.acknowledged, true);
  assert.equal(ack.data.idempotent, false);
  assert.equal(ack.data.persisted, true);
  assert.equal(w.notifications.exportAll().find((r) => r.id === id).read, true);
  // The display store is untouched by the ack.
  assert.equal(st.list(20).length, 1);
  assert.deepEqual(Object.keys(st.list(20)[0]).sort(), ['body', 'createdAt', 'id', 'priority', 'title']);
});

test('ack: the surface handler accepts only a well-formed id and trusts no renderer claim', async () => {
  const calls = [];
  const s = createAgentSurface({
    status: () => ({}), listRuns: () => [], readAudit: () => ({ entries: [] }),
    listProviders: () => [], listNotifications: () => [], listReminders: () => [],
    listDisplayNotifications: () => [],
    acknowledgeNotification: (id) => { calls.push(id); return { ok: true, idempotent: false, persisted: true }; },
  });
  const h = s.handlers['notifications:ack'];
  // Valid: the id reaches the writer alone.
  const ok = await h({ id: 'ntf-000001' });
  assert.deepEqual(calls, ['ntf-000001']);
  assert.deepEqual(ok, { ok: true, data: { acknowledged: true, idempotent: false, persisted: true, reason: null } });
  // Renderer claims and extra fields are refused by the contract first.
  for (const payload of [
    {},
    { id: 'ntf-000001', displayed: true },
    { id: 'ntf-000001', displayedAt: 123 },
    { id: 'ntf-000001', verdict: 'ok' },
    { id: 42 },
    { id: null },
    { id: 'x'.repeat(17) },
    new Date(),
    'ntf-000001',
    (() => { const p = {}; Object.defineProperty(p, 'id', { enumerable: true, get() { throw new Error('boom'); } }); return p; })(),
  ]) {
    const r = await h(payload);
    assert.equal(r.ok, false, 'refused: ' + JSON.stringify(Object.keys(payload || {})));
    assert.equal(r.error, 'refused');
    assert.equal(calls.length, 1, 'the writer never ran for a refused request');
  }
  // A well-formed-shaped but wrong-format id is refused by the handler's
  // exact format check (contract length rules alone would pass it).
  for (const bad of ['ntf-00000x', 'rem-000001', 'NTF-000001', 'ntf-0000012']) {
    const r = await h({ id: bad });
    assert.equal(r.ok, true, 'contract shape ok');
    assert.deepEqual(r.data, { acknowledged: false, idempotent: false, persisted: false, reason: 'id_invalid' });
    assert.equal(calls.length, 1, 'the writer never ran');
  }
  // A writer that throws maps to the standard refusal, never leaking.
  const s2 = createAgentSurface({
    status: () => ({}), listRuns: () => [], readAudit: () => ({ entries: [] }),
    listProviders: () => [], listNotifications: () => [], listReminders: () => [],
    listDisplayNotifications: () => [],
    acknowledgeNotification: () => { throw new Error('secret internals'); },
  });
  const r2 = await s2.handlers['notifications:ack']({ id: 'ntf-000001' });
  assert.deepEqual(r2, { ok: false, error: 'refused', reason: 'refused' });
  // A refusing writer's bounded outcome crosses verbatim in shape only.
  const s3 = createAgentSurface({
    status: () => ({}), listRuns: () => [], readAudit: () => ({ entries: [] }),
    listProviders: () => [], listNotifications: () => [], listReminders: () => [],
    listDisplayNotifications: () => [],
    acknowledgeNotification: () => ({ ok: false, reason: 'integrity_failure' }),
  });
  const r3 = await s3.handlers['notifications:ack']({ id: 'ntf-000001' });
  assert.equal(r3.ok, true);
  assert.equal(r3.data.acknowledged, false);
  assert.equal(r3.data.reason, 'integrity_failure');
  // A main-only channel has NO handler at all: it is not merely refused,
  // it is never built.
  assert.equal(s.handlers['run:start'], undefined);
  assert.equal(s.handlers['approval:request'], undefined);
  assert.equal(s.handlers['persistence:write'], undefined);
});

test('ack: end to end through the surface, the read channel reports the flipped flag', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const id = seeded(w);
  const s = createAgentSurface({
    status: () => ({ agentActive: true, stopped: false, activeRun: null, notificationsPending: w.notifications.pending().length, remindersScheduled: 0, auditEntries: w.audit.snapshot().entries.length }),
    listRuns: () => [], readAudit: () => ({ base: { seq: 0, hash: null }, entries: [], lastHash: null, verified: true }),
    listProviders: () => [],
    listNotifications: () => w.notifications.exportAll(),
    listReminders: () => [], listDisplayNotifications: () => [],
    acknowledgeNotification: (nid) => w.p.acknowledgeNotification(nid),
  });
  const before = await s.handlers['notifications:read']({});
  assert.equal(before.data.notifications.find((r) => r.id === id).read, false);
  const ack = await s.handlers['notifications:ack']({ id });
  assert.equal(ack.ok, true);
  const after = await s.handlers['notifications:read']({});
  assert.equal(after.data.notifications.find((r) => r.id === id).read, true);
  // Status pending count follows the read flag.
  const st = await s.handlers['status:get']({});
  assert.equal(st.data.notificationsPending, 0);
});

test('ack: main wiring registers the channel and reaches the persistence layer, not the raw log', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(src.includes("ipcMain.handle('notifications:ack'"), 'the channel is registered');
  assert.ok(src.includes('agentPersistence = stack.persistence'), 'main keeps the persistence layer');
  assert.ok(src.includes('agentPersistence.acknowledgeNotification(id)'), 'the writer is the persistence layer');
  // The writer must NOT be the raw audit log's append.
  assert.equal(src.includes("agentAudit.appendAudit"), false);
  const contract = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc-contract.js'), 'utf8');
  const channels = require('../src/ipc-contract.js');
  assert.ok(channels.RENDERER_CHANNELS.includes('notifications:ack'));
  assert.equal(contract.includes("'notifications:ack'"), true);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.equal(preload.split("'notifications:ack'").length - 1, 1, 'exactly one entry in the preload list');
  const ipcChannels = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc-channels.js'), 'utf8');
  assert.equal(ipcChannels.split("'notifications:ack'").length - 1, 1, 'exactly one entry in the app allowlist');
});
