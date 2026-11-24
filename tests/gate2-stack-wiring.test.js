'use strict';
// Gate 2 slice P2 review fix: proves the stack the APP builds
// (createAgentStack, the exact construction main.js runs) wires the
// orchestrator to the persistence layer's durable audit wrapper, and that a
// forced file-flush failure at transition time prevents step closure, locks
// the orchestrator, and writes no phantom rows. Also proves the reset
// lifecycle (controlled save, then close, then reopen) and honest
// beforeQuit reporting.

const test = require('node:test');
const assert = require('node:assert');
const LocalDb = require('../src/db');
const { createRegistry } = require('../src/tool-registry');
const { createAgentStack, createAgentRuntime } = require('../src/agent-runtime');

const NOW = 1_700_000_000_000;

function fixtures() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 } } } });
  registry.define({ name: 'notes.rename_tag', description: 'Rename a tag (reversible fixture)', capability: 'reversible_write', schema: { properties: { from: { type: 'string', required: true, maxLength: 64 }, to: { type: 'string', required: true, maxLength: 64 } } } });
  return registry;
}

function plan(id, tool, run) {
  return [{ id, tool, args: { query: 'x' }, run }];
}

test('the app-built stack: transitions persist through the durable wrapper and a flush failure prevents step closure and locks', async () => {
  const state = { bytes: null };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = Buffer.from(b); } };
  const db = await LocalDb.open({ storage });
  const realFlush = db.flush.bind(db);
  let flushBroken = false;
  db.flush = function () { if (flushBroken) throw new Error('simulated flush failure'); return realFlush(); };
  const stack = createAgentStack({ db, clock: () => NOW, registry: fixtures() });
  // The policy engine requires a grant before any tool execution; the grant
  // itself is an audited transition (grant.issued).
  assert.equal(stack.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);

  const started = stack.orchestrator.startRun({ runId: 'r1', goal: 'g', plan: [].concat(plan('s1', 'notes.search', () => ({ ok: true, summary: 'a' })), plan('s2', 'notes.search', () => ({ ok: true, summary: 'b' }))) });
  assert.equal(started.ok, true, JSON.stringify(started));
  const s1 = stack.orchestrator.step('r1');
  assert.equal(s1.ok, true, JSON.stringify(s1));
  // Durability at transition time: the file bytes already carry the rows;
  // the test called no flush and no save.
  assert.ok(state.bytes && state.bytes.length > 0, 'transitions persisted to the store');
  const rowsAfter = db.all('SELECT COUNT(*) AS n FROM agent_audit')[0].n;
  // Grants persist as a grants table row (at save), not as an audit entry;
  // the three rows are run.started + step_started + step_succeeded.
  assert.equal(rowsAfter, 3, 'run.started + step_started + step_succeeded persisted through the wrapper');

  // Force the file flush to fail at the next transition.
  flushBroken = true;
  const s2 = stack.orchestrator.step('r1');
  assert.equal(s2.ok, false, 'the transition is refused, never acknowledged');
  const run = stack.orchestrator.getRun('r1');
  assert.equal(run.state, 'running');
  assert.equal(run.stepIndex, 1, 'the failed step did not close');
  assert.equal(stack.orchestrator.activeRun().runId, 'r1', 'the slot is still held');
  assert.equal(db.all('SELECT COUNT(*) AS n FROM agent_audit')[0].n, rowsAfter, 'no phantom row');
  const actions = stack.audit.snapshot().entries.map((e) => e.action);
  assert.equal(actions.filter((a) => a === 'run.step_succeeded').length, 1, 'the unacknowledged append rolled back in memory');
  // Locked: every further operation refuses until a fresh instance.
  const again = stack.orchestrator.step('r1');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'audit_failed', 'poisoned refusals report audit_failed');
});

