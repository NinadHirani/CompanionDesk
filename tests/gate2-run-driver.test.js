'use strict';

// Gate 2 slice 3j.9, Stage A: the run driver foundation. The driver is the
// ONLY main-side caller of orchestrator startRun/step/resume, the ledger
// mirrors every run, terminal notifications exist for completed/aborted
// only, restart reconciliation (D4) aborts stale running rows with one
// bounded audit entry, the renderer projection never sees step arguments
// (D6), and the kind allowlist distinguishes user-requested runs (D7).
// The shipped registry is empty and nothing in main registers tools, so no
// step can execute in this build.

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
const { createOrchestrator } = require('../src/agent-orchestrator');
const { createRunDriver, RUN_ID_RE } = require('../src/agent-run-driver');
const { projectRun } = require('../src/agent-surface');

const NOW = 1_700_000_000_000;

function fixtures() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 } } } });
  registry.define({ name: 'notes.rename_tag', description: 'Rename a tag (reversible fixture)', capability: 'reversible_write', schema: { properties: { from: { type: 'string', required: true, maxLength: 64 }, to: { type: 'string', required: true, maxLength: 64 } } } });
  registry.define({ name: 'payments.charge', description: 'Charge a payment (sensitive fixture)', capability: 'sensitive', critical: true, schema: { properties: { amount: { type: 'integer' }, currency: { type: 'string', maxLength: 8 } } } });
  registry.define({ name: 'system.exec', description: 'Run a command (forbidden fixture)', capability: 'forbidden', schema: { properties: { cmd: { type: 'string' } } } });
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
  const orch = createOrchestrator({ engine, approvals, emergencyStop: stop, audit: p.durableAudit(), clock });
  return { db, state, clock, registry, audit, approvals, stop, engine, notifications, reminders, p, orch };
}

function makeDriver(w, overrides = {}) {
  return createRunDriver({
    orchestrator: overrides.orchestrator || w.orch,
    persistence: overrides.persistence || w.p,
    notifications: overrides.notifications || w.notifications,
    registry: overrides.registry || w.registry,
    clock: () => w.state.now,
    randomHex: () => 'abc123',
  });
}

function auditActions(w) {
  return w.audit.read({}).map((e) => e.action);
}

const GOOD_STEP = { id: 's1', tool: 'notes.search', args: { query: 'x' }, run: () => ({ ok: true }) };

test('the driver refuses construction without every dependency', async () => {
  const w = await world();
  for (const missing of ['orchestrator', 'persistence', 'notifications', 'registry']) {
    const args = { orchestrator: w.orch, persistence: w.p, notifications: w.notifications, registry: w.registry };
    args[missing] = null;
    assert.throws(() => createRunDriver(args), TypeError, 'missing ' + missing + ' must throw');
  }
});

test('a completed run is mirrored in the ledger, notified once, and audited', async () => {
  const w = await world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  const driver = makeDriver(w);
  const r = driver.run({
    goal: 'find notes',
    kind: 'user',
    plan: [
      { id: 's1', tool: 'notes.search', args: { query: 'x' }, run: () => ({ ok: true, summary: 'found' }) },
      { id: 's2', tool: 'notes.search', args: { query: 'y' }, run: () => ({ ok: true }) },
    ],
  });
  assert.equal(r.ok, true);
  assert.match(r.runId, RUN_ID_RE);
  assert.match(r.runId, /^run-/);
  assert.equal(r.state, 'completed');
  assert.equal(r.ledgerStarted, true);
  assert.equal(r.ledgerFinished, true);
  assert.equal(r.notified, true);
  assert.match(String(r.notificationId), /^ntf-\d{6}$/);
  assert.equal(r.saved, true);
  const rows = w.p.listRuns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, r.runId);
  assert.equal(rows[0].kind, 'user'); // D7
  assert.equal(rows[0].status, 'succeeded');
  const desk = w.notifications.list();
  assert.equal(desk.length, 1);
  assert.equal(desk[0].title, 'Agent run completed');
  assert.equal(desk[0].body, 'Run ' + r.runId + ' completed.');
  assert.equal(desk[0].priority, 'normal');
  const actions = auditActions(w);
  assert.equal(actions.includes('run.started'), true);
  assert.equal(actions.includes('run.completed'), true);
  assert.equal(w.orch.getRun(r.runId).state, 'completed');
});

