'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const LocalDb = require('../src/db');
const { createRegistry } = require('../src/tool-registry');
const { createPolicyEngine } = require('../src/policy-engine');
const { createApprovalDesk } = require('../src/approval');
const { createAuditLog } = require('../src/audit');
const { createEmergencyStop } = require('../src/emergency-stop');
const { createAgentPersistence } = require('../src/agent-persistence');

const HEX64 = /^[a-f0-9]{64}$/;

function fixtures() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 }, limit: { type: 'integer' } } } });
  registry.define({ name: 'notes.rename_tag', description: 'Rename a tag (reversible fixture)', capability: 'reversible_write', schema: { properties: { from: { type: 'string', required: true, maxLength: 64 }, to: { type: 'string', required: true, maxLength: 64 } } } });
  registry.define({ name: 'payments.charge', description: 'Charge a payment (sensitive fixture)', capability: 'sensitive', schema: { properties: { amount: { type: 'integer', required: true }, currency: { type: 'string', required: true, maxLength: 8 } } } });
  return registry;
}

// A full world: in-memory LocalDb + live instances + persistence. The storage
// object keeps the last flushed bytes so a restart can reopen from them
// exactly the way the desktop file round-trips.
async function world() {
  const state = { bytes: null, now: 1_700_000_000_000 };
  const storage = {
    load: async () => state.bytes,
    save: async (bytes) => { state.bytes = bytes; },
  };
  const db = await LocalDb.open({ storage });
  const clock = () => state.now;
  const registry = fixtures();
  const audit = createAuditLog({ clock });
  const approvals = createApprovalDesk({ clock });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock });
  const p = createAgentPersistence({ db, clock, registry, audit, approvals, engine, emergencyStop: stop });
  return { db, storage, saved: state, state, registry, audit, approvals, stop, engine, p, time: state };
}

// A restart: reopen the database from the flushed bytes with fresh module
// instances, exactly like relaunching the app.
async function restart(prev) {
  // Flush the world we restart FROM, then open the new database from those
  // bytes with its own storage, so a second restart sees the latest state.
  prev.db.flush();
  const state = { bytes: prev.saved.bytes, now: prev.state.now };
  assert.ok(state.bytes && state.bytes.length > 0, 'flush must have produced bytes');
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const registry = fixtures();
  const audit = createAuditLog({ clock: () => state.now });
  const approvals = createApprovalDesk({ clock: () => state.now });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock: () => state.now });
  const p = createAgentPersistence({ db, clock: () => state.now, registry, audit, approvals, engine, emergencyStop: stop });
  const loaded = p.load();
  return { db, storage, saved: state, state, registry, audit, approvals, stop, engine, p, loaded, time: state };
}

test('the migration is additive: an old database gains the agent tables and keeps its data', async () => {
  // Build a database the way a previous app version would have left it: only
  // the old tables, with a real row in one of them.
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run("CREATE TABLE courses (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT, credit_hours REAL, term TEXT, source_file TEXT, created_at TEXT DEFAULT (datetime('now')))");
  raw.run("INSERT INTO courses (name, code) VALUES ('Old Course', 'CS101')");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-migrate-'));
  const file = path.join(dir, 'companiondesk.db');
  fs.writeFileSync(file, Buffer.from(raw.export()));

  const db = await LocalDb.open({ file });
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const t of ['agent_grants', 'agent_approvals', 'agent_audit', 'agent_audit_anchor', 'agent_emergency_stop', 'agent_runs']) {
    assert.ok(tables.includes(t), 'agent table created: ' + t);
  }
  const old = db.all('SELECT name, code FROM courses');
  assert.equal(old.length, 1);
  assert.equal(old[0].name, 'Old Course');
  assert.equal(old[0].code, 'CS101');
});

test('fresh load initializes the anchor and reports ok', async () => {
  const w = await world();
  const loaded = w.p.load();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.problems, []);
  const anchor = w.db.all('SELECT base_seq, base_hash, last_seq, last_hash FROM agent_audit_anchor WHERE id = 1');
  assert.equal(anchor.length, 1);
  assert.equal(anchor[0].base_seq, 0);
  assert.match(anchor[0].base_hash, HEX64);
});

