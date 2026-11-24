'use strict';

// Gate 2 slice 3: orchestrator tests. Plan validation, the happy path,
// authorization and stop semantics, approval pauses, bounded retries,
// recovery policies, and the audit trail. Pure modules only: no wiring, no
// real tools, no persistence.

const test = require('node:test');
const assert = require('node:assert');
const { createRegistry } = require('../src/tool-registry.js');
const { createPolicyEngine } = require('../src/policy-engine.js');
const { createApprovalDesk } = require('../src/approval.js');
const { createEmergencyStop } = require('../src/emergency-stop.js');
const { createAuditLog } = require('../src/audit.js');
const { createOrchestrator } = require('../src/agent-orchestrator.js');

function fixtures() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 } } } });
  registry.define({ name: 'notes.rename_tag', description: 'Rename a tag (reversible fixture)', capability: 'reversible_write', schema: { properties: { from: { type: 'string', required: true, maxLength: 64 }, to: { type: 'string', required: true, maxLength: 64 } } } });
  registry.define({ name: 'payments.charge', description: 'Charge a payment (sensitive fixture)', capability: 'sensitive', schema: { properties: { amount: { type: 'integer', required: true }, currency: { type: 'string', required: true, maxLength: 8 } } } });
  return registry;
}

function world() {
  const state = { now: 1_700_000_000_000 };
  const registry = fixtures();
  const audit = createAuditLog({ clock: () => state.now });
  const approvals = createApprovalDesk({ clock: () => state.now });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock: () => state.now });
  const orch = createOrchestrator({ engine, approvals, emergencyStop: stop, audit, clock: () => state.now });
  return { state, registry, audit, approvals, stop, engine, orch };
}

function actions(w) {
  return w.audit.snapshot().entries.map((e) => e.action);
}

test('a clean two-step run completes and audits every transition', () => {
  const w = world();
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  assert.equal(w.engine.grantTool({ tool: 'notes.rename_tag', ttlMs: 60_000 }).ok, true);
  const started = w.orch.startRun({
    runId: 'r1',
    goal: 'tidy tags',
    plan: [
      { id: 'find', tool: 'notes.search', args: { query: 'old' }, run: () => ({ ok: true, summary: '3 notes' }) },
      { id: 'rename', tool: 'notes.rename_tag', args: { from: 'a', to: 'b' }, run: () => ({ ok: true }) },
    ],
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const s1 = w.orch.step('r1');
  assert.equal(s1.ok, true);
  assert.equal(s1.state, 'running');
  assert.equal(s1.result.summary, '3 notes');
  const s2 = w.orch.step('r1');
  assert.equal(s2.ok, true);
  const done = w.orch.step('r1');
  assert.equal(done.state, 'completed');
  const run = w.orch.getRun('r1');
  assert.equal(run.state, 'completed');
  assert.deepEqual(actions(w), [
    'run.started', 'run.step_started', 'run.step_succeeded',
    'run.step_started', 'run.step_succeeded', 'run.completed',
  ]);
});

test('plan validation refuses malformed plans', () => {
  const w = world();
  const bad = [
    [{ runId: 'x', plan: [] }, 'plan_empty'],
    [{ id: 'a', tool: 'notes.search', args: {}, run: () => ({ ok: true }) }, 'run_id_invalid'],
    [{ runId: 'x', plan: Array.from({ length: 65 }, (_, i) => ({ id: `s${i}`, tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) })) }, 'plan_too_long'],
    [{ runId: 'x', plan: [{ id: 'a', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) }, { id: 'a', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) }] }, 'step_id_duplicate'],
    [{ runId: 'x', plan: [{ id: 'a', tool: 'notes.search', args: { query: 'q' } }] }, 'step_run_missing'],
    [{ runId: 'x', plan: [{ id: 'a', tool: 'notes.search', args: 'not-an-object', run: () => ({ ok: true }) }] }, 'step_args_invalid'],
    [{ runId: 'x', plan: [{ id: 'a', tool: 'notes.search', args: {}, run: () => ({ ok: true }), retries: 9 }] }, 'step_retries_invalid'],
    [{ runId: 'x', plan: [{ id: 'a', tool: 'notes.search', args: {}, run: () => ({ ok: true }), recovery: 'ignore' }] }, 'step_recovery_invalid'],
    [{ runId: 'x', plan: [{ id: 'a', tool: 'notes.search', args: {}, run: () => ({ ok: true }), verify: 'nope' }] }, 'step_verify_invalid'],
  ];
  for (const [arg, reason] of bad) {
    assert.equal(w.orch.startRun(arg).reason, reason, reason);
  }
});

