'use strict';

// M5 slice 1: the proactive scheduler. Coverage:
//   - quiet-hours helpers (parse, in-window incl. midnight wrap, next end)
//   - the schedule book (fail-closed creation, controls, per-scope
//     pause/resume, exactly-once tick, quiet defer-not-drop)
//   - validate/hydrate round-trips across a real persistence restart
//   - the user surface (strict payloads, durable writes with rollback)
//   - settings keys (opt-in defaults, quiet-hour validation)
//   - the wiring lock (user-surface only; the agent contract and registry
//     never see the scheduler)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createScheduleBook, parseQuietHours, inQuiet, nextQuietEnd, MAX_SCHEDULES, SCOPES } = require('../src/agent-scheduler');
const LocalDb = require('../src/db');
const { createRegistry } = require('../src/tool-registry');
const { createPolicyEngine } = require('../src/policy-engine');
const { createApprovalDesk } = require('../src/approval');
const { createAuditLog } = require('../src/audit');
const { createEmergencyStop } = require('../src/emergency-stop');
const { createNotificationDesk } = require('../src/agent-notifications');
const { createReminderBook } = require('../src/agent-reminders');
const { createAgentPersistence } = require('../src/agent-persistence');
const { createSchedulerSurface, validatePayload } = require('../src/scheduler-surface');
const { createAgentStack } = require('../src/agent-runtime');
const { RENDERER_CHANNELS } = require('../src/ipc-contract');
const { IPC_CHANNELS } = require('../src/ipc-channels');
const Settings = require('../src/settings');

const NOW = 1_700_000_000_000;
const QH_NIGHT = { enabled: true, start: '22:00', end: '08:00' };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

test('quiet hours: parse accepts valid, refuses invalid and disabled', () => {
  const qh = parseQuietHours(QH_NIGHT);
  assert.deepEqual(qh, { enabled: true, startMin: 1320, endMin: 480 });
  assert.equal(parseQuietHours({ enabled: false, start: '22:00', end: '08:00' }), null);
  assert.equal(parseQuietHours({ enabled: true, start: '24:00', end: '08:00' }), null);
  assert.equal(parseQuietHours({ enabled: true, start: 'ab:cd', end: '08:00' }), null);
  assert.equal(parseQuietHours({ enabled: true, start: 1320, end: '08:00' }), null);
  assert.equal(parseQuietHours(null), null);
  assert.equal(parseQuietHours({ enabled: true, start: '09:00', end: '17:00' }).startMin, 540);
});

test('quiet hours: in-window, midnight wrap, same-day window, empty window', () => {
  const qh = parseQuietHours(QH_NIGHT);
  // 2026-11-24 local: use Date construction so tests are timezone-agnostic.
  const at = (h, m) => new Date(2026, 10, 24, h, m, 0, 0).getTime();
  assert.equal(inQuiet(at(23, 0), qh), true, '23:00 inside 22-08');
  assert.equal(inQuiet(at(3, 30), qh), true, '03:30 inside 22-08');
  assert.equal(inQuiet(at(12, 0), qh), false, 'noon outside');
  assert.equal(inQuiet(at(8, 0), qh), false, '08:00 is the end, exclusive');
  assert.equal(inQuiet(at(21, 59), qh), false);
  const day = parseQuietHours({ enabled: true, start: '13:00', end: '14:00' });
  assert.equal(inQuiet(at(13, 30), day), true);
  assert.equal(inQuiet(at(14, 0), day), false);
  assert.equal(inQuiet(at(12, 0), day), false);
  const empty = parseQuietHours({ enabled: true, start: '08:00', end: '08:00' });
  assert.equal(inQuiet(at(8, 0), empty), false, 'start == end is an empty window');
  assert.equal(inQuiet(at(1, 0), null), false);
});

