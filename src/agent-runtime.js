'use strict';
// Agent runtime: the ONE place that owns the agent state store's lifecycle
// (Gate 2 persistence, slice P2). The store is a LocalDb over a storage
// handle the host supplies; the agent stack itself is built by a factory the
// host supplies, so a recovery always builds FRESH desk instances and never
// reuses a possibly poisoned stack.
//
// Lifecycle:
// - start(): open the store, build the stack, load persisted state. A
//   verified load is followed by ONE convergence save() that writes back
//   exactly what the verified state already holds: it creates nothing,
//   repairs nothing and drops nothing. Its only job is to leave the file in
//   the same shape the verified load produced (for example clearing stale
//   'running' rows' in-memory representation was already done by load).
// - ANY failure on that path (open, build, load verification, convergence
//   save) puts the runtime in 'blocked' mode. Nothing is written, nothing is
//   deleted, and the stored bytes are left as they were: fail-closed and
//   non-destructive. There is no automatic retry loop and no fallback to an
//   empty store: silently starting from scratch would be a destructive
//   reset of user data.
// - While blocked, requireActive() refuses every write path with
//   'persistence_blocked' and the problems; readers answer from a neutral
//   empty shape. reset() reruns the same verified path on the same storage
//   and can succeed ONLY through a real verified load; a failed reset keeps
//   the runtime blocked and touches nothing.
// - beforeQuit() converges (save) and closes when active; closes WITHOUT
//   writing when blocked. No agent run is ever resumed automatically: that
//   remains load()'s invariant, and no API here reintroduces it.
//
// The runtime never widens capabilities: it performs no tool execution and
// holds no model access. It only owns open/load/save/close of the store.

const LocalDbModule = require('./db');
const { createAuditLog } = require('./audit');
const { createApprovalDesk } = require('./approval');
const { createEmergencyStop } = require('./emergency-stop');
const { createRegistry } = require('./tool-registry');
const { createPolicyEngine } = require('./policy-engine');
const { createNotificationDesk } = require('./agent-notifications');
const { createReminderBook } = require('./agent-reminders');
const { createScheduleBook } = require('./agent-scheduler');
const { createAgentPersistence } = require('./agent-persistence');
const { createOrchestrator } = require('./agent-orchestrator');

