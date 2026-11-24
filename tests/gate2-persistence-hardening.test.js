'use strict';

// Gate 2 persistence hardening (review follow-ups on slice P1), five items:
// 1. desk hydrate refuses wrong top-level types, sparse arrays, non-plain
//    records, accessor/symbol/non-enumerable properties, and never reads a
//    value through a getter;
// 2. stored flags are strictly 0 or 1 (no truthy coercion) and timestamps
//    are bounded integers before any hydrate;
// 3. hydration is transactional in memory: every store validates before any
//    module takes state, so a later refusal leaves earlier stores untouched;
// 4. the schema stamp is written only after every integrity check passes:
//    a corrupt database is never modified on startup, and schema rows
//    refuse duplicates, unknown keys and invalid version strings;
// 5. is covered by the orchestrator lockout tests (see
//    tests/gate2-orchestrator-durable.test.js) and the P2 runtime tests.

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

const NOW = 1_700_000_000_000;

function fixtures() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 } } } });
  return registry;
}

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
  return { db, saved: state, state, registry, audit, approvals, stop, engine, notifications, reminders, p };
}

async function restart(prev) {
  prev.db.flush();
  const state = { bytes: prev.saved.bytes, now: prev.state.now };
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
  return { db, saved: state, state, registry, audit, approvals, stop, engine, notifications, reminders, p, loaded };
}

// --- Item 1: hostile records are refused without reading values ---

function hostileCases(validBase) {
  const cases = [];
  const add = (name, make, expectReason) => cases.push({ name, make, expectReason });
  add('not an array (string)', () => 'nope', 'not_array');
  add('not an array (object)', () => ({ 0: validBase() }), 'not_array');
  add('sparse array', () => { const a = []; a[1] = validBase(); return a; }, 'sparse_array');
  add('null element', () => [null], 'not_plain_record');
  add('array element', () => [[validBase()]], 'not_plain_record');
  add('exotic prototype', () => { const o = Object.create({ inherited: 1 }); Object.assign(o, validBase()); return [o]; }, 'not_plain_record');
  add('class instance', () => { class R { } const r = new R(); Object.assign(r, validBase()); return [r]; }, 'not_plain_record');
  add('symbol key', () => { const r = validBase(); r[Symbol('x')] = 1; return [r]; }, 'symbol_key');
  add('getter accessor', () => {
    const r = validBase();
    Object.defineProperty(r, 'apiKey', { enumerable: true, get() { return 'sk-hostile'; } });
    return [r];
  }, 'accessor_property');
  add('setter accessor', () => {
    const r = validBase();
    Object.defineProperty(r, 'apiKey', { enumerable: true, set() {}, get() { return 'sk-hostile'; } });
    return [r];
  }, 'accessor_property');
  add('non-enumerable property', () => {
    const r = validBase();
    Object.defineProperty(r, 'hidden', { enumerable: false, writable: true, configurable: true, value: 'x' });
    return [r];
  }, 'bad_descriptor');
  add('non-writable property', () => {
    const r = validBase();
    Object.defineProperty(r, 'locked', { enumerable: true, writable: false, configurable: true, value: 'x' });
    return [r];
  }, 'bad_descriptor');
  add('non-configurable property', () => {
    const r = validBase();
    Object.defineProperty(r, 'frozen', { enumerable: true, writable: true, configurable: false, value: 'x' });
    return [r];
  }, 'bad_descriptor');
  add('function value', () => { const r = validBase(); r.callback = () => {}; return [r]; }, 'function_value');
  return cases;
}

test('notification hydrate refuses hostile records and never invokes a getter', async () => {
  const w = await world();
  const validBase = () => ({ id: 'ntf-000001', title: 'T', body: 'B', priority: 'normal', createdAt: NOW, read: false });
  for (const c of hostileCases(validBase)) {
    const records = c.make();
    const res = w.notifications.hydrate(records);
    assert.equal(res.ok, false, c.name + ' must be refused');
    assert.equal(res.reason, c.expectReason, c.name + ' reason');
    assert.equal(w.notifications.list().length, 0, c.name + ' must leave the desk untouched');
  }
  // Getter invocation proof, explicit: a refused hydrate must not read.
  const r = validBase();
  let invoked = 0;
  Object.defineProperty(r, 'apiKey', { enumerable: true, get() { invoked += 1; return 'sk-hostile'; } });
  const res = w.notifications.hydrate([r]);
  assert.equal(res.ok, false);
  assert.equal(invoked, 0, 'the hostile getter must never run');
  // Object.freeze makes properties non-writable and non-configurable, so a
  // frozen record is refused too (bad_descriptor): persisted records are
  // plain, mutable data descriptors and nothing in the persistence path
  // hands hydrate a frozen object.
  const frozen = Object.freeze({ ...validBase(), id: 'ntf-000002' });
  const frozenRes = w.notifications.hydrate([frozen]);
  assert.equal(frozenRes.ok, false, 'frozen records are refused');
  assert.equal(frozenRes.reason, 'bad_descriptor');
  // A normal plain record still hydrates.
  assert.equal(w.notifications.hydrate([{ ...validBase(), id: 'ntf-000002' }]).ok, true);
});