test('a denied authorization aborts the run and is never skippable', () => {
  const w = world();
  // No grant for the sensitive tool: even recovery: 'skip' must not bypass it.
  w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  const started = w.orch.startRun({
    runId: 'r1',
    plan: [
      { id: 'a', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) },
      { id: 'b', tool: 'payments.charge', args: { amount: 1, currency: 'INR' }, run: () => ({ ok: true }), recovery: 'skip' },
    ],
  });
  assert.equal(started.ok, true);
  assert.equal(w.orch.step('r1').ok, true);
  const s2 = w.orch.step('r1');
  assert.equal(s2.ok, false);
  assert.equal(s2.state, 'aborted');
  assert.match(s2.reason, /no_grant|denied/);
  assert.equal(w.orch.getRun('r1').state, 'aborted');
  assert.equal(actions(w).includes('run.step_denied'), true);
  assert.equal(actions(w).includes('run.aborted'), true);
});

test('an approval-gated step pauses and never executes without the user\'s yes', () => {
  const w = world();
  // The engine's contract: a critical tool needs a standing grant AND a
  // fresh, exact approval for the one call.
  assert.equal(w.engine.grantTool({ tool: 'payments.charge', ttlMs: 60_000 }).ok, true);
  const started = w.orch.startRun({
    runId: 'r1',
    plan: [{ id: 'charge', tool: 'payments.charge', args: { amount: 5, currency: 'INR' }, needsApproval: true, run: () => ({ ok: true, summary: 'charged' }) }],
  });
  assert.equal(started.ok, true);
  const s = w.orch.step('r1');
  assert.equal(s.state, 'awaiting_approval');
  assert.equal(s.tool, 'payments.charge');
  const run = w.orch.getRun('r1');
  assert.equal(run.state, 'awaiting_approval');
  assert.equal(run.pendingApproval.tool, 'payments.charge');

  // No approval id: refusal, still paused.
  assert.equal(w.orch.resume('r1', {}).reason, 'approval_id_required');
  // A fabricated id: refused through the engine's approval check.
  const fabricated = w.orch.resume('r1', { approvalId: 'deadbeefdeadbeef' });
  assert.equal(fabricated.reason, 'approval_invalid');
  assert.match(fabricated.approvalReason, /approval_unknown/);

  // The user's yes creates the approval OUTSIDE the orchestrator; a wrong-args
  // one is refused at resume.
  const wrong = w.approvals.request({ tool: 'payments.charge', args: { amount: 6, currency: 'INR' } }).approval;
  const wrongResume = w.orch.resume('r1', { approvalId: wrong.id });
  assert.equal(wrongResume.reason, 'approval_invalid');
  assert.match(wrongResume.approvalReason, /args_mismatch/);
  const right = w.approvals.request({ tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).approval;
  assert.equal(w.orch.resume('r1', { approvalId: right.id }).ok, true);
  const s2 = w.orch.step('r1');
  assert.equal(s2.ok, true);
  assert.equal(s2.result.summary, 'charged');
  // The approval was consumed exactly once, before execution.
  assert.match(w.approvals.consume(right.id, { tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).reason, /approval_used/);
  assert.equal(w.orch.getRun('r1').pendingApproval, null);
  assert.equal(actions(w).includes('run.awaiting_approval'), true);
  assert.equal(actions(w).includes('run.resumed'), true);
});

test('an expired or already-used approval never resumes the run', () => {
  const w = world();
  assert.equal(w.engine.grantTool({ tool: 'payments.charge', ttlMs: 60_000 }).ok, true);
  const started = w.orch.startRun({
    runId: 'r1',
    plan: [{ id: 'charge', tool: 'payments.charge', args: { amount: 5, currency: 'INR' }, needsApproval: true, run: () => ({ ok: true }) }],
  });
  assert.equal(started.ok, true);
  assert.equal(w.orch.step('r1').state, 'awaiting_approval');
  const a = w.approvals.request({ tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).approval;
  w.approvals.consume(a.id, { tool: 'payments.charge', args: { amount: 5, currency: 'INR' } });
  const refused = w.orch.resume('r1', { approvalId: a.id });
  assert.equal(refused.reason, 'approval_invalid');
  assert.match(refused.approvalReason, /approval_used/);
  assert.equal(w.orch.getRun('r1').state, 'awaiting_approval');
});

test('an approval-gated step that fails goes back to the approval pause, never re-runs on a used approval', () => {
  const w = world();
  assert.equal(w.engine.grantTool({ tool: 'payments.charge', ttlMs: 60_000 }).ok, true);
  let calls = 0;
  const started = w.orch.startRun({
    runId: 'r1',
    plan: [{ id: 'charge', tool: 'payments.charge', args: { amount: 5, currency: 'INR' }, needsApproval: true, retries: 3, run: () => { calls += 1; return { ok: false, summary: 'declined' }; } }],
  });
  assert.equal(started.ok, true);
  assert.equal(w.orch.step('r1').state, 'awaiting_approval');
  const a = w.approvals.request({ tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).approval;
  assert.equal(w.orch.resume('r1', { approvalId: a.id }).ok, true);
  assert.equal(w.orch.step('r1').ok, true); // failed, consumed
  assert.equal(calls, 1);
  // The retry pauses for a FRESH approval instead of reusing the consumed one.
  const again = w.orch.step('r1');
  assert.equal(again.state, 'awaiting_approval');
  // The used approval cannot resume it.
  const refused = w.orch.resume('r1', { approvalId: a.id });
  assert.equal(refused.reason, 'approval_invalid');
  assert.match(refused.approvalReason, /approval_used/);
  assert.equal(calls, 1);
});

test('the emergency stop pauses a run mid-plan and only an explicit resume continues', () => {
  const w = world();
  w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  const started = w.orch.startRun({
    runId: 'r1',
    plan: [
      { id: 'a', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) },
      { id: 'b', tool: 'notes.search', args: { query: 'q2' }, run: () => ({ ok: true }) },
    ],
  });
  assert.equal(started.ok, true);
  assert.equal(w.orch.step('r1').ok, true);
  w.stop.activate('test', { by: 'user' });
  const s = w.orch.step('r1');
  assert.equal(s.state, 'paused_stop');
  assert.equal(w.orch.getRun('r1').state, 'paused_stop');
  // Resume refuses while the stop is active.
  assert.equal(w.orch.resume('r1', {}).reason, 'stop_active');
  assert.equal(w.orch.getRun('r1').state, 'paused_stop');
  // Deactivate, then resume explicitly.
  w.stop.reset({ by: 'user' });
  assert.equal(w.orch.resume('r1', {}).ok, true);
  const s2 = w.orch.step('r1');
  assert.equal(s2.ok, true);
  assert.equal(w.orch.step('r1').state, 'completed');
  assert.equal(actions(w).includes('run.paused_stop'), true);
  assert.equal(actions(w).includes('run.resumed'), true);
});

test('a run cannot start while the stop is active', () => {
  const w = world();
  w.stop.activate('test', { by: 'user' });
  const refused = w.orch.startRun({ runId: 'r1', plan: [{ id: 'a', tool: 'notes.search', args: {}, run: () => ({ ok: true }) }] });
  assert.equal(refused.reason, 'stop_active');
  assert.equal(w.orch.getRun('r1'), null);
});

test('bounded retries re-execute a failed step and then recovery decides', () => {
  const w = world();
  w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  let calls = 0;
  const started = w.orch.startRun({
    runId: 'r1',
    plan: [{ id: 'a', tool: 'notes.search', args: { query: 'q' }, retries: 1, run: () => { calls += 1; return { ok: calls >= 2, summary: `try ${calls}` }; } }],
  });
  assert.equal(started.ok, true);
  const s1 = w.orch.step('r1');
  assert.equal(s1.retrying, true);
  assert.equal(calls, 1);
  const s2 = w.orch.step('r1');
  assert.equal(s2.ok, true);
  assert.equal(s2.retrying, undefined);
  assert.equal(calls, 2);
  assert.equal(w.orch.step('r1').state, 'completed');
  assert.equal(actions(w).includes('run.step_failed'), true);
});

test('recovery skip continues past a failed step; the default aborts the run', () => {
  const w = world();
  w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  const skipRun = w.orch.startRun({
    runId: 'skip',
    plan: [
      { id: 'bad', tool: 'notes.search', args: { query: 'q' }, recovery: 'skip', run: () => ({ ok: false, summary: 'down' }) },
      { id: 'good', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) },
    ],
  });
  assert.equal(skipRun.ok, true);
  assert.equal(w.orch.step('skip').skipped, true);
  assert.equal(w.orch.step('skip').ok, true);
  assert.equal(w.orch.step('skip').state, 'completed');
  assert.equal(actions(w).includes('run.step_skipped'), true);

  const w2 = world();
  w2.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  const abortRun = w2.orch.startRun({
    runId: 'abort',
    plan: [{ id: 'bad', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: false }) }],
  });
  assert.equal(abortRun.ok, true);
  const s = w2.orch.step('abort');
  assert.equal(s.ok, false);
  assert.equal(s.state, 'aborted');
  assert.equal(actions(w2).includes('run.aborted'), true);
});

