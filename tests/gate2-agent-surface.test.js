'use strict';
// Gate 2 wiring slice 1: the read-only agent surface (main side).
// Proves handlers exist exactly for the contract renderer channels, every
// request is validated before a reader runs, reader output is bounded,
// reader failures are refusals, and no main-only channel is reachable.

const test = require('node:test');
const assert = require('node:assert');
const { createAgentSurface, projectRun, boundedRecords, boundedRecord } = require('../src/agent-surface.js');
const {
  RENDERER_CHANNELS,
  MAIN_ONLY_CHANNELS,
  validatePreloadAllowlist,
} = require('../src/ipc-contract.js');

function fixtures(overrides) {
  const base = {
    status: () => ({ agentActive: true, stopped: false, activeRun: null, notificationsPending: 1, remindersScheduled: 2, auditEntries: 3 }),
    listRuns: (runId) => (runId
      ? []
      : [{ runId: 'r1', goal: 'g', state: 'running', stepIndex: 0, attempts: 0, startedAt: 1, finishedAt: null, steps: ['a', 'b'], pendingApproval: null }]),
    readAudit: () => ({
      base: { seq: 0, hash: 'genesis' },
      entries: [{ seq: 1, ts: 't', actor: 'system', action: 'x', hash: 'h', detail: { k: 'v' } }],
      lastHash: 'h',
      verified: true,
    }),
    listProviders: () => [{ name: 'ollama', up: true }],
    listNotifications: (limit) => [{ id: 'ntf-000001', title: 't', body: 'b', priority: 'normal', createdAt: 1, read: false }].slice(0, limit),
    listReminders: (limit) => [{ id: 'rem-000001', title: 't', dueAt: 2, notes: null, createdAt: 1, cancelled: false }].slice(0, limit),
  };
  return Object.assign(base, overrides || {});
}

test('surface: handlers exist exactly for the contract renderer channels', () => {
  const s = createAgentSurface(fixtures());
  assert.deepEqual(Object.keys(s.handlers).sort(), RENDERER_CHANNELS.slice().sort());
  assert.equal(validatePreloadAllowlist(Object.keys(s.handlers)).ok, true);
  assert.deepEqual(s.channels, RENDERER_CHANNELS);
});

test('surface: no main-only channel is reachable', () => {
  const s = createAgentSurface(fixtures());
  for (const ch of MAIN_ONLY_CHANNELS) assert.equal(s.handlers[ch], undefined, ch);
});

test('surface: invalid payloads are refused and readers never run', async () => {
  let calls = 0;
  const counting = fixtures({ listNotifications: (limit) => { calls += 1; return []; } });
  const s = createAgentSurface(counting);
  const h = s.handlers['notifications:read'];
  const labels = ['over_range', 'wrong_type', 'unknown_field', 'date_payload', 'throwing_getter'];
  const bad = [
    { limit: 501 },
    { limit: 'x' },
    { nope: 1 },
    new Date(),
    (() => { const p = {}; Object.defineProperty(p, 'limit', { enumerable: true, get() { throw new Error('boom'); } }); return p; })(),
  ];
  for (let i = 0; i < bad.length; i += 1) {
    const r = await h(bad[i]);
    assert.equal(r.ok, false, labels[i]); // never stringify: a getter could run
    assert.equal(r.error, 'refused');
    assert.equal(r.reason.length <= 64, true);
  }
  assert.equal(calls, 0);
});

test('surface: a reader that throws maps to a refusal without leaking the error', async () => {
  const s = createAgentSurface(fixtures({ status: () => { throw new Error('secret internals'); } }));
  const r = await s.handlers['status:get']({});
  assert.deepEqual(r, { ok: false, error: 'refused', reason: 'refused' });
});