test('quiet hours: nextQuietEnd resolves the next window end after at', () => {
  const qh = parseQuietHours(QH_NIGHT);
  const at = (h, m, day = 24) => new Date(2026, 10, day, h, m, 0, 0).getTime();
  const expect = (h, m, day = 24) => new Date(2026, 10, day, h, m, 0, 0).getTime();
  // 23:00 -> window ends 08:00 NEXT day (wrap past midnight).
  assert.equal(nextQuietEnd(at(23, 0), qh), expect(8, 0, 25));
  // 03:30 -> window ends 08:00 the same day.
  assert.equal(nextQuietEnd(at(3, 30), qh), expect(8, 0));
  // 12:00 (outside) -> still resolves the next end (today 08:00 passed, so tomorrow).
  assert.equal(nextQuietEnd(at(12, 0), qh), expect(8, 0, 25));
  const day = parseQuietHours({ enabled: true, start: '13:00', end: '14:00' });
  // Before the window starts -> the upcoming end is tomorrow's (window not yet open today).
  assert.equal(nextQuietEnd(at(12, 0), day), expect(14, 0, 25));
  // Inside the window -> ends today.
  assert.equal(nextQuietEnd(at(13, 30), day), expect(14, 0));
  assert.equal(nextQuietEnd(at(12, 0), null), at(12, 0));
});

function book() { return createScheduleBook({ clock: () => NOW }); }

test('book: creation is fail-closed on every field', () => {
  const b = book();
  assert.equal(b.create({ title: '', scope: 'reminder', dueAt: NOW + 1000 }).reason, 'title_invalid');
  assert.equal(b.create({ title: 'x'.repeat(121), scope: 'reminder', dueAt: NOW + 1000 }).reason, 'title_invalid');
  assert.equal(b.create({ title: 't', scope: 'chore', dueAt: NOW + 1000 }).reason, 'scope_invalid');
  assert.equal(b.create({ title: 't', scope: 'reminder', dueAt: 'soon' }).reason, 'due_at_invalid');
  assert.equal(b.create({ title: 't', scope: 'reminder', dueAt: NOW - 1 }).reason, 'due_at_past');
  assert.equal(b.create({ title: 't', scope: 'reminder', dueAt: NOW }).reason, 'due_at_past');
  assert.equal(b.create({ title: 't', scope: 'reminder', dueAt: NOW + 1000, notes: 'x'.repeat(501) }).reason, 'notes_invalid');
  const ok = b.create({ title: 'Call the dentist', scope: 'reminder', dueAt: NOW + 1000, notes: 'n' });
  assert.equal(ok.ok, true);
  assert.match(ok.schedule.id, /^sch-\d{6}$/);
  assert.deepEqual(SCOPES, ['reminder', 'deadline']);
  assert.equal(MAX_SCHEDULES, 100);
});

test('book: bounded; refuses to grow past the cap rather than evicting', () => {
  const b = book();
  for (let i = 0; i < MAX_SCHEDULES; i++) {
    const r = b.create({ title: 't' + i, scope: 'reminder', dueAt: NOW + 1000 + i });
    assert.equal(r.ok, true);
  }
  assert.equal(b.create({ title: 'over', scope: 'reminder', dueAt: NOW + 999999 }).reason, 'book_full');
  assert.equal(b.count(), MAX_SCHEDULES);
});

test('book: controls (pause, resume, cancel, remove) with clean refusals', () => {
  const b = book();
  const s = b.create({ title: 't', scope: 'reminder', dueAt: NOW + 1000 }).schedule;
  assert.equal(b.pause(s.id).schedule.paused, true);
  assert.equal(b.resume(s.id).schedule.paused, false);
  assert.equal(b.pause('sch-999999').reason, 'schedule_unknown');
  assert.equal(b.pause('bad').reason, 'schedule_unknown');
  const c = b.create({ title: 'c', scope: 'deadline', dueAt: NOW + 2000 }).schedule;
  assert.equal(b.cancel(c.id).schedule.cancelled, true);
  assert.equal(b.pause(c.id).reason, 'schedule_cancelled');
  assert.equal(b.remove(c.id).removed.id, c.id);
  assert.equal(b.remove(c.id).reason, 'schedule_unknown');
  // fired schedules refuse resume
  const f = b.create({ title: 'f', scope: 'reminder', dueAt: NOW + 3000 }).schedule;
  b.tick(NOW + 3001, {});
  assert.equal(b.resume(f.id).reason, 'already_fired');
});