test('an uninterpretable step result fails closed, and a throwing step is a failure', () => {
  const w = world();
  w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  const started = w.orch.startRun({
    runId: 'r1',
    plan: [
      { id: 'weird', tool: 'notes.search', args: { query: 'q' }, recovery: 'skip', run: () => 'a bare string' },
      { id: 'throws', tool: 'notes.search', args: { query: 'q' }, recovery: 'skip', run: () => { throw new Error('boom'); } },
      { id: 'good', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) },
    ],
  });
  assert.equal(started.ok, true);
  assert.equal(w.orch.step('r1').skipped, true, 'bare string must fail closed');
  assert.equal(w.orch.step('r1').skipped, true, 'a throw must be a failure, not a crash');
  assert.equal(w.orch.step('r1').ok, true, 'the good step still runs');
  assert.equal(w.orch.step('r1').state, 'completed');
});

test('a verify hook can reject an ok result; a throwing verify is a failure', () => {
  const w = world();
  w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  const started = w.orch.startRun({
    runId: 'r1',
    plan: [
      { id: 'v', tool: 'notes.search', args: { query: 'q' }, recovery: 'skip', run: () => ({ ok: true, summary: 'looks fine' }), verify: () => ({ ok: false, summary: 'wrong shape' }) },
      { id: 'v2', tool: 'notes.search', args: { query: 'q' }, recovery: 'skip', run: () => ({ ok: true }), verify: () => { throw new Error('bad verifier'); } },
      { id: 'ok', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) },
    ],
  });
  assert.equal(started.ok, true);
  assert.equal(w.orch.step('r1').skipped, true);
  assert.equal(w.orch.step('r1').skipped, true);
  assert.equal(w.orch.step('r1').ok, true, 'the good step still runs');
  assert.equal(w.orch.step('r1').state, 'completed');
  const started2 = actions(w).filter((a) => a === 'run.step_failed').length;
  assert.equal(started2 >= 2, true);
});