test('grants, approvals, audit, stop and runs round-trip across a restart', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);

  // A grant with a TTL and a grant that gets revoked.
  const g1 = w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  assert.equal(g1.ok, true, 'grant with ttl: ' + JSON.stringify(g1));
  const g2 = w.engine.grantTool({ tool: 'notes.rename_tag' });
  assert.equal(g2.ok, true, 'grant plain: ' + JSON.stringify(g2));
  w.engine.revoke('notes.rename_tag');
  w.state.now += 120_000; // g1 is now expired

  // One approval consumed (used), one left pending.
  const r1 = w.approvals.request({ tool: 'payments.charge', args: { amount: 5, currency: 'INR' } });
  assert.equal(r1.ok, true, 'request: ' + JSON.stringify(r1));
  const usedId = r1.approval.id;
  w.state.now += 1_000;
  const consumed = w.approvals.consume(usedId, { tool: 'payments.charge', args: { amount: 5, currency: 'INR' } });
  assert.equal(consumed.ok, true, 'consume: ' + JSON.stringify(consumed));
  const r2 = w.approvals.request({ tool: 'payments.charge', args: { amount: 7, currency: 'INR' } });
  assert.equal(r2.ok, true);
  const pendingId = r2.approval.id;

  // Audit entries via the persisted path.
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.call', tool: 'notes.search' }).ok, true);
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.result', tool: 'notes.search' }).ok, true);

  // Emergency stop active and a run in flight at shutdown.
  assert.equal(w.stop.activate('user pressed stop', { by: 'user' }).ok, true);
  assert.equal(w.p.startRun({ runId: 'run-1', kind: 'demo' }).ok, true);

  const saved = w.p.save();
  assert.equal(saved.ok, true, 'save: ' + JSON.stringify(saved));

  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, true, 'restart load: ' + JSON.stringify(w2.loaded));
  assert.equal(w2.loaded.invalidatedApprovals, 1);

  // Grants: revoked stays revoked, expired stays expired.
  const grants = Object.fromEntries(w2.engine.listGrants().map((g) => [g.tool, g]));
  assert.equal(grants['notes.rename_tag'].revoked, true);
  assert.ok(grants['notes.search'].expiresAt < w.state.now, 'expired grant restored with its expiry');
  // The restored emergency stop blocks execution first (the policy engine's
  // check order puts the stop before grant checks), which is itself proof the
  // stop came back active.
  const after = w2.engine.authorize({ tool: 'notes.search', args: { query: 'x' } });
  assert.equal(after.allowed, false);
  assert.equal(after.reason, 'stop_active');

  // The used approval must not become usable again across a restart.
  const replay = w2.approvals.verify(usedId, { tool: 'payments.charge', args: { amount: 5, currency: 'INR' } });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'approval_used');

  // The pending approval came back invalidated, not pending.
  const invalidated = w2.approvals.verify(pendingId, { tool: 'payments.charge', args: { amount: 7, currency: 'INR' } });
  assert.equal(invalidated.ok, false);
  assert.equal(invalidated.reason, 'approval_invalidated');

  // A fresh request is safely reissued.
  const reissue = w2.approvals.request({ tool: 'payments.charge', args: { amount: 9, currency: 'INR' } });
  assert.equal(reissue.ok, true);

  // Audit chain verifies from the persisted anchor; the invalidation was audited.
  assert.equal(w2.audit.verify().ok, true);
  const actions = w2.audit.read({}).map((e) => e.action);
  assert.ok(actions.includes('approvals.invalidated_on_restart'), 'invalidation audited: ' + JSON.stringify(actions));

  // Emergency stop restored active; the run row is untouched; no resume API.
  assert.equal(w2.stop.snapshot().active, true);
  const runs = w2.p.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'running');
  assert.equal(typeof w2.p.resume, 'undefined');
});

test('an expired grant stays expired across a restart', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const g = w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 });
  assert.equal(g.ok, true, JSON.stringify(g));
  w.state.now += 120_000;
  assert.equal(w.p.save().ok, true);
  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, true);
  const after = w2.engine.authorize({ tool: 'notes.search', args: { query: 'x' } });
  assert.equal(after.allowed, false);
  assert.equal(after.reason, 'grant_expired');
  const okTool = w2.engine.authorize({ tool: 'notes.rename_tag', args: { from: 'a', to: 'b' } });
  assert.equal(okTool.allowed, false);
  assert.equal(okTool.reason, 'no_grant');
});