test('book: per-scope pause is book state; a schedule created into a paused scope stays quiet', () => {
  const b = book();
  const a = b.create({ title: 'a', scope: 'reminder', dueAt: NOW + 1000 }).schedule;
  const d = b.create({ title: 'd', scope: 'deadline', dueAt: NOW + 1000 }).schedule;
  assert.deepEqual(b.pauseScope('reminder'), { ok: true, scope: 'reminder' });
  assert.equal(b.list().find((x) => x.id === a.id).paused, false, 'individual flag untouched');
  assert.equal(b.list().find((x) => x.id === d.id).paused, false);
  // A schedule created into a paused scope stays quiet even with zero
  // other records in the scope.
  const empty = book();
  empty.pauseScope('deadline');
  empty.create({ title: 'later', scope: 'deadline', dueAt: NOW + 5000 });
  assert.equal(empty.tick(NOW + 6000, {}).due.length, 0, 'paused scope never fires');
  assert.equal(empty.resumeScope('deadline').ok, true);
  assert.equal(empty.tick(NOW + 6100, {}).due.length, 1, 'fires once the scope resumes');
  assert.equal(b.pauseScope('chore').reason, 'scope_invalid');
  // Resuming a scope never disturbs an individually paused record.
  b.pause(a.id);
  b.pauseScope('reminder');
  b.resumeScope('reminder');
  assert.equal(b.list().find((x) => x.id === a.id).paused, true);
  const t = b.tick(NOW + 7000, {});
  assert.deepEqual(t.due.map((x) => x.id), [d.id], 'only the unpaused record fires');
  // Scope state round-trips through its own export/hydrate.
  const b2 = book();
  b2.pauseScope('deadline');
  assert.deepEqual(b2.exportScopeState(), [{ scope: 'deadline', paused: true }]);
  const b3 = book();
  assert.equal(b3.hydrateScopeState([{ scope: 'deadline', paused: true }]).restored, 1);
  assert.equal(b3.hydrateScopeState([{ scope: 'chore', paused: true }]).ok, false);
  assert.equal(b3.hydrateScopeState([{ scope: 'deadline', paused: false }]).ok, false);
  assert.equal(b3.hydrateScopeState('x').ok, false);
});

test('tick: fires a due schedule exactly once and never re-fires', () => {
  const b = book();
  b.create({ title: 't', scope: 'reminder', dueAt: NOW + 1000 });
  const first = b.tick(NOW + 1001, { quietHours: { enabled: false } });
  assert.equal(first.due.length, 1);
  assert.equal(first.due[0].firedAt, NOW + 1001);
  const second = b.tick(NOW + 2000, { quietHours: { enabled: false } });
  assert.equal(second.due.length, 0);
  assert.equal(second.deferred.length, 0);
});

test('tick: paused and cancelled schedules never fire', () => {
  const b = book();
  const s = b.create({ title: 'p', scope: 'reminder', dueAt: NOW + 1000 }).schedule;
  const c = b.create({ title: 'c', scope: 'reminder', dueAt: NOW + 1000 }).schedule;
  b.pause(s.id);
  b.cancel(c.id);
  const t = b.tick(NOW + 2000, {});
  assert.equal(t.due.length, 0);
  assert.equal(b.list().find((x) => x.id === s.id).firedAt, null);
  b.resume(s.id);
  assert.equal(b.tick(NOW + 2100, {}).due.length, 1);
});

test('tick: quiet hours defer, never drop; fires at the window end', () => {
  const b = book();
  const at = (h, m, day = 24) => new Date(2026, 10, day, h, m, 0, 0).getTime();
  b.create({ title: 'late night', scope: 'reminder', dueAt: at(23, 0) });
  const t1 = b.tick(at(23, 1), { quietHours: QH_NIGHT });
  assert.equal(t1.quiet, true);
  assert.equal(t1.due.length, 0);
  assert.equal(t1.deferred.length, 1);
  assert.equal(t1.deferred[0].deferredTo, new Date(2026, 10, 25, 8, 0, 0, 0).getTime(), 'deferred to 08:00 next day');
  // Still quiet before the end: no fire, defer refreshed.
  const t2 = b.tick(at(3, 0, 25), { quietHours: QH_NIGHT });
  assert.equal(t2.due.length, 0);
  // At the window end the deferred schedule fires exactly once.
  const t3 = b.tick(at(8, 0, 25), { quietHours: QH_NIGHT });
  assert.equal(t3.quiet, false);
  assert.equal(t3.due.length, 1);
  assert.equal(t3.due[0].title, 'late night');
  assert.equal(b.tick(at(9, 0, 25), { quietHours: QH_NIGHT }).due.length, 0);
});

