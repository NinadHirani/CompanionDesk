'use strict';

// Gate 2 persistence milestone, slice P1: the two harmless-tool desks
// (notifications, reminders) gain bounded export and strict hydrate, and the
// persistence layer gains a versioned schema stamp plus hard bounds on
// persisted audit detail blobs. These tests cover the classes the earlier
// persistence file did not: desk round-trips across restarts, unknown-field
// (secret) exclusion, oversized payloads, schema versioning, append-durability
// acknowledgement without an explicit save, convergence after a persist
// failure, and the durable-audit wrapper.

const test = require('node:test');
const assert = require('node:assert');

const LocalDb = require('../src/db');
const { createRegistry } = require('../src/tool-registry');
const { createPolicyEngine } = require('../src/policy-engine');
const { createApprovalDesk } = require('../src/approval');
const { createAuditLog } = require('../src/audit');
const { createEmergencyStop } = require('../src/emergency-stop');
const { createNotificationDesk } = require('../src/agent-notifications');
const { createReminderBook } = require('../src/agent-reminders');
const { createAgentPersistence } = require('../src/agent-persistence');

const HEX64 = /^[a-f0-9]{64}$/;
const NOW = 1_700_000_000_000;

function fixtures() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 } } } });
  return registry;
}

// Full world with the desks attached, plus the reopen-from-flushed-bytes
// restart helper, matching the earlier persistence test file's harness.
async function world() {
  const state = { bytes: null, now: NOW };
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
  const loaded = p.load();
  assert.equal(loaded.ok, true, 'world must load clean: ' + JSON.stringify(loaded.problems));
  return { db, saved: state, state, registry, audit, approvals, stop, engine, notifications, reminders, p, loaded };
}

async function restart(prev, extra) {
  prev.db.flush();
  const state = { bytes: prev.saved.bytes, now: prev.state.now };
  assert.ok(state.bytes && state.bytes.length > 0, 'flush must have produced bytes');
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
  const loaded = p.load();
  if (extra) extra({ db, p, loaded });
  return { db, saved: state, state, registry, audit, approvals, stop, engine, notifications, reminders, p, loaded };
}

test('notifications and reminders round-trip across a restart, and ids continue without collision', async () => {
  let w = await world();
  w.notifications.create({ title: 'First', body: 'hello', priority: 'normal' });
  w.notifications.create({ title: 'Second', body: 'hi', priority: 'high' });
  const read = w.notifications.create({ title: 'Third', body: 'read me', priority: 'low' });
  w.notifications.markRead(read.notification.id);
  w.reminders.create({ title: 'Soon', dueAt: NOW + 60_000, notes: 'check' });
  const late = w.reminders.create({ title: 'Later', dueAt: NOW + 120_000 });
  w.reminders.acknowledge(late.reminder.id);
  const savedNotifs = w.p.save();
  assert.equal(savedNotifs.ok, true);

  w = await restart(w);
  assert.equal(w.loaded.ok, true, JSON.stringify(w.loaded.problems));
  const notifs = w.notifications.list();
  assert.equal(notifs.length, 3);
  assert.equal(notifs[0].title, 'First');
  assert.equal(notifs[1].priority, 'high');
  assert.equal(notifs.find((n) => n.title === 'Third').read, true, 'read flag survives');
  const rems = w.reminders.list();
  assert.equal(rems.length, 2);
  assert.equal(rems[0].title, 'Soon');
  assert.equal(rems[1].acknowledged, true, 'acknowledged survives');

  // Id sequence continues where persistence left off: a new create after the
  // restart must not collide with a stored id.
  const after = w.notifications.create({ title: 'Fourth', body: 'x', priority: 'normal' });
  assert.equal(after.notification.id, 'ntf-000004');
  assert.equal(w.p.save().ok, true);

  // A second restart re-verifies and restores again.
  w = await restart(w);
  assert.equal(w.loaded.ok, true, JSON.stringify(w.loaded.problems));
  assert.equal(w.notifications.list().length, 4);
  assert.equal(w.reminders.list().length, 2);
});