test('only one run is active at a time; a finished run cannot step again', () => {
  const w = world();
  w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [{ id: 'a', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) }] }).ok, true);
  assert.equal(w.orch.startRun({ runId: 'r2', plan: [{ id: 'a', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) }] }).reason, 'active_run_exists');
  assert.equal(w.orch.step('r1').ok, true);
  assert.equal(w.orch.step('r1').state, 'completed');
  assert.equal(w.orch.step('r1').reason, 'run_finished');
  // A finished run releases the active slot.
  assert.equal(w.orch.startRun({ runId: 'r3', plan: [{ id: 'a', tool: 'notes.search', args: { query: 'q' }, run: () => ({ ok: true }) }] }).ok, true);
  // Unknown run ids refuse cleanly.
  assert.equal(w.orch.step('nope').reason, 'run_unknown');
  assert.equal(w.orch.resume('nope', {}).reason, 'run_unknown');
});

// ---------------------------------------------------------------------------
// Audit sink failures fail closed. The orchestrator must CHECK every
// audit.append result and treat a refusal or a throwing sink as fatal: no
// transition commits without its entry, the tool closure never runs without
// its step_started entry, and once unhealthy every further operation refuses.
// Recovery is a new orchestrator instance (a restart), never in-process.

function sinkWorld(sink) {
  const state = { now: 1_700_000_000_000 };
  const registry = fixtures();
  const audit = createAuditLog({ clock: () => state.now });
  const approvals = createApprovalDesk({ clock: () => state.now });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock: () => state.now });
  const wrapped = {
    append(entry) {
      const verdict = sink(entry, (e) => audit.append(e));
      return verdict === true ? audit.append(entry) : verdict;
    },
    snapshot: () => audit.snapshot(),
  };
  const orch = createOrchestrator({ engine, approvals, emergencyStop: stop, audit: wrapped, clock: () => state.now });
  return { state, registry, audit, approvals, stop, engine, orch };
}

