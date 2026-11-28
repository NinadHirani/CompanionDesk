'use strict';

// Gate 2 slice 3j.9, Stage C (28 Nov 2026): the per-call approval delivery
// path, decision D2 resolved as the OUT-OF-RENDERER surface. The renderer
// keeps zero run-control or approval channels (the preload contract is
// untouched); main shows a native dialog when a run parks at
// awaiting_approval. Approve issues the exact one-run approval and resumes
// through the driver (the driver stays the ONLY orchestrator caller).
// Deny, dismissal, or any presenter failure leaves the run parked (D3);
// nothing here can start a run, only answer one that already paused.

const test = require('node:test');
const assert = require('node:assert');

const LocalDb = require('../src/db');
const { createRegistry } = require('../src/tool-registry');
const { createPolicyEngine } = require('../src/policy-engine');
const { createApprovalDesk } = require('../src/approval');
const { createApprovalSurface, buildApprovalPrompt } = require('../src/approval-dialog');
const { createAuditLog } = require('../src/audit');
const { createEmergencyStop } = require('../src/emergency-stop');
const { createNotificationDesk } = require('../src/agent-notifications');
const { createReminderBook } = require('../src/agent-reminders');
const { createAgentPersistence } = require('../src/agent-persistence');
const { createOrchestrator } = require('../src/agent-orchestrator');
const { createRunDriver } = require('../src/agent-run-driver');

const NOW = 1_700_000_000_000;

function fixtures() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 } } } });
  registry.define({ name: 'payments.charge', description: 'Charge a payment (sensitive fixture)', capability: 'sensitive', critical: true, schema: { properties: { amount: { type: 'integer' }, currency: { type: 'string', maxLength: 8 } } } });
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

function fakeState(overrides = {}) {
  return Object.assign({
    runId: 'run-abc123',
    goal: 'charge the invoice',
    state: 'awaiting_approval',
    stepIndex: 0,
    steps: ['s1'],
    attempts: {},
    startedAt: new Date(NOW).toISOString(),
    finishedAt: null,
    pendingApproval: { stepId: 's1', tool: 'payments.charge', args: { amount: 5, currency: 'INR' } },
  }, overrides);
}

function fakeOrch(state) {
  return { getRun: (id) => (typeof id === 'string' && id === state.runId ? state : null) };
}

function fakeDriver(report) {
  const calls = [];
  return {
    calls,
    resume(runId, opts) { calls.push({ runId, opts }); return report; },
  };
}

function scriptedPresenter(answers) {
  const seen = [];
  return {
    seen,
    async present(prompt) { seen.push(prompt); return answers.length ? answers.shift() : null; },
  };
}

function makeSurface(state, driver, presenterAnswers, overrides = {}) {
  const p = scriptedPresenter(presenterAnswers);
  const surface = createApprovalSurface(Object.assign({
    driver,
    orchestrator: fakeOrch(state),
    desk: overrides.desk || createApprovalDesk({ clock: () => NOW }),
    presenter: p.present,
    registry: overrides.registry || fixtures(),
  }, overrides.extra || {}));
  return { surface, presenter: p };
}

test('the surface refuses construction without every dependency', () => {
  const driver = fakeDriver({ ok: true });
  const base = { driver, orchestrator: fakeOrch(fakeState()), desk: createApprovalDesk({ clock: () => NOW }), presenter: async () => 'deny' };
  for (const missing of ['driver', 'orchestrator', 'desk', 'presenter']) {
    const args = Object.assign({}, base);
    args[missing] = null;
    assert.throws(() => createApprovalSurface(args), TypeError, 'missing ' + missing + ' must throw');
  }
  assert.throws(() => createApprovalSurface(Object.assign({}, base, { maxArgsChars: -1 })), TypeError, 'bad maxArgsChars must throw');
});