test('surface: valid requests return bounded ok data', async () => {
  const s = createAgentSurface(fixtures());
  const status = await s.handlers['status:get']({});
  assert.equal(status.ok, true);
  assert.equal(status.data.agentActive, true);
  const audit = await s.handlers['audit:read']({ limit: 10 });
  assert.equal(audit.ok, true);
  assert.equal(audit.data.verified, true);
  assert.equal(audit.data.entries.length, 1);
  assert.deepEqual(audit.data.entries[0].detail, { k: 'v' }); // one nested level survives
  const runs = await s.handlers['runs:get']({});
  assert.equal(runs.ok, true);
  assert.equal(runs.data.runs[0].stepsCount, 2);
  const reminders = await s.handlers['reminders:read']({ limit: 1 });
  assert.equal(reminders.ok, true);
  assert.equal(reminders.data.reminders.length, 1);
});

test('surface: hostile reader output is shaped, not passed raw', async () => {
  const hostile = {
    id: 'a',
    long: 'x'.repeat(999),
    nested: { ok: 'v', deep: { deeper: 1 } },
    nonfinite: NaN,
    arr: [1, 2],
    fn: () => {},
    [Symbol('s')]: 1,
  };
  const shaped = boundedRecord(hostile, 1);
  assert.equal(shaped.id, 'a');
  assert.equal(shaped.long, 'x'.repeat(200));
  assert.deepEqual(shaped.nested, { ok: 'v' });
  assert.equal('nonfinite' in shaped, false);
  assert.equal('arr' in shaped, false);
  assert.equal('fn' in shaped, false);
});

test('surface: results are capped at the requested limit and never above 500', async () => {
  const big = Array.from({ length: 600 }, (_, i) => ({ id: String(i) }));
  const s = createAgentSurface(fixtures({ listNotifications: () => big }));
  const r500 = await s.handlers['notifications:read']({ limit: 500 });
  assert.equal(r500.data.notifications.length, 500);
  const r50 = await s.handlers['notifications:read']({ limit: 50 });
  assert.equal(r50.data.notifications.length, 50);
  const rDefault = await s.handlers['notifications:read']({});
  assert.equal(rDefault.data.notifications.length, 500);
});

test('surface: non-plain records are dropped, not rendered', () => {
  assert.deepEqual(boundedRecords([null, 'x', 5, { id: 'ok' }], 10), [{ id: 'ok' }]);
});

test('surface: registerIpc registers exactly the six channels on the dispatcher', () => {
  const s = createAgentSurface(fixtures());
  const registered = [];
  s.registerIpc({ handle: (c, fn) => registered.push([c, typeof fn]) });
  assert.deepEqual(registered.map((x) => x[0]).sort(), RENDERER_CHANNELS.slice().sort());
  for (const x of registered) assert.equal(x[1], 'function');
});

test('surface: construction with a missing reader throws (fail closed)', () => {
  const r = fixtures();
  delete r.status;
  assert.throws(() => createAgentSurface(r), /status/);
  const r2 = fixtures();
  delete r2.listProviders;
  assert.throws(() => createAgentSurface(r2), /listProviders/);
});

test('surface: projectRun flattens a run state to bounded primitives', () => {
  const p = projectRun({
    runId: 'r1', goal: 'g', state: 'running', stepIndex: 0, attempts: 0,
    startedAt: 1, finishedAt: null, steps: ['a', 'b'],
    pendingApproval: { stepId: 's', tool: 't', args: { secret: 'x' } },
  });
  assert.deepEqual(p, {
    runId: 'r1', goal: 'g', state: 'running', stepIndex: 0, attempts: 0,
    startedAt: 1, finishedAt: null,
    stepsCount: 2, stepsJoined: 'a,b',
    pendingStepId: 's', pendingTool: 't',
  });
  // Approval args never survive the projection.
  assert.equal('args' in p, false);
  assert.equal(JSON.stringify(p).includes('secret'), false);
});

test('surface: projectRun survives null and unknown runs', () => {
  assert.equal(projectRun(null), null);
  assert.equal(projectRun(undefined), null);
});