test('reminder hydrate refuses hostile records and never invokes a getter', async () => {
  const w = await world();
  const validBase = () => ({ id: 'rem-000001', title: 'T', dueAt: NOW + 60_000, notes: null, createdAt: NOW, cancelled: false });
  for (const c of hostileCases(validBase)) {
    const res = w.reminders.hydrate(c.make());
    assert.equal(res.ok, false, c.name + ' must be refused');
    assert.equal(res.reason, c.expectReason, c.name + ' reason');
    assert.equal(w.reminders.list().length, 0, c.name + ' must leave the book untouched');
  }
  const r = validBase();
  let invoked = 0;
  Object.defineProperty(r, 'token', { enumerable: true, get() { invoked += 1; return 'tok-hostile'; } });
  assert.equal(w.reminders.hydrate([r]).ok, false);
  assert.equal(invoked, 0, 'the hostile getter must never run');
});

// --- Item 2: strict flags and bounded timestamps ---

test('stored flags other than exactly 0 or 1 fail closed', async () => {
  const bad = [
    ['notification read=2', "UPDATE agent_notifications SET read = 2 WHERE id = 'ntf-000001'", 'invalid_notification_row'],
    ['notification read=text', "UPDATE agent_notifications SET read = 'one' WHERE id = 'ntf-000001'", 'invalid_notification_row'],
    ['reminder cancelled=2', "UPDATE agent_reminders SET cancelled = 2 WHERE id = 'rem-000001'", 'invalid_reminder_row'],
    ['stop active=2', 'UPDATE agent_emergency_stop SET active = 2 WHERE id = 1', 'invalid_stop_row'],
  ];
  for (const [name, sql, problem] of bad) {
    let w = await world();
    w.notifications.create({ title: 'T', body: 'B', priority: 'normal' });
    w.reminders.create({ title: 'R', dueAt: NOW + 60_000 });
    w.stop.activate({ reason: 'test stop', by: 'user' });
    assert.equal(w.p.save().ok, true);
    w = await restart(w);
    assert.equal(w.loaded.ok, true);
    w.db.run(sql);
    w.db.flush();
    const reopened = await restart(w);
    assert.equal(reopened.loaded.ok, false, name + ' must fail closed');
    assert.ok(reopened.loaded.problems.some((x) => x.startsWith(problem)), name + ' problem: ' + JSON.stringify(reopened.loaded.problems));
    assert.equal(reopened.notifications.list().length, 0, name + ' must not hydrate');
    const wr = reopened.p.appendAudit({ actor: 'system', action: 'x.after' });
    assert.equal(wr.ok, false);
    assert.equal(wr.reason, 'integrity_failure');
  }
});

test('out-of-range timestamps fail closed', async () => {
  const bad = [
    ['notification created_at huge', 'UPDATE agent_notifications SET created_at = 100000000000000 WHERE id = ?', ['ntf-000001'], 'invalid_notification_row'],
    ['notification created_at negative', 'UPDATE agent_notifications SET created_at = -5 WHERE id = ?', ['ntf-000001'], 'invalid_notification_row'],
    ['reminder due_at float-as-text', "UPDATE agent_reminders SET due_at = 'now' WHERE id = ?", ['rem-000001'], 'invalid_reminder_row'],
    ['grant granted_at out of range', 'UPDATE agent_grants SET granted_at = 99999999999999 WHERE tool = ?', ['notes.search'], 'invalid_grant_row'],
    ['approval requested_at out of range', 'UPDATE agent_approvals SET requested_at = 1.5 WHERE id = (SELECT id FROM agent_approvals LIMIT 1)', [], 'invalid_approval_row'],
  ];
  for (const [name, sql, params, problem] of bad) {
    let w = await world();
    w.notifications.create({ title: 'T', body: 'B', priority: 'normal' });
    w.reminders.create({ title: 'R', dueAt: NOW + 60_000 });
    const g = w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
    assert.equal(g.ok, true);
    const a = w.approvals.request({ tool: 'notes.search', args: { query: 'x' } });
    assert.equal(a.ok, true);
    assert.equal(w.p.save().ok, true);
    w = await restart(w);
    assert.equal(w.loaded.ok, true);
    w.db.run(sql, params);
    w.db.flush();
    const reopened = await restart(w);
    assert.equal(reopened.loaded.ok, false, name + ' must fail closed');
    assert.ok(reopened.loaded.problems.some((x) => x.startsWith(problem)), name + ' problem: ' + JSON.stringify(reopened.loaded.problems));
  }
});

// --- Item 3: hydration is transactional in memory ---