test('pending approvals never survive a restart as usable approvals', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  const r = w.approvals.request({ tool: 'payments.charge', args: { amount: 3, currency: 'INR' } });
  assert.equal(r.ok, true);
  const id = r.approval.id;
  assert.equal(w.p.save().ok, true);
  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, true);
  const v = w2.approvals.verify(id, { tool: 'payments.charge', args: { amount: 3, currency: 'INR' } });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'approval_invalidated');
});

test('audit entries and the anchor are written atomically; a failed write rolls back', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.call', tool: 'notes.search' }).ok, true);

  // A storage fault exactly on the anchor update: the whole transaction must
  // roll back, leaving no audit row and the anchor untouched.
  let failNextAnchor = true;
  const rawRun = w.db.run.bind(w.db);
  const flaky = {
    run: (sql, params) => {
      if (failNextAnchor && sql.includes('agent_audit_anchor')) throw new Error('simulated storage fault');
      return rawRun(sql, params);
    },
    all: w.db.all.bind(w.db),
  };
  const p2 = createAgentPersistence({ db: flaky, clock: () => w.state.now, registry: w.registry, audit: w.audit, approvals: w.approvals, engine: w.engine, emergencyStop: w.stop });
  p2.load();
  const before = w.db.all('SELECT COUNT(*) AS n FROM agent_audit')[0].n;
  const lastHashBefore = w.audit.lastHash;
  const res = p2.appendAudit({ actor: 'agent', action: 'tools.result', tool: 'notes.search' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'persist_failure');
  const after = w.db.all('SELECT COUNT(*) AS n FROM agent_audit')[0].n;
  assert.equal(after, before, 'rolled back: no partial audit row');
  // The in-memory append rolls back too: the log holds acknowledged
  // entries only, so no false record of a transition that did not commit
  // can ever converge to disk.
  assert.equal(w.audit.length, before, 'unacknowledged entry rolled back');
  assert.equal(lastHashBefore, w.audit.lastHash, 'chain head restored');
  failNextAnchor = false;
  // A fresh append after the write path recovers: the seq is reused (the
  // rolled-back entry no longer exists), the chain verifies.
  const retry = p2.appendAudit({ actor: 'agent', action: 'tools.result', tool: 'notes.search' });
  assert.equal(retry.ok, true, 'recovered append: ' + JSON.stringify(retry));
  assert.equal(retry.seq, before + 1, 'the seq is reused');
  const w3 = await restart(w);
  assert.equal(w3.loaded.ok, true);
  const actions = w3.audit.read({}).map((e) => e.action);
  assert.ok(actions.includes('tools.result'), 'the recovered entry persisted');
});

test('a tampered audit row fails startup closed and nothing is deleted or repaired', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.call', tool: 'notes.search' }).ok, true);
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.result', tool: 'notes.search' }).ok, true);
  assert.equal(w.p.save().ok, true);

  w.db.run("UPDATE agent_audit SET reason = 'fabricated' WHERE seq = 1");
  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, false);
  assert.ok(w2.loaded.problems.some((x) => String(x).startsWith('chain_broken')), 'typed chain problem: ' + JSON.stringify(w2.loaded.problems));
  assert.equal(w2.p.status().ok, false);

  // Fail closed: every write refuses, and the evidence is left in place.
  assert.equal(w2.p.appendAudit({ actor: 'agent', action: 'anything' }).ok, false);
  assert.equal(w2.p.appendAudit({ actor: 'agent', action: 'anything' }).reason, 'integrity_failure');
  assert.equal(w2.p.save().ok, false);
  assert.equal(w2.p.save().reason, 'integrity_failure');
  assert.equal(w2.p.startRun({ runId: 'r9', kind: 'demo' }).reason, 'integrity_failure');
  const rows = w2.db.all('SELECT seq, reason FROM agent_audit ORDER BY seq');
  assert.equal(rows.length, 2, 'no silent deletion');
  assert.equal(rows[0].reason, 'fabricated', 'tampered row preserved as evidence');
});

test('a tampered anchor fails closed', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.call' }).ok, true);
  assert.equal(w.p.save().ok, true);
  w.db.run("UPDATE agent_audit_anchor SET last_hash = '" + 'f'.repeat(64) + "' WHERE id = 1");
  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, false);
  assert.ok(w2.loaded.problems.includes('anchor_mismatch'), JSON.stringify(w2.loaded.problems));
});

