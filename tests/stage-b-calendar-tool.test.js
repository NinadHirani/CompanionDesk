'use strict';

// Gate 2 run-driver Stage B (blueprint 3j.10), approved by Ninad on 26 Nov
// 2026: D-B1 implemented here; D-B2 option (a) means the production
// registry stays EMPTY and main.js registers nothing (the enable step is a
// separate later review). The calendar_upcoming tool is a read-only
// projection of the local calendars the user imported. The tool NEVER
// requires the calendar or ics modules: the service arrives by dependency
// injection, exactly like the scheduling gate's book, so the closed
// generator files stay untouched.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { createRegistry, validateDefinition, isCriticalName } = require('../src/tool-registry.js');
const { createPolicyEngine } = require('../src/policy-engine.js');
const { createApprovalDesk } = require('../src/approval.js');
const { createEmergencyStop } = require('../src/emergency-stop.js');
const { createAuditLog } = require('../src/audit.js');
const { createOrchestrator } = require('../src/agent-orchestrator.js');
const { createNotificationDesk } = require('../src/agent-notifications.js');
const { createReminderBook } = require('../src/agent-reminders.js');
const { createAgentPersistence } = require('../src/agent-persistence.js');
const { createRunDriver } = require('../src/agent-run-driver.js');
const { projectRun } = require('../src/agent-surface.js');
const LocalDb = require('../src/db.js');
const {
  CALENDAR_UPCOMING_DEF,
  calendarUpcomingProjection,
  calendarUpcomingRun,
} = require('../src/agent-tool-calendar.js');

const NOW = 1_700_000_000_000;
const TODAY = '2026-11-26';

// The fake service mirrors the real calendar service contract exactly:
// upcoming(db, payload, todayIso), days an integer 1..60 (default 7),
// occurrences already in the service's own sort order.
function fakeService(occurrences, opts = {}) {
  const calls = [];
  return {
    calls,
    upcoming(db, payload, todayIso) {
      calls.push({ payload: payload && typeof payload === 'object' ? { ...payload } : payload, todayIso });
      if (opts.throw) throw new Error(opts.throw);
      const days = payload && payload.days !== undefined ? payload.days : 7;
      if (!Number.isInteger(days) || days < 1 || days > 60) return { ok: false, error: 'bad_request' };
      if (opts.badRequest) return { ok: false, error: 'bad_request' };
      return {
        ok: true,
        occurrences,
        unsupportedCount: opts.unsupportedCount === undefined ? 0 : opts.unsupportedCount,
        calendars: opts.calendars || ['Personal'],
      };
    },
  };
}

function occ(i, title) {
  const date = '2026-12-' + String(1 + (i % 30)).padStart(2, '0');
  return { uid: 'u' + i, title: title === undefined ? 'Event ' + i : title, location: 'Room ' + i, date, time: '10:00', allDay: false };
}

function stack(engineOpts = {}) {
  const registry = createRegistry();
  const v = validateDefinition(CALENDAR_UPCOMING_DEF);
  assert.deepEqual(v, [], 'definition must be valid: ' + JSON.stringify(v));
  registry.define(CALENDAR_UPCOMING_DEF);
  const audit = createAuditLog({ clock: () => NOW });
  const approvals = createApprovalDesk({ clock: () => NOW });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock: () => NOW, ...engineOpts });
  const orch = createOrchestrator({ engine, approvals, emergencyStop: stop, audit, clock: () => NOW });
  return { registry, audit, approvals, stop, engine, orch };
}

test('the definition is a valid read_only tool and the module stays dependency-injected', () => {
  assert.equal(CALENDAR_UPCOMING_DEF.name, 'calendar_upcoming');
  assert.equal(CALENDAR_UPCOMING_DEF.capability, 'read_only');
  assert.equal(isCriticalName(CALENDAR_UPCOMING_DEF.name), false);
  const src = fs.readFileSync('src/agent-tool-calendar.js', 'utf8');
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const bad of ["require('./calendar')", "require('./ics')", 'require("./calendar")', 'require("./ics")',
    'child_process', "require('fs')", "require('electron')", 'http.request', 'fetch(']) {
    assert.equal(stripped.includes(bad), false, 'module must not contain ' + bad);
  }
});