const REFUSED = () => ({ ok: false, errors: ['sink_refused'] });

function refuseActions(...names) {
  return (entry, pass) => (names.includes(entry.action) ? REFUSED() : pass(entry));
}

function grantedSearchWorld(sink) {
  const w = sinkWorld(sink);
  w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  return w;
}

const SEARCH_STEP = (counter) => ({
  id: 'a',
  tool: 'notes.search',
  args: { query: 'q' },
  run: () => { counter.calls += 1; return { ok: true, summary: 'fine' }; },
});

test('a passthrough sink still completes a healthy run', () => {
  const counter = { calls: 0 };
  const w = grantedSearchWorld((entry, pass) => pass(entry));
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [SEARCH_STEP(counter)] }).ok, true);
  w.orch.step('r1');
  assert.equal(w.orch.step('r1').state, 'completed');
  assert.equal(counter.calls, 1);
});

test('a refused run.started entry registers nothing', () => {
  const w = grantedSearchWorld(refuseActions('run.started'));
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [SEARCH_STEP({ calls: 0 })] }).reason, 'audit_failed');
  assert.equal(w.orch.getRun('r1'), null);
});

test('a refused run.started entry poisons even after the sink recovers', () => {
  let refused = false;
  const w = grantedSearchWorld((entry, pass) => {
    if (!refused && entry.action === 'run.started') { refused = true; return REFUSED(); }
    return pass(entry);
  });
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [SEARCH_STEP({ calls: 0 })] }).reason, 'audit_failed');
  // The sink is healthy from here on; the instance stays poisoned.
  assert.equal(w.orch.startRun({ runId: 'r2', plan: [SEARCH_STEP({ calls: 0 })] }).reason, 'audit_failed');
  assert.equal(w.orch.getRun('r2'), null);
});

test('a refused step_started entry never invokes the tool closure', () => {
  const counter = { calls: 0 };
  const w = grantedSearchWorld(refuseActions('run.step_started'));
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [SEARCH_STEP(counter)] }).ok, true);
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
  assert.equal(counter.calls, 0);
  assert.equal(w.orch.getRun('r1').stepIndex, 0);
});

test('a refused step_succeeded entry discards the result and does not advance', () => {
  const counter = { calls: 0 };
  const w = grantedSearchWorld(refuseActions('run.step_succeeded'));
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [SEARCH_STEP(counter)] }).ok, true);
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
  assert.equal(counter.calls, 1, 'the closure ran, but its outcome is not committed');
  assert.equal(w.orch.getRun('r1').stepIndex, 0);
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
});

test('a refused step_failed entry prevents skip recovery from advancing', () => {
  const counter = { calls: 0 };
  const step = { ...SEARCH_STEP(counter), run: () => { counter.calls += 1; return { ok: false, summary: 'nope' }; }, retries: 0, recovery: 'skip' };
  const w = grantedSearchWorld(refuseActions('run.step_failed'));
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [step] }).ok, true);
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
  assert.equal(w.orch.getRun('r1').stepIndex, 0);
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
});