test('tick: a schedule created quiet (due inside the window) defers; quiet disabled fires immediately', () => {
  const b = book();
  const at = (h, m) => new Date(2026, 10, 24, h, m, 0, 0).getTime();
  b.create({ title: 'midday', scope: 'deadline', dueAt: at(13, 0) });
  const t = b.tick(at(13, 1), { quietHours: { enabled: true, start: '13:00', end: '14:00' } });
  assert.equal(t.deferred.length, 1);
  assert.equal(t.deferred[0].deferredTo, at(14, 0));
  const b2 = book();
  b2.create({ title: 'any', scope: 'reminder', dueAt: at(23, 0) });
  assert.equal(b2.tick(at(23, 1), { quietHours: { enabled: false } }).due.length, 1);
  // An invalid quiet config disables quiet (settings validation prevents this upstream).
  const b3 = book();
  b3.create({ title: 'x', scope: 'reminder', dueAt: at(23, 0) });
  assert.equal(b3.tick(at(23, 1), { quietHours: { enabled: true, start: 'bad' } }).due.length, 1);
});

test('validate/hydrate: round-trips every state and refuses hostile input', () => {
  const b = book();
  const keep = b.create({ title: 'keep', scope: 'reminder', dueAt: NOW + 1000, notes: 'n' }).schedule;
  const paused = b.create({ title: 'paused', scope: 'deadline', dueAt: NOW + 2000 }).schedule;
  b.pause(paused.id);
  const def = b.create({ title: 'deferred', scope: 'reminder', dueAt: NOW + 3000 }).schedule;
  b.tick(NOW + 3001, { quietHours: QH_NIGHT });
  const fired = b.create({ title: 'fired', scope: 'reminder', dueAt: NOW + 4000 }).schedule;
  b.tick(NOW + 4001, { quietHours: { enabled: false } });
  const gone = b.create({ title: 'gone', scope: 'reminder', dueAt: NOW + 5000 }).schedule;
  b.cancel(gone.id);
  const exported = b.exportAll();
  const v = b.validate(exported);
  assert.equal(v.ok, true);
  const b2 = createScheduleBook({ clock: () => NOW });
  assert.equal(b2.hydrate(exported).restored, 5);
  const got = b2.list();
  for (const field of ['paused', 'cancelled', 'deferredTo', 'firedAt']) {
    assert.deepEqual(got.map((r) => r[field]).sort(), exported.map((r) => r[field]).sort(), field + ' round-trips');
  }
  assert.equal(b2.create({ title: 'seq', scope: 'reminder', dueAt: NOW + 6000 }).schedule.id !== keep.id, true);
  // hostile inputs
  assert.equal(b2.validate(null).ok, false);
  assert.equal(b2.validate([{}]).ok, false);
  assert.equal(b2.validate([{ ...exported[0], id: 'sch-000001', scope: 'chore' }]).ok, false, 'bad scope refused');
  assert.equal(b2.validate([{ ...exported[0], id: 'rem-000001' }]).ok, false, 'foreign id prefix refused');
  const dup = [exported[0], { ...exported[0] }];
  assert.equal(b2.validate(dup).reason, 'duplicate_id');
  const overflow = [];
  for (let i = 0; i <= MAX_SCHEDULES; i++) overflow.push({ ...exported[0], id: 'sch-' + String(i).padStart(6, '0') });
  assert.equal(b2.validate(overflow).reason, 'book_overflow');
  // past dueAt accepted on restore (history, not a new create)
  assert.equal(b2.validate([{ ...exported[0], dueAt: NOW - 9999, id: 'sch-099999' }]).ok, true);
  // hydrate re-validates
  assert.equal(b2.hydrate([{ bad: true }]).ok, false);
});