test('the registry rejects malformed arguments for the tool', () => {
  const { registry } = stack();
  const cases = [
    [{ days: '7' }, 'wrong_type:days'],
    [{ days: 1.5 }, 'wrong_type:days'],
    [{ location: 'x' }, 'unknown_field:location'],
    [{ days: 7, extra: 1 }, 'unknown_field:extra'],
  ];
  for (const [args, reason] of cases) {
    const r = registry.validateArgs('calendar_upcoming', args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.ok(r.errors.includes(reason), r.errors + ' vs ' + reason);
  }
  assert.equal(registry.validateArgs('calendar_upcoming', {}).ok, true);
  assert.equal(registry.validateArgs('calendar_upcoming', { days: 7 }).ok, true);
  assert.equal(registry.validateArgs('calendar_upcoming', { days: 60 }).ok, true);
});

test('the tool closure passes args through and the service range stays the boundary', () => {
  const svc = fakeService([]);
  const run = calendarUpcomingRun({ service: svc, db: {}, todayIso: TODAY });
  const empty = run({});
  assert.equal(empty.ok, true);
  assert.equal(empty.count, 0);
  assert.equal(empty.truncated, false);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(svc.calls[0].payload, {});
  assert.equal(svc.calls[0].todayIso, TODAY);
  const r30 = run({ days: 30 });
  assert.deepEqual(svc.calls[1].payload, { days: 30 });
  assert.equal(r30.ok, true);
  for (const bad of [{ days: 0 }, { days: 61 }, { days: -5 }]) {
    const r = run(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.summary, 'bad_request');
  }
  const runBoom = calendarUpcomingRun({ service: fakeService([], { throw: 'disk gone' }), db: {}, todayIso: TODAY });
  const rb = runBoom({});
  assert.equal(rb.ok, false);
  assert.equal(rb.summary, 'calendar_service_error');
});

test('the projection drops uid and location always and caps titles at 200', () => {
  const occs = [occ(0, 'Q'.repeat(500)), occ(1)];
  const svc = fakeService(occs);
  const p = calendarUpcomingProjection({ service: svc, db: {}, args: {}, todayIso: TODAY });
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 2);
  assert.equal(p.count, 2);
  assert.equal(p.truncated, false);
  assert.equal(p.unsupportedCount, 0);
  assert.deepEqual(p.calendars, ['Personal']);
  const json = JSON.stringify(p);
  assert.equal(json.includes('uid'), false);
  assert.equal(json.includes('location'), false);
  assert.equal(json.includes('Room'), false);
  for (const row of p.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['allDay', 'date', 'time', 'title']);
    assert.ok(row.title.length <= 200, 'title cap');
  }
  assert.equal(p.rows[0].title.length, 200);
});

test('the projection caps rows at 100 and bytes at 32768, dropping trailing rows', () => {
  const many = Array.from({ length: 150 }, (_, i) => occ(i));
  const p = calendarUpcomingProjection({ service: fakeService(many), db: {}, args: {}, todayIso: TODAY });
  assert.equal(p.rows.length, 100);
  assert.equal(p.count, 100);
  assert.equal(p.truncated, true);
  assert.equal(p.rows[0].date, many[0].date, 'service sort order preserved');

  const long = Array.from({ length: 150 }, (_, i) => occ(i, 'T' + i + ' ' + 'y'.repeat(195)));
  const p2 = calendarUpcomingProjection({ service: fakeService(long), db: {}, args: {}, todayIso: TODAY });
  assert.ok(p2.rows.length < 150, 'byte cap dropped trailing rows');
  assert.equal(p2.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(p2), 'utf8') <= 32768);
  assert.equal(p2.rows[0].date, long[0].date, 'leading rows kept');
});

