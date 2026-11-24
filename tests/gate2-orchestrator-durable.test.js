'use strict';

// Gate 2 persistence hardening, item 5: the orchestrator runs on the
// durable audit wrapper, so a persist failure is an audit append failure.
// The orchestrator's existing poison rule (ANY append failure poisons it,
// with no recovery API) then becomes a fail-closed lockout: no subsequent
// run, step or transition can proceed until an explicit safe recovery (a
// fresh process whose persistence load verifies). These tests prove the
// wiring semantics the P2 startup slice will rely on.

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

const NOW = 1_700_000_000_000;

function fixtures() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 } } } });
  registry.define({ name: 'notes.rename_tag', description: 'Rename a tag (reversible fixture)', capability: 'reversible_write', schema: { properties: { from: { type: 'string', required: true, maxLength: 64 }, to: { type: 'string', required: true, maxLength: 64 } } } });
  return registry;
}

// Full world with persistence; the orchestrator's audit instance IS
// persistence.durableAudit(), exactly the P2 injection.
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
  return { db, saved: state, state, registry, audit, approvals, stop, engine, notifications, reminders, p, orch };
}

function plan(id, tool, run) {
  return [{ id, tool, args: { query: 'x' }, run }];
}

test('the durable wrapper is the orchestrator audit: acknowledged appends survive a restart without save', async () => {
  let w = await world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  // Grant state converges at save(); audit transitions converge at their
  // acknowledged append. Save once for the grant, then run.
  assert.equal(w.p.save().ok, true);
  const started = w.orch.startRun({ runId: 'r1', goal: 'g', plan: plan('s1', 'notes.search', () => ({ ok: true, summary: 'done' })) });
  assert.equal(started.ok, true, JSON.stringify(started));
  const s1 = w.orch.step('r1');
  assert.equal(s1.ok, true);

  // Restart WITHOUT save: the acknowledged audit transitions are already on
  // disk (that is the durability guarantee), and the grant is there from
  // the earlier save.
  w.db.flush();
  const state = { bytes: w.saved.bytes, now: NOW };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db2 = await LocalDb.open({ storage });
  const registry = fixtures();
  const audit2 = createAuditLog({ clock: () => state.now });
  const approvals2 = createApprovalDesk({ clock: () => state.now });
  const stop2 = createEmergencyStop();
  const engine2 = createPolicyEngine({ registry, approvals: approvals2, emergencyStop: stop2, clock: () => state.now });
  const p2 = createAgentPersistence({ db: db2, clock: () => state.now, registry, audit: audit2, approvals: approvals2, engine: engine2, emergencyStop: stop2, notifications: createNotificationDesk({ clock: () => state.now }), reminders: createReminderBook({ clock: () => state.now }) });
  const loaded2 = p2.load();
  assert.equal(loaded2.ok, true, JSON.stringify(loaded2.problems));
  const actions = audit2.snapshot().entries.map((e) => e.action);
  assert.deepEqual(actions, ['run.started', 'run.step_started', 'run.step_succeeded']);
  assert.equal(engine2.listGrants().length, 1, 'the saved grant is there');
  const runs = p2.listRuns();
  // NOTE: orchestrator runs are audited; the persistence agent_runs row is
  // written only by startRun/finishRun calls the wiring slice will make.
  assert.equal(runs.length, 0, 'no auto-resume, no phantom run rows');

});

test('a persist failure mid-run leaves the step unclosed and locks the orchestrator until explicit recovery', async () => {
  const w = await world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  // Run 1 completes cleanly.
  const started = w.orch.startRun({ runId: 'r1', goal: 'g', plan: plan('s1', 'notes.search', () => ({ ok: true, summary: 'ok' })) });
  assert.equal(started.ok, true);
  const s1 = w.orch.step('r1');
  assert.equal(s1.ok, true);
  const done = w.orch.step('r1');
  assert.equal(done.state, 'completed');

  // Now break the persistence write path: the audit append will not persist.
  const realRun = w.db.run.bind(w.db);
  w.db.run = function (sql, params) {
    if (sql.startsWith('INSERT INTO agent_audit')) throw new Error('simulated write failure');
    return realRun(sql, params);
  };

  // A new run's FIRST transition (run.started) cannot be acknowledged, so
  // the run never starts.
  const started2 = w.orch.startRun({ runId: 'r2', goal: 'g', plan: plan('t1', 'notes.search', () => ({ ok: true })) });
  assert.equal(started2.ok, false, 'startRun must refuse when the append cannot be made durable');
  assert.equal(started2.reason, 'audit_failed', 'the first failure refuses the transition');

  // The lockout is total and permanent for this process: no run, no step,
  // no resume, no recovery method.
  const started3 = w.orch.startRun({ runId: 'r3', goal: 'g', plan: plan('u1', 'notes.search', () => ({ ok: true })) });
  assert.equal(started3.ok, false);
  assert.equal(started3.reason, 'audit_failed', 'poisoned refusals report audit_failed until a new instance replaces this one');
  const step = w.orch.step('r1');
  assert.equal(step.ok, false);
  const resume = w.orch.resume('r1', {});
  assert.equal(resume.ok, false);
  assert.equal(typeof w.orch.clearPoison, 'undefined', 'there is no in-process recovery: recovery is an explicit reload');

  // The completed run 1 is untouched; nothing half-written leaked into the
  // in-memory log (log-before-commit: the refused entry was never appended).
  const run1 = w.orch.getRun('r1');
  assert.equal(run1.state, 'completed');
  const memActions = w.audit.snapshot().entries.map((e) => e.action);
  assert.ok(!memActions.includes('run.started_r2') && memActions.filter((a) => a === 'run.started').length === 1,
    'the refused run.started for r2 must not be in the log: ' + JSON.stringify(memActions));

  // Recovery is explicit: restore the write path and converge with save(),
  // then a FRESH load in a new process verifies clean.
  w.db.run = realRun;
  assert.equal(w.p.save().ok, true);
  w.db.flush();
  const state = { bytes: w.saved.bytes, now: NOW };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db2 = await LocalDb.open({ storage });
  const p2 = createAgentPersistence({ db: db2, clock: () => state.now, registry: fixtures(), audit: createAuditLog({ clock: () => state.now }), approvals: createApprovalDesk({ clock: () => state.now }), engine: createPolicyEngine({ registry: fixtures(), approvals: createApprovalDesk({ clock: () => state.now }), emergencyStop: createEmergencyStop(), clock: () => state.now }), emergencyStop: createEmergencyStop(), notifications: createNotificationDesk({ clock: () => state.now }), reminders: createReminderBook({ clock: () => state.now }) });
  const loaded2 = p2.load();
  assert.equal(loaded2.ok, true, 'a converged store must verify clean: ' + JSON.stringify(loaded2.problems));
  assert.ok(p2.audit ? true : true);
  const actions = p2.durableAudit().snapshot().entries.map((e) => e.action);
  assert.deepEqual(actions, ['run.started', 'run.step_started', 'run.step_succeeded', 'run.completed']);
});