test('persistence: schedule state survives a real save/restart/load round-trip', async () => {
  const state = { bytes: null, now: NOW };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const clock = () => state.now;
  const registry = createRegistry();
  const audit = createAuditLog({ clock });
  const approvals = createApprovalDesk({ clock });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock });
  const notifications = createNotificationDesk({ clock });
  const reminders = createReminderBook({ clock });
  const schedules = createScheduleBook({ clock });
  const p = createAgentPersistence({ db, clock, registry, audit, approvals, engine, emergencyStop: stop, notifications, reminders, schedules });
  assert.equal(p.load().ok, true);
  const made = schedules.create({ title: 'Call the dentist', scope: 'reminder', dueAt: NOW + 1000, notes: 'n' }).schedule;
  schedules.pause(made.id); // individual pause
  schedules.pauseScope('deadline'); // scope state, no records in it
  assert.equal(p.save().ok, true);
  state.now = NOW + 5;

  // Reopen from the flushed bytes.
  const db2 = await LocalDb.open({ storage: { load: async () => state.bytes, save: async (b) => { state.bytes = b; } } });
  const schedules2 = createScheduleBook({ clock: () => state.now });
  const p2 = createAgentPersistence({ db: db2, clock, registry, audit: createAuditLog({ clock }), approvals: createApprovalDesk({ clock }), engine: createPolicyEngine({ registry, approvals: createApprovalDesk({ clock }), emergencyStop: stop, clock }), emergencyStop: createEmergencyStop(), notifications: createNotificationDesk({ clock }), reminders: createReminderBook({ clock }), schedules: schedules2 });
  const loaded = p2.load();
  assert.equal(loaded.ok, true, JSON.stringify(loaded.problems));
  const got = schedules2.list();
  assert.equal(got.length, 1);
  assert.equal(got[0].id, made.id);
  assert.equal(got[0].title, 'Call the dentist');
  assert.equal(got[0].paused, true, 'individual paused flag survives');
  assert.equal(got[0].cancelled, false);
  assert.equal(got[0].firedAt, null);
  // The paused-scope state survived the restart too. The reminder scope is
  // live; resuming the individually paused record lets it fire. The
  // deadline scope is still paused even though it holds no records.
  assert.equal(schedules2.tick(state.now + 2000, {}).due.length, 0, 'individually paused does not fire');
  assert.equal(schedules2.resume(made.id).ok, true);
  assert.equal(schedules2.tick(state.now + 3000, {}).due.length, 1, 'fires after the individual resume');
  const fresh = createScheduleBook({ clock: () => state.now });
  fresh.pauseScope('deadline');
  assert.deepEqual(schedules2.exportScopeState(), fresh.exportScopeState(), 'deadline scope still paused');
  assert.equal(schedules2.tick(state.now + 4000, {}).due.length, 0, 'deadline scope stays quiet');
});

test('persistence: an invalid schedule row fails the load closed', async () => {
  const state = { bytes: null, now: NOW };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const clock = () => state.now;
  const schedules = createScheduleBook({ clock });
  const p = createAgentPersistence({ db, clock, registry: createRegistry(), audit: createAuditLog({ clock }), approvals: createApprovalDesk({ clock }), engine: createPolicyEngine({ registry: createRegistry(), approvals: createApprovalDesk({ clock }), emergencyStop: createEmergencyStop(), clock }), emergencyStop: createEmergencyStop(), notifications: createNotificationDesk({ clock }), reminders: createReminderBook({ clock }), schedules });
  assert.equal(p.load().ok, true);
  schedules.create({ title: 'x', scope: 'reminder', dueAt: NOW + 1000 });
  assert.equal(p.save().ok, true);
  // Corrupt the persisted flag, then load: the load must fail closed.
  const db2 = await LocalDb.open({ storage: { load: async () => state.bytes, save: async (b) => { state.bytes = b; } } });
  db2.run('UPDATE agent_schedules SET paused = 2');
  const p2 = createAgentPersistence({ db: db2, clock, registry: createRegistry(), audit: createAuditLog({ clock }), approvals: createApprovalDesk({ clock }), engine: createPolicyEngine({ registry: createRegistry(), approvals: createApprovalDesk({ clock }), emergencyStop: createEmergencyStop(), clock }), emergencyStop: createEmergencyStop(), notifications: createNotificationDesk({ clock }), reminders: createReminderBook({ clock }), schedules: createScheduleBook({ clock }) });
  const loaded = p2.load();
  assert.equal(loaded.ok, false);
  assert.ok(loaded.problems.some((x) => String(x).startsWith('invalid_schedule_row')), JSON.stringify(loaded.problems));
});