test('a full read-only run with the real tool completes through the orchestrator', () => {
  const w = stack();
  const svc = fakeService([occ(0, 'Paper deadline'), occ(1, 'Lab meeting')]);
  let invoked = 0;
  const run = (args) => { invoked += 1; return calendarUpcomingRun({ service: svc, db: {}, todayIso: TODAY })(args); };
  assert.equal(w.engine.grantTool({ tool: 'calendar_upcoming', ttlMs: 60_000 }).ok, true);
  const started = w.orch.startRun({
    runId: 'r-cal-1',
    goal: 'list upcoming calendar items',
    plan: [{ id: 'cal', tool: 'calendar_upcoming', args: {}, run }],
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const s1 = w.orch.step('r-cal-1');
  assert.equal(s1.ok, true, JSON.stringify(s1));
  assert.equal(invoked, 1);
  const done = w.orch.step('r-cal-1');
  assert.equal(done.state, 'completed');
  assert.deepEqual(w.audit.snapshot().entries.map((e) => e.action), [
    'run.started', 'run.step_started', 'run.step_succeeded', 'run.completed',
  ]);
});

test('the deny ladder holds for the tool inside a run', () => {
  const w = stack();
  const svc = fakeService([occ(0)]);
  const run = calendarUpcomingRun({ service: svc, db: {}, todayIso: TODAY });
  const started = w.orch.startRun({ runId: 'r-denied', plan: [{ id: 'cal', tool: 'calendar_upcoming', args: {}, run }] });
  assert.equal(started.ok, true);
  const s1 = w.orch.step('r-denied');
  assert.equal(s1.ok, false);
  assert.equal(s1.state, 'aborted');
  assert.equal(s1.reason, 'no_grant');
  assert.equal(svc.calls.length, 0, 'the service never ran without a grant');
  const denied = w.audit.snapshot().entries.filter((e) => e.action === 'run.step_denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].detail.reason, 'no_grant');
});

test('the emergency stop blocks the tool before anything runs', () => {
  const w = stack();
  assert.equal(w.stop.activate('user asked to stop', { by: 'user' }).ok, true);
  const svc = fakeService([occ(0)]);
  const started = w.orch.startRun({
    runId: 'r-stop',
    plan: [{ id: 'cal', tool: 'calendar_upcoming', args: {}, run: calendarUpcomingRun({ service: svc, db: {}, todayIso: TODAY }) }],
  });
  assert.equal(started.ok, false);
  assert.equal(started.reason, 'stop_active');
  assert.equal(svc.calls.length, 0);
});

test('the step result body never reaches run state or the renderer projection', () => {
  const w = stack();
  const svc = fakeService([occ(0, 'Very Private Meeting'), occ(1, 'Doctor Visit')]);
  w.engine.grantTool({ tool: 'calendar_upcoming', ttlMs: 60_000 });
  w.orch.startRun({
    runId: 'r-lock',
    goal: 'g',
    plan: [{ id: 'cal', tool: 'calendar_upcoming', args: {}, run: calendarUpcomingRun({ service: svc, db: {}, todayIso: TODAY }) }],
  });
  w.orch.step('r-lock');
  w.orch.step('r-lock');
  const state = w.orch.getRun('r-lock');
  const stateJson = JSON.stringify(state);
  assert.equal(stateJson.includes('Very Private Meeting'), false);
  assert.equal(stateJson.includes('Doctor Visit'), false);
  assert.equal(stateJson.includes('rows'), false);
  const proj = projectRun(state);
  const projJson = JSON.stringify(proj);
  assert.equal(projJson.includes('Very Private Meeting'), false);
  assert.equal(projJson.includes('location'), false);
  assert.equal(projJson.includes('rows'), false);
});

async function driverWorld() {
  const state = { bytes: null, now: NOW };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const clock = () => state.now;
  const registry = createRegistry();
  registry.define(CALENDAR_UPCOMING_DEF);
  const audit = createAuditLog({ clock });
  const approvals = createApprovalDesk({ clock });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock });
  const notifications = createNotificationDesk({ clock });
  const reminders = createReminderBook({ clock });
  const p = createAgentPersistence({ db, clock, registry, audit, approvals, engine, emergencyStop: stop, notifications, reminders });
  const loaded = p.load();
  assert.equal(loaded.ok, true, 'world must load clean: ' + JSON.stringify(loaded.problems));
  const orch = createOrchestrator({ engine, approvals, emergencyStop: stop, audit: p.durableAudit(), clock });
  const svc = fakeService([occ(0, 'Standup'), occ(1, 'Review')]);
  const driver = createRunDriver({ orchestrator: orch, persistence: p, notifications, registry, clock, randomHex: () => 'abc123' });
  return { driver, engine, svc, p, notifications, audit };
}

test('driver end-to-end: the real tool completes, the ledger mirrors it, the terminal notification fires', async () => {
  const w = await driverWorld();
  assert.equal(w.engine.grantTool({ tool: 'calendar_upcoming', ttlMs: 60_000 }).ok, true);
  const r = w.driver.run({
    goal: 'check my calendar',
    kind: 'user',
    plan: [{ id: 'cal', tool: 'calendar_upcoming', args: {}, run: calendarUpcomingRun({ service: w.svc, db: {}, todayIso: TODAY }) }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state, 'completed');
  assert.equal(r.ledgerFinished, true);
  assert.equal(r.notified, true);
  assert.match(String(r.notificationId), /^ntf-\d{6}$/);
  const rows = w.p.listRuns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'succeeded');
  assert.equal(rows[0].kind, 'user');
  assert.equal(w.notifications.list()[0].title, 'Agent run completed');
  const actions = w.audit.read({}).map((e) => e.action);
  assert.equal(actions.includes('run.completed'), true);
});

test('driver end-to-end: without a grant the run aborts with the stopped notification', async () => {
  const w = await driverWorld();
  const r = w.driver.run({
    goal: 'g',
    kind: 'user',
    plan: [{ id: 'cal', tool: 'calendar_upcoming', args: {}, run: calendarUpcomingRun({ service: w.svc, db: {}, todayIso: TODAY }) }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'aborted');
  assert.equal(w.svc.calls.length, 0);
  assert.equal(w.notifications.list()[0].title, 'Agent run stopped');
});

test('grants are audited before they take effect; a refused append refuses the grant (Stage B 5)', () => {
  const registry = createRegistry();
  registry.define(CALENDAR_UPCOMING_DEF);
  const audit = createAuditLog({ clock: () => NOW });
  const approvals = createApprovalDesk({ clock: () => NOW });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, audit, clock: () => NOW });
  const g = engine.grantTool({ tool: 'calendar_upcoming', ttlMs: 60_000 });
  assert.equal(g.ok, true);
  const grants = audit.read({}).filter((e) => e.action === 'grant.granted');
  assert.equal(grants.length, 1);
  assert.equal(grants[0].actor, 'user');
  assert.equal(grants[0].detail.tool, 'calendar_upcoming');
  assert.equal(grants[0].detail.expires_at, g.grant.expiresAt);
  assert.equal(engine.authorize({ tool: 'calendar_upcoming', args: {} }).allowed, true);
  assert.equal(engine.revoke('calendar_upcoming').ok, true);
  const revokes = audit.read({}).filter((e) => e.action === 'grant.revoked');
  assert.equal(revokes.length, 1);
  assert.equal(revokes[0].actor, 'user');
  assert.equal(revokes[0].detail.tool, 'calendar_upcoming');
  assert.equal(engine.authorize({ tool: 'calendar_upcoming', args: {} }).allowed, false);

  // A hostile audit sink refuses the grant fail closed: no grant, no state.
  const hostile = { append: () => ({ ok: false, errors: ['hostile'] }) };
  const engine2 = createPolicyEngine({ registry, approvals, emergencyStop: stop, audit: hostile, clock: () => NOW });
  const g2 = engine2.grantTool({ tool: 'calendar_upcoming', ttlMs: 60_000 });
  assert.equal(g2.ok, false);
  assert.equal(g2.reason, 'grant_audit_failed');
  assert.equal(engine2.authorize({ tool: 'calendar_upcoming', args: {} }).allowed, false, 'no grant exists');

  // A grant made while the sink was healthy still cannot be revoked on a
  // broken sink: the revocation is refused and the grant stays active.
  const flaky = { append: () => { throw new Error('sink exploded'); } };
  const engine3 = createPolicyEngine({ registry, approvals, emergencyStop: stop, audit: flaky, clock: () => NOW });
  assert.equal(engine3.grantTool({ tool: 'calendar_upcoming', ttlMs: 60_000 }).ok, false);
  assert.equal(engine3.revoke('calendar_upcoming').ok, false);
});

test('an unexpiring grant is audited without an expiry field', () => {
  const registry = createRegistry();
  registry.define(CALENDAR_UPCOMING_DEF);
  const audit = createAuditLog({ clock: () => NOW });
  const approvals = createApprovalDesk({ clock: () => NOW });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, audit, clock: () => NOW });
  assert.equal(engine.grantTool({ tool: 'calendar_upcoming' }).ok, true);
  const grants = audit.read({}).filter((e) => e.action === 'grant.granted');
  assert.equal(grants.length, 1);
  assert.equal(grants[0].detail.expires_at, undefined);
});