test('an unanchored tail fails closed', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.call' }).ok, true);
  assert.equal(w.p.save().ok, true);

  // A validly chained extra entry whose hash nobody anchored.
  const { toCanonicalEntry, chainHash } = require('../src/audit');
  const snap = w.audit.snapshot();
  const seq = 2;
  const e = { at: new Date(w.state.now).toISOString(), actor: 'agent', action: 'smuggled' };
  e.hash = chainHash(seq, w.audit.lastHash, toCanonicalEntry(e));
  w.db.run('INSERT INTO agent_audit (seq, at, actor, action, detail_json, hash) VALUES (?, ?, ?, ?, NULL, ?)', [seq, e.at, e.actor, e.action, e.hash]);

  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, false);
  assert.ok(w2.loaded.problems.includes('anchor_mismatch'), 'unanchored tail detected: ' + JSON.stringify(w2.loaded.problems));
});

test('invalid persisted rows fail closed', async () => {
  // An approval row with an unknown state.
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.p.save().ok, true);
  w.db.run("INSERT INTO agent_approvals (id, tool, args_digest, requested_at, expires_at, state) VALUES ('" + 'a'.repeat(64) + "', 'payments.charge', '" + 'b'.repeat(64) + "', 1, 2, 'weird')");
  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, false);
  assert.ok(w2.loaded.problems.some((x) => String(x).startsWith('invalid_approval_row')), JSON.stringify(w2.loaded.problems));

  // A grant row naming a tool the registry does not know.
  const wB = await world();
  assert.equal(wB.p.load().ok, true);
  assert.equal(wB.p.save().ok, true);
  wB.db.run("INSERT INTO agent_grants (tool, capability, granted_at, expires_at, revoked) VALUES ('ghost.tool', 'read_only', 1, NULL, 0)");
  const wB2 = await restart(wB);
  assert.equal(wB2.loaded.ok, false);
  assert.ok(wBB2Problems(wB2), JSON.stringify(wB2.loaded.problems));
  function wBB2Problems(x) { return x.loaded.problems.some((p) => String(p).startsWith('invalid_grant_row')); }
});

test('duplicate ids are refused', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.p.startRun({ runId: 'run-1', kind: 'demo' }).ok, true);
  const dup = w.p.startRun({ runId: 'run-1', kind: 'demo' });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate_run_id');

  // A duplicate approval id cannot be inserted either (primary key).
  assert.throws(() => w.db.run("INSERT INTO agent_approvals (id, tool, args_digest, requested_at, expires_at, state) VALUES ('" + 'c'.repeat(64) + "', 'payments.charge', '" + 'd'.repeat(64) + "', 1, 2, 'pending'), ('" + 'c'.repeat(64) + "', 'payments.charge', '" + 'd'.repeat(64) + "', 1, 2, 'pending')"));
});

test('emergency stop restores active and the reset persists', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.stop.activate('suspicious activity', { by: 'user' }).ok, true);
  assert.equal(w.p.save().ok, true);
  const w2 = await restart(w);
  assert.equal(w2.stop.snapshot().active, true);
  assert.equal(w2.stop.snapshot().reason, 'suspicious activity');
  assert.equal(w2.stop.snapshot().activatedBy, 'user');
  assert.equal(w2.stop.reset({ by: 'user' }).ok, true);
  assert.equal(w2.p.save().ok, true);
  const w3 = await restart(w2);
  assert.equal(w3.stop.snapshot().active, false);
  assert.equal(w3.stop.snapshot().resetCount, 1);
});

test('no agent run resumes automatically after a restart', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.p.startRun({ runId: 'run-1', kind: 'demo' }).ok, true);
  assert.equal(w.p.save().ok, true);
  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, true);
  // The row survives untouched, still 'running', and nothing starts it again:
  // there is no resume API on the persistence surface at all.
  const runs = w2.p.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'running');
  assert.equal(runs[0].ended_at, null);
  assert.equal(typeof w2.p.resume, 'undefined');
  // And the run can only be finished explicitly, never re-started.
  assert.equal(w2.p.finishRun({ runId: 'run-1', status: 'aborted', summary: 'left running across restart' }).ok, true);
});

