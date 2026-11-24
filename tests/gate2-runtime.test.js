'use strict';
// Gate 2 slice P2: the agent runtime lifecycle. Active path, fail-closed
// blocked path (byte-identical store), reset semantics, the write-path gate,
// beforeQuit on both paths, and fresh desks per recovery.

const test = require('node:test');
const assert = require('node:assert');
const { createAgentRuntime } = require('../src/agent-runtime');
const LocalDb = require('../src/db');
const { createRegistry } = require('../src/tool-registry');
const { createApprovalDesk } = require('../src/approval');
const { createAuditLog } = require('../src/audit');
const { createPolicyEngine } = require('../src/policy-engine');
const { createEmergencyStop } = require('../src/emergency-stop');
const { createNotificationDesk } = require('../src/agent-notifications');
const { createReminderBook } = require('../src/agent-reminders');
const { createAgentPersistence } = require('../src/agent-persistence');

const HEX64 = /^[a-f0-9]{64}$/;
const NOW = 1_737_800_000_000;

function inMemoryStorage() {
  const state = { bytes: null };
  return {
    state,
    load: async () => state.bytes,
    save: async (b) => { state.bytes = Buffer.from(b); },
  };
}

// Build the agent stack the way main.js does, fresh each call.
function makeBuildAgent() {
  const builds = [];
  return {
    builds,
    buildAgent({ db }) {
      const clock = () => NOW;
      const audit = createAuditLog({ clock });
      const approvals = createApprovalDesk({ clock });
      const stop = createEmergencyStop();
      const registry = createRegistry();
      const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock });
      const notifications = createNotificationDesk({ clock });
      const reminders = createReminderBook({ clock });
      const persistence = createAgentPersistence({
        db, clock, registry, audit, approvals, engine, emergencyStop: stop, notifications, reminders,
      });
      const built = { db, persistence, audit, approvals, engine, emergencyStop: stop, registry, notifications, reminders };
      builds.push(built);
      return built;
    },
  };
}

async function makeRuntime() {
  const storage = inMemoryStorage();
  const factory = makeBuildAgent();
  const runtime = createAgentRuntime({
    openDb: () => LocalDb.open({ storage }),
    buildAgent: factory.buildAgent,
  });
  return { runtime, storage, factory };
}

test('the happy path: verified load, one convergence save, active runtime', async () => {
  // Seed a good store through one runtime, then start a second one.
  let r = await makeRuntime();
  let started = await r.runtime.start();
  assert.equal(started.ok, true, JSON.stringify(started.problems));
  assert.equal(started.mode, 'active');
  assert.ok(started.agent.persistence);
  started.agent.persistence.appendAudit({ actor: 'system', action: 'seed', detail: { n: 1 } });
  r.runtime.beforeQuit();

  const bytesAfterSeed = r.storage.state.bytes;
  const r2 = await makeRuntime();
  // Point the second runtime's storage at the seeded bytes.
  r2.storage.state.bytes = bytesAfterSeed;
  const started2 = await r2.runtime.start();
  assert.equal(started2.ok, true, JSON.stringify(started2.problems));
  assert.equal(started2.mode, 'active');
  // The convergence save wrote back the verified state: identical entry set.
  const entries = started2.agent.audit.snapshot().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'seed');
});

test('corrupt store: blocked mode, the file is byte-for-byte untouched, nothing is deleted', async () => {
  const r = await makeRuntime();
  let started = await r.runtime.start();
  assert.equal(started.ok, true);
  started.agent.persistence.appendAudit({ actor: 'system', action: 'seed' });
  r.runtime.beforeQuit();

  // Corrupt the stored bytes (as a partial write or disk damage would).
  // Keep the original: the revival step restores exactly these bytes.
  const original = Buffer.from(r.storage.state.bytes);
  const corrupt = Buffer.from(original);
  corrupt[corrupt.length - 3] = (corrupt[corrupt.length - 3] ^ 0xff) & 0xff;
  r.storage.state.bytes = corrupt;

  const r2 = await makeRuntime();
  r2.storage.state.bytes = corrupt;
  const blocked = await r2.runtime.start();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.mode, 'blocked');
  assert.ok(Array.isArray(blocked.problems) && blocked.problems.length > 0, 'problems are surfaced');
  assert.equal(blocked.agent, null, 'no agent is exposed while blocked');
  // The store was not touched: byte-for-byte identical.
  assert.ok(r2.storage.state.bytes.equals(corrupt), 'fail-closed: the store is untouched');
  // The write-path gate refuses everything.
  const gate = r2.runtime.requireActive();
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'persistence_blocked');

  // Repair the bytes and reset: only a real verified load brings it back.
  r2.storage.state.bytes = Buffer.from(original);
  const revived = await r2.runtime.reset();
  assert.equal(revived.ok, true, JSON.stringify(revived.problems));
  assert.equal(revived.mode, 'active');
  assert.equal(revived.agent.audit.snapshot().entries[0].action, 'seed');
});

test('recovery builds FRESH desks: the previous stack is never reused', async () => {
  const r = await makeRuntime();
  await r.runtime.start();
  const firstAgent = r.runtime.agent();
  await r.runtime.reset();
  assert.notEqual(r.runtime.agent(), firstAgent);
  assert.equal(r.factory.builds.length, 2, 'each start builds a new stack');
});

test('a failed build agent is also fail-closed and closes the store', async () => {
  const storage = inMemoryStorage();
  let opened = 0;
  const runtime = createAgentRuntime({
    openDb: () => { opened++; return LocalDb.open({ storage }); },
    buildAgent: () => { throw new Error('simulated build failure'); },
  });
  const blocked = await runtime.start();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.mode, 'blocked');
  assert.match(blocked.problems[0], /agent_build_failed/);
  // openDb ran exactly once for the failed attempt and once more is allowed
  // on an explicit reset; nothing was written.
  assert.equal(opened, 1);
  assert.equal(runtime.requireActive().ok, false);
});

test('beforeQuit converges on active and closes; on blocked it writes nothing', async () => {
  const r = await makeRuntime();
  const started = await r.runtime.start();
  started.agent.persistence.appendAudit({ actor: 'system', action: 'quit.audit' });
  const before = r.storage.state.bytes.length;
  r.runtime.beforeQuit();
  // The acknowledged append converged to the store at quit.
  const r2 = await makeRuntime();
  r2.storage.state.bytes = r.storage.state.bytes;
  const started2 = await r2.runtime.start();
  assert.equal(started2.ok, true, JSON.stringify(started2.problems));
  const actions = started2.agent.audit.snapshot().entries.map((e) => e.action);
  assert.ok(actions.includes('quit.audit'), 'the quit-time append survived');

  // Blocked path: corrupt the store, then quit writes nothing new.
  const corrupt = Buffer.from(r2.storage.state.bytes);
  corrupt[corrupt.length - 3] = (corrupt[corrupt.length - 3] ^ 0xff) & 0xff;
  r2.storage.state.bytes = corrupt;
  await r2.runtime.start(); // now blocked
  const quit = r2.runtime.beforeQuit();
  assert.equal(quit.mode, 'blocked');
  assert.ok(r2.storage.state.bytes.equals(corrupt), 'a blocked quit wrote nothing');
});