test('hydrate skips are audited once as a bounded system entry; a broken sink refuses the hydrate', () => {
  const registry = createRegistry();
  registry.define(CALENDAR_UPCOMING_DEF);
  const audit = createAuditLog({ clock: () => NOW });
  const approvals = createApprovalDesk({ clock: () => NOW });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, audit, clock: () => NOW });
  const h = engine.hydrateGrants([
    { tool: 'calendar_upcoming', capability: 'read_only', grantedAt: 1, expiresAt: null, revoked: false },
    { tool: 'ghost.tool', capability: 'read_only', grantedAt: 1, expiresAt: null, revoked: false },
  ]);
  assert.deepEqual({ ok: h.ok, restored: h.restored, skipped: h.skipped }, { ok: true, restored: 1, skipped: 1 });
  const skips = audit.read({}).filter((e) => e.action === 'grant.hydrate_skipped');
  assert.equal(skips.length, 1, 'exactly one bounded entry, not one per skipped row');
  assert.equal(skips[0].actor, 'system');
  assert.equal(skips[0].detail.skipped, 1);
  const clean = engine.hydrateGrants([]);
  assert.equal(clean.skipped, 0);
  assert.equal(audit.read({}).filter((e) => e.action === 'grant.hydrate_skipped').length, 1, 'no entry when nothing was skipped');

  const hostile = { append: () => ({ ok: false, errors: ['hostile'] }) };
  const engine2 = createPolicyEngine({ registry, approvals, emergencyStop: stop, audit: hostile, clock: () => NOW });
  const h2 = engine2.hydrateGrants([
    { tool: 'calendar_upcoming', capability: 'read_only', grantedAt: 1, expiresAt: null, revoked: false },
    { tool: 'ghost.tool', capability: 'read_only', grantedAt: 1, expiresAt: null, revoked: false },
  ]);
  assert.equal(h2.ok, false);
  assert.equal(h2.reason, 'grant_hydrate_audit_failed');
  assert.equal(engine2.authorize({ tool: 'calendar_upcoming', args: {} }).allowed, false, 'nothing was restored on refusal');
});

test('an engine without an audit sink behaves exactly as before (backward compatible)', () => {
  const w = stack();
  assert.equal(w.engine.grantTool({ tool: 'calendar_upcoming', ttlMs: 60_000 }).ok, true);
  assert.equal(w.engine.authorize({ tool: 'calendar_upcoming', args: {} }).allowed, true);
  assert.equal(w.engine.revoke('calendar_upcoming').ok, true);
  assert.equal(w.engine.hydrateGrants([{ tool: 'calendar_upcoming', capability: 'read_only', grantedAt: 1, expiresAt: null, revoked: false }]).ok, true);
});