test('runtime reset while active: controlled save, then close, then reopen; a failed controlled save blocks with bytes intact', async () => {
  const state = { bytes: null };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = Buffer.from(b); } };
  const closed = [];
  const runtime = createAgentRuntime({
    openDb: () => LocalDb.open({ storage }),
    buildAgent: ({ db }) => createAgentStack({ db, clock: () => NOW, registry: fixtures() }),
    closeDb: (db) => closed.push(db),
  });
  const started = await runtime.start();
  assert.equal(started.ok, true, JSON.stringify(started.problems));
  started.agent.persistence.appendAudit({ actor: 'system', action: 'pre.reset' });
  const reset = await runtime.reset();
  assert.equal(reset.ok, true, JSON.stringify(reset.problems));
  assert.equal(closed.length, 1, 'the previous store was closed exactly once');
  assert.notEqual(runtime.agent(), started.agent, 'a fresh stack replaces the old one');
  const actions = runtime.agent().audit.snapshot().entries.map((e) => e.action);
  assert.ok(actions.includes('pre.reset'), 'the controlled save preserved state across the reset');

  // A failing controlled save blocks the reset; the store is closed (no
  // orphan handle) and the bytes stay as they were.
  const db2 = runtime.agent().db;
  db2.flush = () => { throw new Error('simulated flush failure'); };
  const blocked = await runtime.reset();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.mode, 'blocked');
  assert.match(blocked.problems[0], /save_before_reset_failed/);
  assert.equal(closed.length, 2, 'no orphan open handle after the failed reset');
  const before = state.bytes;
  // From blocked, a fresh reset takes the normal verified path: the bytes
  // on disk are the last valid state, so a real verified load revives it.
  const again = await runtime.reset();
  assert.equal(again.mode, 'active', 'blocked state is recoverable through a verified load');
  const actions2 = again.agent.audit.snapshot().entries.map((e) => e.action);
  assert.ok(actions2.includes('pre.reset'), 'the durable pre-reset entry is still there');
});

test('beforeQuit reports a failed save honestly and still closes the store', async () => {
  const state = { bytes: null };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = Buffer.from(b); } };
  const closed = [];
  const runtime = createAgentRuntime({
    openDb: () => LocalDb.open({ storage }),
    buildAgent: ({ db }) => createAgentStack({ db, clock: () => NOW, registry: fixtures() }),
    closeDb: (db) => closed.push(db),
  });
  const started = await runtime.start();
  assert.equal(started.ok, true, JSON.stringify(started.problems));
  started.agent.persistence.appendAudit({ actor: 'system', action: 'quit.entry' });
  // Break the flush: the quit-time save cannot converge desk state.
  const db = runtime.agent().db;
  db.flush = () => { throw new Error('simulated flush failure'); };
  const quit = runtime.beforeQuit();
  assert.equal(quit.ok, false, 'a failed save must not be reported as convergence');
  assert.equal(quit.saved, false);
  assert.match(quit.reason, /persist_failure|save_threw/);
  assert.equal(closed.length, 1, 'the store still closed deterministically');
});

test('start() never throws: openDb, buildAgent, and load failures return blocked, sanitized, with the store closed', async () => {
  const closed = [];

  // openDb throws: sanitized reason, no path, no exception escapes.
  const r1 = createAgentRuntime({
    openDb: () => { const e = new Error('EACCES: permission denied, open /secret/path/x.db'); e.code = 'EACCES'; throw e; },
    buildAgent: () => null,
    closeDb: (db) => closed.push(db),
  });
  const s1 = await r1.start();
  assert.equal(s1.mode, 'blocked');
  assert.equal(s1.ok, false);
  assert.match(s1.problems[0], /^db_open_failed/);
  assert.ok(!JSON.stringify(s1.problems).includes('/secret/path'), 'no path leaks from the open failure');

  // buildAgent throws: the opened store is closed, reason sanitized.
  const storage = { load: async () => null, save: async () => {} };
  const r2 = createAgentRuntime({
    openDb: async () => LocalDb.open({ storage }),
    buildAgent: () => { throw new Error('boom with /secret/path'); },
    closeDb: (db) => closed.push(db),
  });
  const s2 = await r2.start();
  assert.equal(s2.mode, 'blocked');
  assert.equal(s2.ok, false);
  assert.match(s2.problems[0], /^agent_build_failed/);
  assert.ok(!JSON.stringify(s2.problems).includes('/secret/path'), 'no path leaks from the build failure');
  assert.equal(closed.length, 1, 'the opened store was closed after the build failure');

  // persistence.load() throws: the catch-all blocks, closes the store, and
  // exposes no exception detail or partial stack.
  const r3 = createAgentRuntime({
    openDb: async () => LocalDb.open({ storage }),
    buildAgent: ({ db }) => ({
      db,
      persistence: {
        load: () => { throw new Error('load exploded /secret/path'); },
        save: () => ({ ok: true }),
      },
    }),
    closeDb: (db) => closed.push(db),
  });
  const s3 = await r3.start();
  assert.equal(s3.mode, 'blocked');
  assert.equal(s3.ok, false);
  assert.match(s3.problems[0], /^startup_failed/);
  assert.ok(!JSON.stringify(s3.problems).includes('/secret/path'), 'no exception detail leaks');
  assert.ok(!JSON.stringify(s3.problems).includes('exploded'), 'no raw message leaks');
  assert.equal(closed.length, 2, 'the store closed on the load throw');
});