test('persistence: an optional schedules store stays optional (older callers work)', async () => {
  const state = { bytes: null, now: NOW };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const clock = () => state.now;
  const p = createAgentPersistence({ db, clock, registry: createRegistry(), audit: createAuditLog({ clock }), approvals: createApprovalDesk({ clock }), engine: createPolicyEngine({ registry: createRegistry(), approvals: createApprovalDesk({ clock }), emergencyStop: createEmergencyStop(), clock }), emergencyStop: createEmergencyStop(), notifications: createNotificationDesk({ clock }), reminders: createReminderBook({ clock }) });
  assert.equal(p.load().ok, true);
  assert.equal(p.save().ok, true);
  // A malformed schedules argument is refused loudly.
  assert.throws(() => createAgentPersistence({ db, clock, schedules: { exportAll: 'no' } }), /schedule book/);
});

test('surface: strict payloads, durable writes, rollback on persistence failure', async () => {
  const schedules = book();
  let auditOk = true;
  let saveOk = true;
  const appended = [];
  const persistence = {
    appendAudit: (e) => { appended.push(e); return auditOk ? { ok: true, seq: appended.length, hash: 'h' } : { ok: false, reason: 'audit_refused' }; },
    save: () => (saveOk ? { ok: true } : { ok: false, reason: 'persist_failure' }),
  };
  const s = createSchedulerSurface({ schedules, persistence });

  const good = await s.handlers['schedules:create']({ title: 'Call the dentist', scope: 'reminder', dueAt: NOW + 1000 });
  assert.equal(good.ok, true);
  assert.equal(good.schedule.title, 'Call the dentist');
  assert.equal(good.schedule.paused, false);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].action, 'schedules.created');
  assert.equal(appended[0].actor, 'user');

  // payload validation
  assert.equal((await s.handlers['schedules:create']({ title: 'x', scope: 'chore', dueAt: NOW + 1 })).ok, false);
  assert.equal((await s.handlers['schedules:create']({ title: 'x', scope: 'reminder', dueAt: -5 })).ok, false);
  assert.equal((await s.handlers['schedules:create']({ title: 'x', scope: 'reminder', dueAt: NOW + 1, extra: 1 })).reason, 'unknown_field:extra');
  assert.equal((await s.handlers['schedules:create']({ title: 'x', scope: 'reminder' })).reason, 'missing_field:dueAt');
  assert.equal((await s.handlers['schedules:create']({ title: 'x', scope: 'reminder', dueAt: NOW - 1 })).reason, 'due_at_past');
  assert.equal((await s.handlers['schedules:create'](null)).reason, 'missing_field:title');
  assert.equal((await s.handlers['schedules:create']('x')).reason, 'bad_payload');
  assert.equal((await s.handlers['schedules:pause']({ id: 'sch-000001', extra: 1 })).reason, 'unknown_field:extra');
  assert.equal((await s.handlers['schedules:list']({ limit: 501 })).ok, false);
  assert.equal((await s.handlers['schedules:list']({})).ok, true);

  // durable flow: pause + resume + cancel round-trip
  assert.equal((await s.handlers['schedules:pause']({ id: 'sch-000001' })).schedule.paused, true);
  assert.equal((await s.handlers['schedules:resume']({ id: 'sch-000001' })).schedule.paused, false);
  assert.equal((await s.handlers['schedules:cancel']({ id: 'sch-000001' })).schedule.cancelled, true);
  assert.equal((await s.handlers['schedules:pause']({ id: 'sch-999999' })).reason, 'schedule_unknown');

  // persistence failure rolls the mutation back: no phantom record
  auditOk = false;
  const before = schedules.count();
  const refused = await s.handlers['schedules:create']({ title: 'ghost', scope: 'reminder', dueAt: NOW + 5000 });
  assert.equal(refused.ok, false);
  assert.equal(schedules.count(), before, 'the record rolled back');
  auditOk = true;
  saveOk = false;
  const refused2 = await s.handlers['schedules:create']({ title: 'ghost2', scope: 'reminder', dueAt: NOW + 5000 });
  assert.equal(refused2.ok, false);
  assert.equal(schedules.count(), before, 'the record rolled back on save failure');
  saveOk = true;
});