test('a later store refusal leaves earlier stores untouched and the database unmodified', async () => {
  let w = await world();
  const g = w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  assert.equal(g.ok, true);
  w.p.appendAudit({ actor: 'system', action: 'x.before' });
  w.notifications.create({ title: 'Good', body: 'row', priority: 'high' });
  assert.equal(w.p.save().ok, true);
  // Plant ONE invalid reminder row; everything else is valid.
  w.db.run("INSERT INTO agent_reminders (id, title, due_at, notes, created_at, cancelled, acknowledged) VALUES ('rem-000001', 'Bad', ?, NULL, ?, 2, 0)", [NOW + 60_000, NOW]);
  w.db.flush();

  const reopened = await restart(w);
  assert.equal(reopened.loaded.ok, false);
  assert.ok(reopened.loaded.problems.some((x) => x.startsWith('invalid_reminder_row')), JSON.stringify(reopened.loaded.problems));
  // Nothing took state anywhere: not the audit, not the grants, not the
  // notification that validated fine.
  assert.equal(reopened.audit.snapshot().entries.length, 0, 'audit must not hydrate');
  assert.equal(reopened.engine.listGrants().length, 0, 'grants must not hydrate');
  assert.equal(reopened.approvals.exportAll().length, 0, 'approvals must not hydrate');
  assert.equal(reopened.notifications.list().length, 0, 'notifications must not hydrate');
  assert.equal(reopened.reminders.list().length, 0, 'reminders must not hydrate');
  // The database rows are all still exactly as written.
  assert.equal(reopened.db.all('SELECT COUNT(*) AS c FROM agent_grants')[0].c, 1);
  assert.equal(reopened.db.all('SELECT COUNT(*) AS c FROM agent_audit')[0].c, 1);
  assert.equal(reopened.db.all('SELECT COUNT(*) AS c FROM agent_notifications')[0].c, 1);
  assert.equal(reopened.db.all('SELECT COUNT(*) AS c FROM agent_reminders')[0].c, 1);
  // Writes refuse.
  const wr = reopened.p.appendAudit({ actor: 'system', action: 'x.after' });
  assert.equal(wr.ok, false);
  assert.equal(wr.reason, 'integrity_failure');
});

// --- Item 4: the schema stamp is safe, structural, and never written to a corrupt DB ---

test('a corrupt database is never modified on startup: no stamp, no anchor write, rows intact', async () => {
  let w = await world();
  w.p.appendAudit({ actor: 'system', action: 'x.one' });
  assert.equal(w.p.save().ok, true);
  w = await restart(w);
  // Tamper with an audit row AND remove the version stamp, as an older build
  // would have left things: load must fail closed and write NOTHING.
  w.db.run('UPDATE agent_audit SET action = ? WHERE seq = 1', ['x.tampered']);
  w.db.run("DELETE FROM agent_schema WHERE key = 'version'");
  w.db.flush();
  const reopened = await restart(w);
  assert.equal(reopened.loaded.ok, false);
  assert.ok(reopened.loaded.problems.some((x) => x.startsWith('chain_broken')), JSON.stringify(reopened.loaded.problems));
  const stamp = reopened.db.all("SELECT value FROM agent_schema WHERE key = 'version'");
  assert.equal(stamp.length, 0, 'a corrupt database must not be stamped');
  const anchor = reopened.db.all('SELECT COUNT(*) AS c FROM agent_audit_anchor');
  assert.equal(anchor[0].c, 1, 'existing anchor untouched');
  const row = reopened.db.all('SELECT action FROM agent_audit WHERE seq = 1')[0];
  assert.equal(row.action, 'x.tampered', 'rows are never repaired');
  const wr = reopened.p.appendAudit({ actor: 'system', action: 'x.after' });
  assert.equal(wr.ok, false);
  assert.equal(wr.reason, 'integrity_failure');
});

test('schema rows refuse unknown keys and invalid version strings, writing nothing', async () => {
  const bad = [
    ['unknown key', "INSERT INTO agent_schema (key, value) VALUES ('extra', 'x')", 'unknown_schema_key:extra'],
    ['invalid version string', "UPDATE agent_schema SET value = 'abc' WHERE key = 'version'", 'invalid_schema_version'],
    ['float version string', "UPDATE agent_schema SET value = '1.5' WHERE key = 'version'", 'invalid_schema_version'],
  ];
  for (const [name, sql, problem] of bad) {
    let w = await world();
    w.p.appendAudit({ actor: 'system', action: 'x.one' });
    assert.equal(w.p.save().ok, true);
    w = await restart(w);
    assert.equal(w.loaded.ok, true);
    const before = JSON.stringify(w.db.all('SELECT * FROM agent_audit ORDER BY seq'));
    w.db.run(sql);
    w.db.flush();
    const reopened = await restart(w);
    assert.equal(reopened.loaded.ok, false, name + ' must fail closed');
    assert.ok(reopened.loaded.problems.some((x) => x.startsWith(problem.split(':')[0])), name + ' problem: ' + JSON.stringify(reopened.loaded.problems));
    if (problem.includes(':')) {
      assert.ok(reopened.loaded.problems.includes(problem), name + ' names the key: ' + JSON.stringify(reopened.loaded.problems));
    }
    const after = JSON.stringify(reopened.db.all('SELECT * FROM agent_audit ORDER BY seq'));
    assert.equal(after, before, name + ' must not modify the database');
    const wr = reopened.p.appendAudit({ actor: 'system', action: 'x.after' });
    assert.equal(wr.ok, false);
    assert.equal(wr.reason, 'integrity_failure');
  }
});