test('a refused step_skipped entry does not advance the run', () => {
  const counter = { calls: 0 };
  const step = { ...SEARCH_STEP(counter), run: () => { counter.calls += 1; return { ok: false }; }, retries: 0, recovery: 'skip' };
  const w = grantedSearchWorld(refuseActions('run.step_skipped'));
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [step] }).ok, true);
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
  assert.equal(w.orch.getRun('r1').stepIndex, 0);
});

test('a refused awaiting_approval entry never executes the gated step', () => {
  const counter = { calls: 0 };
  const w = grantedSearchWorld(refuseActions('run.awaiting_approval'));
  w.engine.grantTool({ tool: 'payments.charge', ttlMs: 60_000 });
  const step = { id: 'c', tool: 'payments.charge', args: { amount: 5, currency: 'INR' }, needsApproval: true, run: () => { counter.calls += 1; return { ok: true }; } };
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [step] }).ok, true);
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
  assert.equal(counter.calls, 0);
  assert.equal(w.orch.getRun('r1').state, 'running');
});

test('a refused resumed entry leaves the run paused', () => {
  const w = grantedSearchWorld(refuseActions('run.resumed'));
  w.engine.grantTool({ tool: 'payments.charge', ttlMs: 60_000 });
  const step = { id: 'c', tool: 'payments.charge', args: { amount: 5, currency: 'INR' }, needsApproval: true, run: () => ({ ok: true }) };
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [step] }).ok, true);
  assert.equal(w.orch.step('r1').state, 'awaiting_approval');
  const a = w.approvals.request({ tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).approval;
  assert.equal(w.orch.resume('r1', { approvalId: a.id }).reason, 'audit_failed');
  assert.equal(w.orch.getRun('r1').state, 'awaiting_approval');
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
});

test('a refused paused_stop entry leaves the run running', () => {
  const counter = { calls: 0 };
  const w = grantedSearchWorld(refuseActions('run.paused_stop'));
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [SEARCH_STEP(counter)] }).ok, true);
  w.stop.activate('test', { by: 'user' });
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
  assert.equal(counter.calls, 0);
  assert.equal(w.orch.getRun('r1').state, 'running');
});

test('a refused step_denied entry aborts nothing and poisons', () => {
  const counter = { calls: 0 };
  const w = grantedSearchWorld(refuseActions('run.step_denied'));
  // notes.search is granted, so use an ungranted tool for the denial.
  const step = { id: 'b', tool: 'notes.rename_tag', args: { from: 'a', to: 'b' }, run: () => { counter.calls += 1; return { ok: true }; } };
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [step] }).ok, true);
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
  assert.equal(counter.calls, 0);
  assert.equal(w.orch.getRun('r1').state, 'running');
});

test('a refused terminal aborted entry keeps the run unfinished and the slot held', () => {
  const counter = { calls: 0 };
  const w = grantedSearchWorld(refuseActions('run.aborted'));
  const step = { id: 'b', tool: 'notes.rename_tag', args: { from: 'a', to: 'b' }, run: () => { counter.calls += 1; return { ok: true }; } };
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [step] }).ok, true);
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
  assert.equal(counter.calls, 0);
  assert.equal(w.orch.getRun('r1').state, 'running', 'the terminal state is not committed without its entry');
  assert.notEqual(w.orch.activeRun(), null, 'the active slot is not released without the terminal entry');
});

test('a refused terminal completed entry keeps the run running and the slot held', () => {
  const counter = { calls: 0 };
  const w = grantedSearchWorld(refuseActions('run.completed'));
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [SEARCH_STEP(counter)] }).ok, true);
  w.orch.step('r1');
  assert.equal(w.orch.step('r1').reason, 'audit_failed');
  assert.equal(w.orch.getRun('r1').state, 'running');
  assert.notEqual(w.orch.activeRun(), null);
});

test('a throwing audit sink is handled like a refusal', () => {
  const w = grantedSearchWorld(() => { throw new Error('sink down'); });
  assert.equal(w.orch.startRun({ runId: 'r1', plan: [SEARCH_STEP({ calls: 0 })] }).reason, 'audit_failed');
  assert.equal(w.orch.getRun('r1'), null);
});