function createAgentRuntime({ openDb, buildAgent, closeDb } = {}) {
  if (typeof openDb !== 'function') throw new Error('openDb required');
  if (typeof buildAgent !== 'function') throw new Error('buildAgent required');
  if (closeDb !== undefined && typeof closeDb !== 'function') throw new Error('closeDb must be a function');

  let agent = null;
  let mode = 'cold'; // cold | active | blocked
  let problems = null;

  function closeStore(db) {
    if (!db) return;
    try {
      if (closeDb) closeDb(db);
      else if (typeof db.close === 'function') db.close();
    } catch (err) { /* close is best effort; nothing else writes after this */ }
  }

  function result() {
    return { ok: mode === 'active', mode, problems: problems ? problems.slice() : null, agent: mode === 'active' ? agent : null };
  }

  async function start() {
    // Controlled replacement: when an agent is already active, converge its
    // state and close its store BEFORE the file is touched again. Two live
    // handles on one file could overwrite each other's writes, and the
    // controlled save is the durability boundary that preserves the active
    // state whatever the reopened load then finds. If that save fails, do
    // not proceed: block with the store closed and its bytes intact.
    if (mode === 'active' && agent) {
      let saved;
      try {
        saved = agent.persistence.save();
      } catch (err) {
        saved = { ok: false, reason: 'save_threw' };
      }
      closeStore(agent.db);
      agent = null;
      if (!saved || !saved.ok) {
        mode = 'blocked';
        problems = ['save_before_reset_failed: ' + String((saved && saved.reason) || 'persist_failure')];
        return result();
      }
    }
    agent = null;
    problems = null;
    mode = 'cold';

    let db = null;
    try {
      db = await openDb();
    } catch (err) {
      mode = 'blocked';
      // Sanitized: error code only, never the raw message (paths and
      // machine details stay out of anything the surface can show).
      problems = ['db_open_failed: ' + String((err && err.code) || 'open_failed')];
      return result();
    }

    let built = null;
    try {
      built = buildAgent({ db });
    } catch (err) {
      closeStore(db);
      mode = 'blocked';
      // Sanitized: error code only, never the raw message.
      problems = ['agent_build_failed: ' + String((err && err.code) || 'build_failed')];
      return result();
    }
    if (!built || !built.persistence || !built.db) {
      closeStore(db);
      mode = 'blocked';
      problems = ['agent_build_invalid: buildAgent must return { db, persistence }'];
      return result();
    }

    try {
      return await startTail(built);
    } catch (err) {
      // Catch-all: no exception escapes start(). Any unexpected failure
      // (a throwing load or save) leaves the app blocked with the store
      // closed and no exception detail or partial stack exposed.
      try { closeStore(built.db); } catch (e2) { /* closing is best effort */ }
      agent = null;
      mode = 'blocked';
      problems = ['startup_failed: ' + String((err && err.code) || 'startup_error')];
      return result();
    }

    async function startTail(built) {
    const loaded = built.persistence.load();
    if (!loaded.ok) {
      // Fail closed: nothing was written to the store, so close and report.
      // The file on disk is byte-for-byte what it was.
      closeStore(built.db);
      mode = 'blocked';
      problems = (loaded.problems || []).map((p) => String(p));
      if (problems.length === 0) problems = ['load_failed'];
      return result();
    }

    // Convergence save after a VERIFIED load: writes back exactly the state
    // the verified load produced. If even this fails, the disk is not
    // dependable enough to run the agent against, so block rather than
    // continue on an unsaveable store.
    const saved = built.persistence.save();
    if (!saved.ok) {
      closeStore(built.db);
      mode = 'blocked';
      problems = ['save_after_load_failed: ' + String(saved.reason || 'unknown')];
      return result();
    }

    agent = built;
    mode = 'active';
    return result();
    }
  }

  return {
    start,
    // The renderer's "Reset" maps here. Same verified path, same fail-closed
    // rules; success requires a real verified load.
    reset: start,
    status() {
      return { mode, active: mode === 'active', problems: problems ? problems.slice() : null };
    },
    isActive() {
      return mode === 'active';
    },
    problems() {
      return problems ? problems.slice() : null;
    },
    agent() {
      return mode === 'active' ? agent : null;
    },
    // The gate every write path must pass. While blocked, this is the
    // reason an execution request is refused.
    requireActive() {
      if (mode === 'active') return { ok: true };
      return {
        ok: false,
        reason: 'persistence_blocked',
        problems: problems ? problems.slice() : null,
      };
    },
    beforeQuit() {
      let saved = null;
      if (mode === 'active' && agent && agent.persistence) {
        try {
          saved = agent.persistence.save();
        } catch (err) {
          saved = { ok: false, reason: 'save_threw' };
        }
      }
      if (agent && agent.db) closeStore(agent.db);
      // A failed save is NOT convergence: report it. Already-acknowledged
      // audit appends stay durable regardless (each flushed at its own
      // acknowledged append); only desk-state convergence is left pending.
      return {
        ok: !saved || saved.ok === true,
        mode,
        saved: saved ? saved.ok === true : null,
        reason: saved && saved.ok !== true ? String(saved.reason || 'persist_failure') : null,
      };
    },
  };
}

// The agent stack exactly as the app builds it: persistence FIRST, then
// the orchestrator wired to the persistence layer's durable audit wrapper,
// so every transition the orchestrator logs is persisted and acknowledged
// before it may commit (log-before-commit at the file boundary). Reads go
// through the same underlying in-memory log either way; only appends
// differ. extractAgentStack keeps main.js's module handles in one place.
function createAgentStack({ db, clock, registry: registryOverride } = {}) {
  if (!db) throw new Error('db required');
  const now = clock || (() => Date.now());
  const audit = createAuditLog({ clock: now });
  const approvals = createApprovalDesk({ clock: now });
  const emergencyStop = createEmergencyStop();
  const registry = registryOverride || createRegistry();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop, clock: now });
  const notifications = createNotificationDesk({ clock: now });
  const reminders = createReminderBook({ clock: now });
  const schedules = createScheduleBook({ clock: now });
  const persistence = createAgentPersistence({
    db, clock: now, registry, audit, approvals, engine, emergencyStop, notifications, reminders, schedules,
  });
  // THE injection point: the orchestrator never sees the raw audit log.
  const durableAudit = persistence.durableAudit();
  const orchestrator = createOrchestrator({ engine, approvals, emergencyStop, audit: durableAudit });
  return { db, persistence, audit, durableAudit, approvals, engine, emergencyStop, registry, notifications, reminders, schedules, orchestrator };
}

module.exports = { createAgentRuntime, createAgentStack };