test('hydrated records drop unknown fields, and a planted secret never reaches any persisted row', async () => {
  const w = await world();
  const token = 'tok-SECRET-planted-value';
  const h = w.notifications.hydrate([
    { id: 'ntf-000001', title: 'T', body: 'B', priority: 'normal', createdAt: NOW, read: false, apiKey: token, ownerToken: token },
  ]);
  assert.equal(h.ok, true, 'valid record must hydrate');
  const rec = w.notifications.list()[0];
  assert.equal(rec.apiKey, undefined, 'unknown field dropped in memory');
  assert.equal(w.p.save().ok, true);

  const tables = ['agent_grants', 'agent_approvals', 'agent_audit', 'agent_audit_anchor', 'agent_emergency_stop', 'agent_runs', 'agent_notifications', 'agent_reminders'];
  for (const t of tables) {
    const rows = w.db.all('SELECT * FROM ' + t);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes(token), 'planted secret must not appear in ' + t);
  }
});

test('an oversized persisted audit detail blob fails closed at load and nothing is deleted', async () => {
  let w = await world();
  w.p.save();
  w = await restart(w);
  // Plant an oversized detail blob directly, the way a buggy or tampering
  // writer would leave it.
  w.db.run("INSERT INTO agent_audit (seq, at, actor, action, detail_json, hash) VALUES (?, ?, ?, ?, ?, ?)", [
    2, '2026-11-24T00:00:00.000Z', 'system', 'x.bulk', 'x'.repeat(5000), 'f'.repeat(64),
  ]);
  w.db.flush();
  const reopened = await restart(w);
  assert.equal(reopened.loaded.ok, false, 'load must fail closed');
  assert.ok(reopened.loaded.problems.some((p) => p.startsWith('invalid_audit_row:2')), 'problems name the bad row: ' + JSON.stringify(reopened.loaded.problems));
  // Nothing deleted or repaired: the row is still there exactly as written.
  const still = reopened.db.all('SELECT seq FROM agent_audit WHERE seq = 2');
  assert.equal(still.length, 1);
  // Writes refuse while integrity is failed.
  const res = reopened.p.appendAudit({ actor: 'system', action: 'x.after' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'integrity_failure');
});

test('the schema stamp: fresh stores get version 1, unversioned stores are stamped additively, and a newer build is refused', async () => {
  // Fresh world: load stamps version 1.
  let w = await world();
  let v = w.db.all("SELECT value FROM agent_schema WHERE key = 'version'");
  assert.equal(v.length, 1);
  assert.equal(v[0].value, '1');

  // Data survives, then the version row is removed (as an older build would
  // have left it). Reopening stamps it back additively with all state intact.
  const g = w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  assert.equal(g.ok, true);
  w.p.appendAudit({ actor: 'system', action: 'x.note' });
  assert.equal(w.p.save().ok, true);
  w.db.flush();
  w = await restart(w);
  assert.equal(w.loaded.ok, true);
  w.db.run("DELETE FROM agent_schema WHERE key = 'version'");
  w.db.flush();
  const reopened = await restart(w);
  assert.equal(reopened.loaded.ok, true, JSON.stringify(reopened.loaded.problems));
  v = reopened.db.all("SELECT value FROM agent_schema WHERE key = 'version'");
  assert.equal(v.length, 1);
  assert.equal(v[0].value, '1');
  assert.equal(reopened.audit.snapshot().entries.length, 1, 'audit entries survive the stamp');
  assert.equal(reopened.engine.listGrants().length, 1, 'grants survive the stamp');

  // A version from a NEWER build fails closed: nothing hydrated, nothing
  // deleted or repaired, writes refused.
  reopened.db.run("UPDATE agent_schema SET value = '2' WHERE key = 'version'");
  reopened.db.flush();
  const future = await restart(reopened);
  assert.equal(future.loaded.ok, false);
  assert.deepEqual(future.loaded.problems, ['schema_from_newer_build']);
  const rows = future.db.all('SELECT tool FROM agent_grants');
  assert.equal(rows.length, 1, 'nothing deleted');
  const wr = future.p.appendAudit({ actor: 'system', action: 'x.future' });
  assert.equal(wr.ok, false);
  assert.equal(wr.reason, 'integrity_failure');
});

test('appendAudit is durable without an explicit save: a restart after acknowledged appends keeps them', async () => {
  let w = await world();
  const first = w.p.appendAudit({ actor: 'system', action: 'x.durable.one' });
  assert.equal(first.ok, true);
  assert.equal(first.seq, 1);
  const second = w.p.appendAudit({ actor: 'system', action: 'x.durable.two' });
  assert.equal(second.ok, true);

  // Restart WITHOUT calling save(): the appends were persisted when they were
  // acknowledged, so both entries and the anchor must survive.
  w = await restart(w);
  assert.equal(w.loaded.ok, true, JSON.stringify(w.loaded.problems));
  const entries = w.audit.snapshot().entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'x.durable.one');
  assert.equal(entries[1].action, 'x.durable.two');
  const anchor = w.db.all('SELECT last_seq FROM agent_audit_anchor WHERE id = 1')[0];
  assert.equal(anchor.last_seq, 2);
});