test('an authorization-denied run aborts, is mirrored, and gets the stopped notification', async () => {
  const w = await world();
  const driver = makeDriver(w);
  const r = driver.run({ goal: 'g', kind: 'user', plan: [GOOD_STEP] });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'aborted');
  assert.equal(r.ledgerFinished, true);
  assert.equal(r.notified, true);
  const rows = w.p.listRuns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'aborted');
  const desk = w.notifications.list();
  assert.equal(desk.length, 1);
  assert.equal(desk[0].title, 'Agent run stopped');
  assert.equal(desk[0].body, 'Run ' + r.runId + ' was stopped.');
  assert.equal(auditActions(w).includes('run.aborted'), true);
});

test('an approval pause parks the run (D3): ledger stays running, nothing notifies, resume completes', async () => {
  const w = await world();
  assert.equal(w.engine.grantTool({ tool: 'payments.charge', ttlMs: 60_000 }).ok, true);
  const driver = makeDriver(w);
  const r = driver.run({
    goal: 'g',
    kind: 'user',
    plan: [{ id: 'c', tool: 'payments.charge', args: { amount: 5, currency: 'INR' }, needsApproval: true, run: () => ({ ok: true, summary: 'charged' }) }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'awaiting_approval');
  assert.equal(r.ledgerFinished, false);
  assert.equal(r.notified, false);
  assert.equal(w.p.listRuns()[0].status, 'running');
  assert.equal(w.notifications.list().length, 0);

  // A wrong-args approval never resumes the run.
  const wrong = w.approvals.request({ tool: 'payments.charge', args: { amount: 6, currency: 'INR' } }).approval;
  const rw = driver.resume(r.runId, { approvalId: wrong.id });
  assert.equal(rw.ok, false);
  assert.match(rw.reason, /approval_invalid/);
  assert.equal(w.orch.getRun(r.runId).state, 'awaiting_approval');

  const right = w.approvals.request({ tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).approval;
  const rr = driver.resume(r.runId, { approvalId: right.id });
  assert.equal(rr.ok, true);
  assert.equal(rr.state, 'completed');
  assert.equal(rr.ledgerFinished, true);
  assert.equal(rr.notified, true);
  assert.equal(w.p.listRuns()[0].status, 'succeeded');
  assert.equal(w.notifications.list().length, 1);
});

test('an emergency stop pauses the run; after a user reset the driver resumes it', async () => {
  const w = await world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  const driver = makeDriver(w);
  const r = driver.run({
    goal: 'g',
    kind: 'user',
    plan: [
      { id: 's1', tool: 'notes.search', args: { query: 'x' }, run: () => { assert.equal(w.stop.activate('user asked to stop', { by: 'user' }).ok, true); return { ok: true }; } },
      { id: 's2', tool: 'notes.search', args: { query: 'y' }, run: () => ({ ok: true }) },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'paused_stop');
  assert.equal(r.notified, false);
  assert.equal(w.p.listRuns()[0].status, 'running');
  // The completed step stands; the stop never rewinds it.
  assert.equal(auditActions(w).includes('run.step_succeeded'), true);

  assert.equal(w.stop.reset({ by: 'user' }).ok, true);
  const rr = driver.resume(r.runId, {});
  assert.equal(rr.ok, true);
  assert.equal(rr.state, 'completed');
  assert.equal(w.p.listRuns()[0].status, 'succeeded');
  assert.equal(w.notifications.list().length, 1);
});

test('pre-validation refuses every malformed run before anything starts (fail closed)', async () => {
  const w = await world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  const driver = makeDriver(w);
  const cases = [
    [{ plan: [GOOD_STEP], goal: 'g' }, 'kind_invalid'], // kind missing
    [{ plan: [GOOD_STEP], kind: 'scheduled', goal: 'g' }, 'kind_invalid'], // D7: no scheduled runs in Stage A
    [{ plan: [GOOD_STEP], kind: 'user', goal: 'g', runId: 'bad/id' }, 'run_id_invalid'],
    [{ plan: [GOOD_STEP], kind: 'user', goal: '' }, 'goal_invalid'],
    [{ plan: [GOOD_STEP], kind: 'user', goal: 'x'.repeat(201) }, 'goal_invalid'],
    [{ kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: [], kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: 'x', kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: Array.from({ length: 65 }, (_, i) => ({ id: 's' + i, tool: 'notes.search', args: { query: 'x' }, run: () => ({ ok: true }) })), kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: [{ id: 'a' }], kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: [{ id: 'a', tool: 'notes.search', args: { query: 'x' }, run: () => ({ ok: true }) }, { id: 'a', tool: 'notes.search', args: { query: 'x' }, run: () => ({ ok: true }) }], kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: [{ id: 'a', tool: 'notes.search', args: 'x', run: () => ({ ok: true }) }], kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: [{ id: 'a', tool: 'notes.search', args: { query: 'x' } }], kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: [{ id: 'a', tool: 'notes.search', args: { query: 'x' }, run: () => ({ ok: true }), retries: 4 }], kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: [{ id: 'a', tool: 'notes.search', args: { query: 'x' }, run: () => ({ ok: true }), recovery: 'ignore' }], kind: 'user', goal: 'g' }, 'plan_invalid'],
    [{ plan: [{ id: 'a', tool: 'nope.thing', args: {}, run: () => ({ ok: true }) }], kind: 'user', goal: 'g' }, 'plan_tool_unknown'],
    [{ plan: [{ id: 'a', tool: 'system.exec', args: {}, run: () => ({ ok: true }) }], kind: 'user', goal: 'g' }, 'plan_tool_forbidden'],
    [{ plan: [{ id: 'a', tool: 'notes.search', args: { query: 'x'.repeat(201) }, run: () => ({ ok: true }) }], kind: 'user', goal: 'g' }, 'plan_args_invalid'],
  ];
  for (const [input, expected] of cases) {
    const r = driver.run(input);
    assert.equal(r.ok, false);
    if (expected) assert.equal(r.reason, expected);
    assert.equal(w.p.listRuns().length, 0, 'no ledger row for ' + JSON.stringify(input).slice(0, 60));
    assert.equal(w.notifications.list().length, 0);
    assert.equal(Object.keys(w.orch.getRun && w.orch.getRun('zzz') || {}).length, 0);
  }
});

test('an empty registry refuses every plan: no tool can execute in the shipped app (D2)', async () => {
  const w = await world();
  const empty = createRegistry();
  assert.equal(empty.list().length, 0);
  const driver = makeDriver(w, { registry: empty });
  const r = driver.run({ goal: 'g', kind: 'user', plan: [GOOD_STEP] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'plan_tool_unknown');
  assert.equal(w.p.listRuns().length, 0);
});

test('a custom run id is honored; a duplicate id is refused by the orchestrator', async () => {
  const w = await world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  const driver = makeDriver(w);
  const r1 = driver.run({ runId: 'my-run_1', goal: 'g', kind: 'user', plan: [GOOD_STEP] });
  assert.equal(r1.ok, true);
  assert.equal(r1.runId, 'my-run_1');
  const r2 = driver.run({ runId: 'my-run_1', goal: 'g', kind: 'user', plan: [GOOD_STEP] });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /duplicate/);
});

test('a restart replay of the same run id never double-records or double-notifies', async () => {
  const w = await world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  const driver1 = makeDriver(w);
  const r1 = driver1.run({ runId: 'run-replay-1', goal: 'g', kind: 'user', plan: [GOOD_STEP] });
  assert.equal(r1.notified, true);
  // Fresh orchestrator (a restarted process); same ledger and desk.
  const orch2 = createOrchestrator({ engine: w.engine, approvals: w.approvals, emergencyStop: w.stop, audit: w.p.durableAudit(), clock: w.clock });
  const driver2 = makeDriver(w, { orchestrator: orch2 });
  const r2 = driver2.run({ runId: 'run-replay-1', goal: 'g', kind: 'user', plan: [GOOD_STEP] });
  assert.equal(r2.ok, true);
  assert.equal(r2.ledgerStarted, false);
  assert.equal(r2.ledgerStartReason, 'duplicate_run_id');
  assert.equal(r2.ledgerFinished, false);
  assert.equal(r2.notified, false);
  assert.equal(w.notifications.list().length, 1, 'exactly one notification, not two');
  assert.equal(w.p.listRuns().length, 1);
});

test('the desk-scan fallback also refuses a duplicate notification when the ledger is stubbed', async () => {
  const w = await world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  const created = w.notifications.create({ title: 'Agent run completed', body: 'Run run-dedupe-1 completed.', priority: 'normal' });
  assert.equal(created.ok, true);
  const stubP = {
    startRun: (x) => w.p.startRun(x),
    finishRun: () => ({ ok: true }),
    save: () => w.p.save(),
  };
  const driver = makeDriver(w, { persistence: stubP });
  const r = driver.run({ runId: 'run-dedupe-1', goal: 'g', kind: 'user', plan: [GOOD_STEP] });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'completed');
  assert.equal(r.ledgerFinished, true);
  assert.equal(r.notified, false);
  assert.equal(r.notifyReason, 'already_delivered');
  assert.equal(w.notifications.list().length, 1);
});

test('a notification failure never changes the run outcome (D5)', async () => {
  const w = await world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  const refusing = { create: () => ({ ok: false, reason: 'queue_full' }), list: () => w.notifications.list() };
  const throwing = { create: () => { throw new Error('desk exploded'); }, list: () => w.notifications.list() };
  for (const stub of [refusing, throwing]) {
    const fresh = await world();
    assert.equal(fresh.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
    const driver = makeDriver(fresh, { notifications: stub });
    const r = driver.run({ goal: 'g', kind: 'user', plan: [GOOD_STEP] });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'completed');
    assert.equal(r.ledgerFinished, true);
    assert.equal(fresh.p.listRuns()[0].status, 'succeeded');
    assert.equal(r.notified, false);
    assert.equal(['queue_full', 'notification_error'].includes(r.notifyReason), true);
    assert.equal(auditActions(fresh).includes('run.completed'), true);
  }
});

test('D4 restart reconciliation aborts stale running rows with exactly one audit entry', async () => {
  const w = await world();
  w.p.startRun({ runId: 'run-int-a', kind: 'user' });
  w.p.startRun({ runId: 'run-int-b', kind: 'user' });
  const rec = w.p.reconcileInterruptedRuns();
  assert.equal(rec.ok, true);
  assert.equal(rec.interrupted, 2);
  const rows = w.p.listRuns();
  for (const row of rows) {
    assert.equal(row.status, 'aborted');
    assert.equal(row.summary, 'interrupted_by_restart');
    assert.notEqual(row.ended_at, null);
  }
  const interrupts = w.audit.read({}).filter((e) => e.action === 'run.interrupted');
  assert.equal(interrupts.length, 1, 'exactly one bounded entry, not one per row');
  assert.equal(interrupts[0].actor, 'system');
  const again = w.p.reconcileInterruptedRuns();
  assert.equal(again.ok, true);
  assert.equal(again.interrupted, 0);
  assert.equal(w.audit.read({}).filter((e) => e.action === 'run.interrupted').length, 1, 'no entry when nothing was interrupted');
});

test('D4 reconciliation refuses and leaves rows untouched when the audit append fails', async () => {
  const w = await world();
  const hostile = Object.assign({}, w.audit, { append: () => ({ ok: false, errors: ['hostile'] }) });
  const fresh = await world();
  const p2 = createAgentPersistence({
    db: fresh.db, clock: fresh.clock, registry: fresh.registry, audit: hostile,
    approvals: fresh.approvals, engine: fresh.engine, emergencyStop: fresh.stop,
    notifications: fresh.notifications, reminders: fresh.reminders,
  });
  assert.equal(p2.load().ok, true);
  p2.startRun({ runId: 'run-int-c', kind: 'user' });
  const rec = p2.reconcileInterruptedRuns();
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, 'audit_refused');
  assert.equal(p2.listRuns()[0].status, 'running', 'rows untouched on refusal');
});

test('D6 the renderer projection never carries step arguments or approval ids', () => {
  const proj = projectRun({
    runId: 'run-x',
    goal: 'g',
    state: 'awaiting_approval',
    stepIndex: 0,
    attempts: { s1: 1 },
    startedAt: new Date(NOW).toISOString(),
    pendingApproval: { stepId: 's1', tool: 'payments.charge', args: { card: '4111111111111111', secret: 'x' }, approvalId: 'abc123def456' },
  });
  const json = JSON.stringify(proj);
  assert.equal(json.includes('args'), false);
  assert.equal(json.includes('card'), false);
  assert.equal(json.includes('secret'), false);
  assert.equal(json.includes('approvalId'), false);
  assert.equal(proj.pendingStepId, 's1');
  assert.equal(proj.pendingTool, 'payments.charge');
  assert.equal(proj.runId, 'run-x');
});

test('the defensive loop guard stops an unprogressing run without a terminal transition', () => {
  const stubOrch = {
    startRun: () => ({ ok: true, run: {} }),
    step: () => ({ ok: true, state: 'running' }),
    resume: () => ({ ok: false, reason: 'unused' }),
    getRun: () => null,
  };
  const stubP = { startRun: () => ({ ok: true }), finishRun: () => ({ ok: true }), save: () => ({ ok: true }) };
  const stubN = { create: () => ({ ok: true, notification: { id: 'ntf-000001' } }), list: () => [] };
  const driver = createRunDriver({ orchestrator: stubOrch, persistence: stubP, notifications: stubN, registry: fixtures() });
  const r = driver.run({ goal: 'g', kind: 'user', plan: [GOOD_STEP] });
  assert.equal(r.ok, true);
  assert.equal(r.stopped, 'loop_guard');
  assert.equal(r.ledgerFinished, false);
  assert.equal(r.notified, false);
  assert.equal(r.saved, true);
});

test('static guards: the driver stays pure, main wires it without registering tools, the renderer never sees it', () => {
  const fs = require('node:fs');
  const strip = (t) => t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const driverSrc = strip(fs.readFileSync('src/agent-run-driver.js', 'utf8'));
  for (const bad of ['setTimeout', 'setInterval', "require('electron')", 'child_process', 'http.request', 'https.request', "require('net')", 'XMLHttpRequest', 'fetch(']) {
    assert.equal(driverSrc.includes(bad), false, 'driver must not contain ' + bad);
  }
  const persistenceSrc = strip(fs.readFileSync('src/agent-persistence.js', 'utf8'));
  for (const bad of ['setTimeout', 'setInterval', "require('electron')", 'child_process']) {
    assert.equal(persistenceSrc.includes(bad), false, 'persistence must not contain ' + bad);
  }
  const mainSrc = fs.readFileSync('src/main.js', 'utf8');
  assert.equal(mainSrc.includes('createRunDriver('), true, 'main constructs the driver');
  assert.equal(mainSrc.includes('reconcileInterruptedRuns()'), true, 'main reconciles interrupted runs at startup');
  // Gate 2 enable step (26 Nov 2026, approved by Ninad), widened by the
  // Gate 4 approval (26 Nov), the AI-access connector flow (27 Nov), the
  // file-output enable (28 Nov 2026) and the Stage B calendar projection
  // enable (28 Nov 2026, Ninad's standing authorization): main carries
  // EXACTLY FIVE registration literals - the scheduling gate's, the
  // file-access gate's, the connector status/request tool's, the
  // file-output tool's and the Stage B calendar projection's definitions,
  // nothing else.
  const mainDefines = mainSrc.split('.define(').length - 1;
  assert.equal(mainDefines, 5, 'exactly five registration literals, got ' + mainDefines);
  assert.ok(mainSrc.includes('agentRegistry.define(SCHEDULING_TOOL_DEFINITION)'), 'the enable registers the scheduling gate definition');
  assert.ok(mainSrc.includes('agentRegistry.define(FILE_ACCESS_TOOL_DEFINITION)'), 'the enable registers the file-access gate definition');
  assert.ok(mainSrc.includes('agentRegistry.define(CONNECTORS_TOOL_DEFINITION)'), 'the connector status/request tool is the third registration');
  assert.ok(mainSrc.includes('agentRegistry.define(FILE_OUTPUT_TOOL_DEFINITION)'), 'the file-output tool is the fourth registration');
  assert.ok(mainSrc.includes('agentRegistry.define(CALENDAR_UPCOMING_DEF)'), 'the Stage B calendar projection is the fifth registration');
  assert.equal(strip(mainSrc).includes('requestRun('), false, 'no executable call site of requestRun in main');
  const preloadSrc = fs.readFileSync('src/preload.js', 'utf8');
  assert.equal(preloadSrc.includes('run-driver'), false);
  const rendererFiles = ['renderer/app.js', 'renderer/index.html'].filter((f) => fs.existsSync(f));
  for (const f of rendererFiles) {
    assert.equal(fs.readFileSync(f, 'utf8').includes('run-driver'), false, f + ' must not reference the driver');
  }
  // The preload notification channels stay exactly the two 3j.5 ones.
  assert.equal(preloadSrc.includes("'notifications:read'"), true);
  assert.equal(preloadSrc.includes("'notifications:ack'"), true);
});