test('backup and restore: exported bytes restore the full state', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.engine.grantTool({ tool: 'notes.search', ttlMs: 60_000 }).ok, true);
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.call' }).ok, true);
  assert.equal(w.p.save().ok, true);
  const bytes = w.db.db.export();
  const restoreStorage = { load: async () => bytes, save: async () => {} };
  const db2 = await LocalDb.open({ storage: restoreStorage });
  const registry = fixtures();
  const audit = createAuditLog({ clock: () => w.state.now });
  const approvals = createApprovalDesk({ clock: () => w.state.now });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock: () => w.state.now });
  const p2 = createAgentPersistence({ db: db2, clock: () => w.state.now, registry, audit, approvals, engine, emergencyStop: stop });
  const loaded = p2.load();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(audit.length, 1);
  assert.equal(engine.listGrants().length, 1);
});

test('bounded retention: pruning requires a verified archive, is audited, and the chain verifies from the new base', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.call', tool: 'notes.search' }).ok, true);
  }
  const noArchive = w.p.prune({ beforeSeq: 3 });
  assert.equal(noArchive.ok, false);
  assert.equal(noArchive.reason, 'archive_refused');

  const badArchive = {
    format: 'companiondesk.agent-audit.v1',
    base: { seq: 0, hash: '0'.repeat(64) },
    entries: [{ seq: 1, at: '1970-01-01T00:00:00.000Z', actor: 'agent', action: 'forged', hash: 'f'.repeat(64) }],
  };
  const refused = w.p.prune({ beforeSeq: 3, archive: badArchive });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'archive_refused');

  // An empty archive verifies trivially but covers nothing, so it is refused
  // as incomplete rather than allowed to unanchor the chain.
  const emptyArchive = { format: 'companiondesk.agent-audit.v1', base: { seq: 0, hash: '0'.repeat(64) }, entries: [] };
  const refusedEmpty = w.p.prune({ beforeSeq: 3, archive: emptyArchive });
  assert.equal(refusedEmpty.ok, false);
  assert.equal(refusedEmpty.reason, 'archive_incomplete');

  const exp = w.p.exportArchive();
  assert.equal(exp.ok, true);
  assert.equal(w.p.verifyArchive(exp.archive).ok, true);

  // Tamper the archive: the prune must refuse.
  const tampered = JSON.parse(JSON.stringify(exp.archive));
  tampered.entries[0].action = 'forged';
  const refused2 = w.p.prune({ beforeSeq: 3, archive: tampered });
  assert.equal(refused2.ok, false);
  assert.equal(refused2.reason, 'archive_refused');

  const ok = w.p.prune({ beforeSeq: 3, archive: exp.archive });
  assert.equal(ok.ok, true, 'prune: ' + JSON.stringify(ok));
  assert.equal(ok.prunedThrough, 3);
  assert.equal(w.audit.length, 3); // entries 4, 5 and the prune record
  assert.equal(w.audit.verify().ok, true);

  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, true, 'post-prune restart: ' + JSON.stringify(w2.loaded));
  const seqs = w2.audit.read({}).map((e) => e.seq);
  assert.deepEqual(seqs, [4, 5, 6]);
  assert.equal(w2.audit.verify().ok, true);
  assert.ok(w2.audit.read({}).some((e) => e.action === 'audit.pruned'), 'the prune itself is audited');
  // Out-of-bounds prune after the fact.
  const late = w2.p.prune({ beforeSeq: 99, archive: exp.archive });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'prune_bounds');
});

test('agent persistence leaves existing app tables and rows untouched', async () => {
  const w = await world();
  const id = w.db.upsertCourse({ name: 'Quantum Computing', code: 'CS402', term: 'Fall 2026' });
  w.db.addAssignment(id, { title: 'Midterm exam', due_date: '2026-11-05', category: 'Midterm' });
  assert.equal(w.p.load().ok, true);
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.call' }).ok, true);
  assert.equal(w.p.save().ok, true);
  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, true);
  assert.equal(w2.db.counts().courses, 1);
  assert.equal(w2.db.listAssignments(id).length, 1);
  assert.equal(w2.db.listAssignments(id)[0].title, 'Midterm exam');
});

test('a missing anchor row with audit rows present fails closed', async () => {
  const w = await world();
  assert.equal(w.p.load().ok, true);
  assert.equal(w.p.appendAudit({ actor: 'agent', action: 'tools.call' }).ok, true);
  assert.equal(w.p.save().ok, true);
  w.db.run('DELETE FROM agent_audit_anchor WHERE id = 1');
  const w2 = await restart(w);
  assert.equal(w2.loaded.ok, false);
  assert.ok(w2.loaded.problems.includes('missing_anchor'), JSON.stringify(w2.loaded.problems));
});