test('the prompt builder bounds every field and never prints unserializable args', () => {
  const prompt = buildApprovalPrompt({
    runId: 'run-abc123',
    tool: 'payments.charge',
    args: { amount: 5, currency: 'INR' },
    goal: 'g'.repeat(500),
    description: 'Charge a payment (sensitive fixture)',
    maxArgsChars: 60,
  });
  assert.equal(prompt.title, 'CompanionDesk needs your approval');
  assert.equal(prompt.buttons.length, 2);
  assert.deepEqual(prompt.buttons, ['Approve', 'Deny']);
  assert.match(prompt.message, /payments\.charge/);
  assert.match(prompt.message, /run-abc123/);
  const goalLine = prompt.detail.split('\n')[0];
  assert.ok(goalLine.length <= 160 + 'Goal: '.length + 1, 'goal must be bounded, got ' + goalLine.length);
  const argsStart = prompt.detail.indexOf('Step asks for:');
  assert.ok(argsStart !== -1, 'detail must name the step arguments');
  const argsEnd = prompt.detail.indexOf('\n', argsStart);
  const argsText = prompt.detail.slice(argsStart + 'Step asks for:'.length, argsEnd);
  assert.ok(argsText.length <= 60 + 1, 'args summary must be bounded, got ' + argsText.length);
  assert.equal(prompt.detail.includes('Denying leaves the run parked'), true);

  const circular = { a: 1 };
  circular.self = circular;
  const p2 = buildApprovalPrompt({ runId: 'r', tool: 't', args: circular, goal: '', description: '' });
  assert.equal(p2.detail.includes('(unprintable arguments)'), true);
});

test('offer refuses before any presenter call when there is nothing to approve', async () => {
  const driver = fakeDriver({ ok: true });
  const badOrchestrators = [
    fakeOrch(fakeState({ runId: 'other' })),
    fakeOrch(fakeState({ state: 'running', pendingApproval: null })),
    fakeOrch(fakeState({ pendingApproval: { stepId: 's1', tool: '', args: {} } })),
  ];
  for (let i = 0; i < badOrchestrators.length; i++) {
    const p = scriptedPresenter(['approve']);
    const surface = createApprovalSurface({ driver, orchestrator: badOrchestrators[i], desk: createApprovalDesk({ clock: () => NOW }), presenter: p.present, registry: fixtures() });
    const r = await surface.offer('run-abc123');
    assert.equal(r.ok, false, 'case ' + i + ' must refuse');
    assert.equal(r.reason, 'no_pending_approval', 'case ' + i + ' reason');
    assert.equal(p.seen.length, 0, 'case ' + i + ' must not reach the presenter');
  }
  const p = scriptedPresenter(['approve']);
  const surface = createApprovalSurface({ driver, orchestrator: fakeOrch(fakeState()), desk: createApprovalDesk({ clock: () => NOW }), presenter: p.present, registry: fixtures() });
  const r0 = await surface.offer(undefined);
  assert.equal(r0.reason, 'run_id_invalid');
  assert.equal(p.seen.length, 0);
});

test('approve issues the exact one-run approval and resumes through the driver', async () => {
  const state = fakeState();
  const report = { ok: true, runId: state.runId, state: 'completed' };
  const driver = fakeDriver(report);
  const desk = createApprovalDesk({ clock: () => NOW });
  const { surface, presenter } = makeSurface(state, driver, ['approve'], { desk });
  const r = await surface.offer('run-abc123');
  assert.equal(r, report, 'the driver report passes through');
  assert.equal(driver.calls.length, 1);
  assert.equal(driver.calls[0].runId, 'run-abc123');
  assert.equal(typeof driver.calls[0].opts.approvalId, 'string');
  assert.match(driver.calls[0].opts.approvalId, /^[a-f0-9]{64}$/);
  assert.equal(desk.get(driver.calls[0].opts.approvalId).tool, 'payments.charge');
  assert.equal(presenter.seen.length, 1);
  assert.match(presenter.seen[0].message, /payments\.charge/);
  assert.equal(JSON.stringify(presenter.seen[0]).includes('amount'), true, 'the user must see what the step asks for');
});