test('surface: validatePayload refuses structural attacks before values are read', () => {
  assert.equal(validatePayload({}, {}).ok, true);
  assert.equal(validatePayload({ a: 1 }, {}).reason, 'unknown_field:a');
  assert.equal(validatePayload({ get a() { return 1; } }, { a: { type: 'int', min: 0, max: 1 } }).reason, 'accessor_property:a');
  const sym = Symbol('s');
  assert.equal(validatePayload({ [sym]: 1 }, {}).reason, 'symbol_key');
  // A literal cannot carry __proto__ as an own key; JSON.parse can.
  assert.equal(validatePayload(JSON.parse('{"__proto__":1}'), {}).reason, 'polluting_key:__proto__');
  assert.equal(validatePayload('x', {}).reason, 'bad_payload');
  assert.equal(validatePayload([1], {}).reason, 'bad_payload');
});

test('settings: proactive keys default to opt-in off, quiet hours on', () => {
  assert.equal(Settings.DEFAULTS.proactive_enabled, false);
  assert.equal(Settings.DEFAULTS.proactive_scope_reminder, false);
  assert.equal(Settings.DEFAULTS.proactive_scope_deadline, false);
  assert.equal(Settings.DEFAULTS.proactive_quiet_enabled, true);
  assert.equal(Settings.DEFAULTS.proactive_quiet_start, '22:00');
  assert.equal(Settings.DEFAULTS.proactive_quiet_end, '08:00');
  const good = Settings.validatePatch({ proactive_enabled: true, proactive_scope_deadline: true, proactive_quiet_start: '23:15', proactive_quiet_end: '07:45' });
  assert.equal(good.ok, true);
  assert.equal(good.clean.proactive_enabled, 'true');
  assert.equal(good.clean.proactive_quiet_start, '23:15');
  assert.equal(Settings.validatePatch({ proactive_quiet_start: '24:00' }).ok, false);
  assert.equal(Settings.validatePatch({ proactive_quiet_start: '9am' }).ok, false);
  assert.equal(Settings.validatePatch({ proactive_enabled: 'yes' }).ok, false);
  const norm = Settings.normalizeSettings({ proactive_enabled: 'true', proactive_quiet_start: '23:30' });
  assert.equal(norm.proactive_enabled, true);
  assert.equal(norm.proactive_quiet_start, '23:30');
  assert.equal(norm.proactive_quiet_end, '08:00');
});

test('wiring lock: the scheduler is user-surface only; the agent contract never widens', () => {
  // The Gate 2 agent contract stays read-only: no schedules channel in it.
  for (const ch of RENDERER_CHANNELS) assert.ok(!ch.startsWith('schedules:'), ch);
  // The product allowlist carries the five channels.
  for (const ch of ['schedules:create', 'schedules:list', 'schedules:pause', 'schedules:resume', 'schedules:cancel']) {
    assert.ok(IPC_CHANNELS.includes(ch), ch);
  }
  // Only agent-runtime.js builds the book; only main.js builds the surface.
  const requiringScheduler = ['agent-runtime.js', 'main.js'].filter((f) => read(f).includes("require('./agent-scheduler')"));
  assert.deepEqual(requiringScheduler, ['agent-runtime.js']);
  const requiringSurface = ['main.js'].filter((f) => read(f).includes("require('./scheduler-surface')"));
  assert.deepEqual(requiringSurface, ['main.js']);
  // The contract file never mentions the scheduler channels.
  assert.ok(!read('ipc-contract.js').includes('schedules:'));
  // The stack returns the book and the registry stays free of it.
  // (Structural check: the stack's return line names schedules; registry tool names never do.)
  assert.ok(read('agent-runtime.js').includes('schedules, orchestrator }'));
  assert.ok(!read('tool-registry.js').toLowerCase().includes('schedule'));
});

test('stack: createAgentStack wires the scheduler into persistence and returns it', async () => {
  const state = { bytes: null, now: NOW };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const stack = createAgentStack({ db, clock: () => NOW });
  assert.ok(stack.schedules, 'stack exposes the schedule book');
  const made = stack.schedules.create({ title: 't', scope: 'reminder', dueAt: NOW + 1000 }).schedule;
  assert.equal(stack.persistence.save().ok, true);
  // A fresh stack over the same bytes hydrates the schedule.
  const db2 = await LocalDb.open({ storage: { load: async () => state.bytes, save: async (b) => { state.bytes = b; } } });
  const stack2 = createAgentStack({ db: db2, clock: () => NOW });
  assert.equal(stack2.persistence.load().ok, true, JSON.stringify(stack2.persistence.load().problems || []));
  assert.equal(stack2.schedules.list().length, 1);
  assert.equal(stack2.schedules.list()[0].id, made.id);
});