test('a persist failure during append reports failure, keeps the entry in memory, and the next save converges', async () => {
  let w = await world();
  // Proxy that breaks exactly the audit-row insert, the way a failing disk
  // would; BEGIN/COMMIT/ROLLBACK pass through so rollback semantics run.
  const realRun = w.db.run.bind(w.db);
  let breakAuditInserts = true;
  w.db.run = function (sql, params) {
    if (breakAuditInserts && sql.startsWith('INSERT INTO agent_audit')) throw new Error('simulated write failure');
    return realRun(sql, params);
  };
  const failed = w.p.appendAudit({ actor: 'system', action: 'x.willfail' });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'persist_failure');
  // The entry stayed in memory for convergence.
  assert.equal(w.audit.snapshot().entries.length, 1);
  breakAuditInserts = false;
  const saved = w.p.save();
  assert.equal(saved.ok, true, 'the next save must converge');
  assert.ok(saved.entries >= 1);

  w = await restart(w);
  assert.equal(w.loaded.ok, true, JSON.stringify(w.loaded.problems));
  const entries = w.audit.snapshot().entries;
  assert.ok(entries.some((e) => e.action === 'x.willfail'), 'the converged entry survives the restart');
});

test('desk hydrate refuses an overflow whole and refuses duplicate or malformed records', async () => {
  const w = await world();
  const rows = [];
  for (let i = 1; i <= 101; i++) {
    rows.push({ id: 'ntf-' + String(i).padStart(6, '0'), title: 'T' + i, body: 'B', priority: 'normal', createdAt: NOW, read: false });
  }
  const over = w.notifications.hydrate(rows);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'queue_overflow');
  assert.equal(w.notifications.list().length, 0, 'an overflow hydrates nothing');

  const dup = w.notifications.hydrate([rows[0], { ...rows[0] }]);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate_id');
  const bad = w.notifications.hydrate([{ id: 'ntf-000001', title: 'T', body: 'B', priority: 'urgent', createdAt: NOW, read: false }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_record');
  assert.equal(w.notifications.list().length, 0, 'failed hydrates change nothing');
});

test('the durable audit wrapper: appends are persisted and acknowledged, failures are reported, validation passes through', async () => {
  let w = await world();
  const durable = w.p.durableAudit();
  const ok = durable.append({ actor: 'system', action: 'x.via.wrapper' });
  assert.equal(ok.ok, true);
  assert.equal(ok.seq, 1);
  assert.match(ok.hash, HEX64);
  // Reads pass through to the real log.
  assert.equal(durable.snapshot().entries.length, 1);
  // Validation failures pass through untouched (errors array preserved).
  const bad = durable.append({ actor: '', action: 'x' });
  assert.equal(bad.ok, false);
  assert.ok(Array.isArray(bad.errors), 'validation errors pass through');

  // A restart without save() still sees the acknowledged append.
  w = await restart(w);
  assert.equal(w.loaded.ok, true);
  assert.equal(w.audit.snapshot().entries.length, 1);
  assert.equal(w.audit.snapshot().entries[0].action, 'x.via.wrapper');

  // A persist failure is reported as failure, not success.
  const realRun = w.db.run.bind(w.db);
  let breakAuditInserts = true;
  w.db.run = function (sql, params) {
    if (breakAuditInserts && sql.startsWith('INSERT INTO agent_audit')) throw new Error('simulated write failure');
    return realRun(sql, params);
  };
  const failed = w.p.durableAudit().append({ actor: 'system', action: 'x.wrapper.fail' });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'persist_failure');
  assert.equal(failed.errors, undefined, 'a persist failure is not a validation result');
});