test('deny or dismissal leaves the run parked with no approval and no resume', async () => {
  for (const answer of ['deny', null, undefined]) {
    const state = fakeState();
    const driver = fakeDriver({ ok: true });
    const desk = createApprovalDesk({ clock: () => NOW });
    const { surface } = makeSurface(state, driver, [answer], { desk });
    const r = await surface.offer('run-abc123');
    assert.equal(r.ok, true, 'answer ' + String(answer) + ' must resolve');
    assert.equal(r.decided, 'denied', 'answer ' + String(answer) + ' must deny');
    assert.equal(driver.calls.length, 0, 'answer ' + String(answer) + ' must not resume');
    assert.equal(desk.exportAll().length, 0, 'answer ' + String(answer) + ' must not request');
  }
});

test('a presenter failure leaves the run parked and requests nothing', async () => {
  const state = fakeState();
  const driver = fakeDriver({ ok: true });
  const desk = createApprovalDesk({ clock: () => NOW });
  const surface = createApprovalSurface({
    driver,
    orchestrator: fakeOrch(state),
    desk,
    presenter: () => { throw new Error('dialog gone'); },
    registry: fixtures(),
  });
  const r = await surface.offer('run-abc123');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'presenter_failed');
  assert.equal(driver.calls.length, 0);
  assert.equal(desk.exportAll().length, 0);
});

test('a refused approval request fail-closes without resuming', async () => {
  const state = fakeState({ pendingApproval: { stepId: 's1', tool: 'payments.charge', args: undefined } });
  const driver = fakeDriver({ ok: true });
  const { surface } = makeSurface(state, driver, ['approve']);
  const r = await surface.offer('run-abc123');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'approval_args_missing');
  assert.equal(driver.calls.length, 0);
});

test('end to end: no grant fail-closes, deny parks, approve completes', async () => {
  const w = await world();
  const driver = createRunDriver({
    orchestrator: w.orch,
    persistence: w.p,
    notifications: w.notifications,
    registry: w.registry,
    clock: () => w.state.now,
    randomHex: () => 'abc123',
  });
  const started = driver.run({
    goal: 'charge the invoice',
    kind: 'user',
    plan: [{ id: 's1', tool: 'payments.charge', args: { amount: 5, currency: 'INR' }, needsApproval: true, run: () => ({ ok: true, summary: 'charged' }) }],
  });
  assert.equal(started.ok, true);
  assert.equal(started.state, 'awaiting_approval');

  // Deny first: the run stays parked exactly as D3 says.
  const denySurface = createApprovalSurface({
    driver, orchestrator: w.orch, desk: w.approvals,
    presenter: async () => 'deny', registry: w.registry,
  });
  const denied = await denySurface.offer(started.runId);
  assert.equal(denied.ok, true);
  assert.equal(denied.decided, 'denied');
  assert.equal(w.orch.getRun(started.runId).state, 'awaiting_approval');

  // Approve WITHOUT the per-tool standing grant fails closed with the
  // engine's own reason and parks the run: the dialog delivers the per-call
  // yes only; a standing grant stays a separate, earlier user decision.
  const noGrantSurface = createApprovalSurface({
    driver, orchestrator: w.orch, desk: w.approvals,
    presenter: async () => 'approve', registry: w.registry,
  });
  const refused = await noGrantSurface.offer(started.runId);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'no_grant');
  assert.equal(w.orch.getRun(started.runId).state, 'awaiting_approval');

  // Grant the tool (a separate, earlier user decision), then one dialog
  // approval resumes the run through the driver to completion.
  assert.equal(w.engine.grantTool({ tool: 'payments.charge', ttlMs: 60_000 }).ok, true);
  const approved = await noGrantSurface.offer(started.runId);
  assert.equal(approved.ok, true);
  assert.equal(approved.state, 'completed');
  assert.equal(approved.ledgerFinished, true);
  assert.equal(w.orch.getRun(started.runId).state, 'completed');
  assert.equal(w.notifications.list().length, 1);
  assert.equal(w.p.listRuns()[0].status, 'succeeded');
});
