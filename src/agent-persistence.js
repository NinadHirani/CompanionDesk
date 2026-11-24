'use strict';

// Gate 2 slice 2: persistence for the agent-foundation state.
//
// Storage adapter: deliberately narrow. The persistence module needs only
// db.run(sql, params), db.all(sql, params) and BEGIN/COMMIT/ROLLBACK issued
// through db.run. The desktop LocalDb and any test fake satisfy it, and the
// pure modules above stay storage-free.
//
// What persists: grants (exact tool, capability, granted/expiry, revoked),
// approvals (id, tool, args digest, requested/expiry, state), audit entries
// (the full sanitized record plus its chain hash), the audit anchor (chain
// base and last seq/hash), emergency-stop state, and agent_runs rows. Audit
// entries and the anchor are always written in ONE transaction. Nothing is
// deleted silently: pruning the audit trail requires a verified archive
// first and the prune itself is audited.
//
// Startup semantics (fail closed): load() re-verifies the persisted chain
// from the stored base and requires the anchor to match the verified tail.
// Any mismatch, gap, or invalid row sets an integrity-failure status: every
// write on this surface then refuses, and NOTHING is deleted, reset or
// repaired automatically. Recovery is an explicit, audited decision left to
// the wiring slice. Pending approvals never survive a restart as usable:
// load() invalidates them, persists the flip, and audits the invalidation;
// they can only be safely reissued as fresh requests. The emergency stop
// restores active if it was active at shutdown. No agent run is ever
// resumed automatically: a 'running' row is left exactly as it was and
// this module exposes no resume API.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentPersistence = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const strictRecord = (typeof require === 'function')
    ? require('./strict-record')
    : root.CompanionStrictRecord;
  const strictFlag = strictRecord.strictFlag;
  const strictTimestamp = strictRecord.strictTimestamp;
  const auditModule = (typeof require === 'function') ? require('./audit')
    : root.CompanionAudit;
  const GENESIS = auditModule.GENESIS;
  const toCanonicalEntry = auditModule.toCanonicalEntry;
  const chainHash = auditModule.chainHash;
  const sanitizeEntry = auditModule.sanitize;

  const ID64_RE = /^[a-f0-9]{64}$/;
  const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const RUN_KIND_RE = /^[a-z][a-z0-9_.]{0,47}$/;
  const RUN_STATES = ['running', 'succeeded', 'failed', 'aborted'];
  const APPROVAL_STATES = ['pending', 'used', 'cancelled', 'invalidated'];
  const BODY_FIELDS = ['at', 'actor', 'action', 'tool', 'decision', 'reason', 'grantId', 'approvalId', 'detail'];
  // Schema version of the agent persistence store. Bump only with an
  // explicit, additive migration; a newer version on disk fails closed.
  const SCHEMA_VERSION = 1;
  // Hard cap on a persisted audit detail blob. The sanitizer already
  // bounds every entry; this protects load() from parsing unbounded text.
  const MAX_DETAIL_JSON = 4096;
  const AUDIT_COLUMNS = 'seq, at, actor, action, tool, decision, reason, grant_id, approval_id, detail_json, hash';

  function createAgentPersistence({ db, clock, registry, audit, approvals, engine, emergencyStop, notifications, reminders } = {}) {
    if (!db || typeof db.run !== 'function' || typeof db.all !== 'function') {
      throw new TypeError('agent persistence needs a db adapter with run() and all()');
    }
    if (notifications !== undefined && notifications !== null
      && (typeof notifications.exportAll !== 'function' || typeof notifications.hydrate !== 'function'
      || typeof notifications.validate !== 'function')) {
      throw new TypeError('agent persistence needs a notifications desk with exportAll() and hydrate()');
    }
    if (reminders !== undefined && reminders !== null
      && (typeof reminders.exportAll !== 'function' || typeof reminders.hydrate !== 'function'
      || typeof reminders.validate !== 'function')) {
      throw new TypeError('agent persistence needs a reminder book with exportAll() and hydrate()');
    }
    const nowIso = clock ? () => new Date(clock()).toISOString() : () => new Date().toISOString();
    let status = { ok: true, problems: [] };
    let lastPersistedSeq = 0;

    function fail(problem) {
      status = { ok: false, problems: status.problems.concat([problem]) };
    }

    function tx(fn) {
      db.run('BEGIN');
      try {
        const result = fn();
        db.run('COMMIT');
        return result;
      } catch (err) {
        try { db.run('ROLLBACK'); } catch (e2) { /* rollback failure changes nothing further */ }
        throw err;
      }
    }

    function insertAuditRow(e) {
      db.run(
        'INSERT INTO agent_audit (seq, at, actor, action, tool, decision, reason, grant_id, approval_id, detail_json, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          e.seq, e.at, e.actor, e.action,
          e.tool === undefined ? null : e.tool,
          e.decision === undefined ? null : e.decision,
          e.reason === undefined ? null : e.reason,
          e.grantId === undefined ? null : e.grantId,
          e.approvalId === undefined ? null : e.approvalId,
          e.detail === undefined ? null : JSON.stringify(e.detail),
          e.hash,
        ]
      );
    }

    function putAnchor(baseSeq, baseHash, lastSeq, lastHash) {
      db.run(
        'INSERT OR REPLACE INTO agent_audit_anchor (id, base_seq, base_hash, last_seq, last_hash, updated_at) VALUES (1, ?, ?, ?, ?, ?)',
        [baseSeq, baseHash, lastSeq, lastHash, nowIso()]
      );
    }

    function readAnchor() {
      const rows = db.all('SELECT base_seq, base_hash, last_seq, last_hash FROM agent_audit_anchor WHERE id = 1');
      return rows.length ? rows[0] : null;
    }

    function reconstruct(row) {
      const e = { seq: row.seq, at: row.at, actor: row.actor, action: row.action, hash: row.hash };
      for (const [col, field] of [['tool', 'tool'], ['decision', 'decision'], ['reason', 'reason'], ['grant_id', 'grantId'], ['approval_id', 'approvalId']]) {
        if (row[col] !== null && row[col] !== undefined) e[field] = row[col];
      }
      if (row.detail_json !== null && row.detail_json !== undefined) e.detail = JSON.parse(row.detail_json);
      return e;
    }

    function load() {
      status = { ok: true, problems: [] };
      const problems = [];
      let invalidatedApprovals = 0;
      let last = { seq: 0, hash: GENESIS };

      // Phase 0. Schema table, READ ONLY here: structure is validated,
      // nothing is written yet. Stamping, anchor initialization and the
      // pending-approval invalidation happen only after every integrity
      // check below passes, so a corrupt database is never modified on
      // startup and an unversioned corrupt database is never stamped.
      const schemaRows = db.all('SELECT key, value FROM agent_schema ORDER BY key');
      let storedVersion = null; // null: the stamp is absent (older database)
      for (const row of schemaRows) {
        if (row.key !== 'version') {
          fail('unknown_schema_key');
          problems.push('unknown_schema_key:' + String(row.key));
          continue;
        }
        if (storedVersion !== null) {
          fail('duplicate_schema_key');
          problems.push('duplicate_schema_key');
          continue;
        }
        if (typeof row.value !== 'string' || !/^[0-9]+$/.test(row.value)) {
          fail('invalid_schema_version');
          problems.push('invalid_schema_version');
          continue;
        }
        storedVersion = Number(row.value);
      }
      if (storedVersion !== null && storedVersion > SCHEMA_VERSION) {
        // A database written by a NEWER build is never downgraded, read or
        // repaired here: the app must be updated instead. Return before any
        // further read and before any write.
        fail('schema_from_newer_build');
        problems.push('schema_from_newer_build');
        return { ok: false, problems, invalidatedApprovals: 0 };
      }

      // Phase 1. Audit chain and anchor, verified from the stored base.
      const anchorRow = readAnchor();
      const auditRows = db.all('SELECT ' + AUDIT_COLUMNS + ' FROM agent_audit ORDER BY seq');
      let base = { seq: 0, hash: GENESIS };
      if (anchorRow) {
        base = { seq: anchorRow.base_seq, hash: anchorRow.base_hash };
        if (!Number.isInteger(base.seq) || base.seq < 0 || typeof base.hash !== 'string' || !ID64_RE.test(base.hash)) {
          fail('invalid_anchor_row');
          problems.push('invalid_anchor_row');
        }
      } else if (auditRows.length) {
        fail('missing_anchor');
        problems.push('missing_anchor');
      }

      const entries = [];
      for (const row of auditRows) {
        if (row.detail_json !== null && row.detail_json !== undefined && row.detail_json.length > MAX_DETAIL_JSON) {
          fail('invalid_audit_row');
          problems.push('invalid_audit_row:' + row.seq);
          continue;
        }
        let e;
        try {
          e = reconstruct(row);
        } catch (err) {
          fail('invalid_audit_row');
          problems.push('invalid_audit_row:' + row.seq);
          continue;
        }
        entries.push(e);
      }

      if (status.ok) {
        let p = base.hash;
        let expectSeq = base.seq + 1;
        for (const e of entries) {
          if (e.seq !== expectSeq) {
            fail('sequence_gap');
            problems.push('sequence_gap:' + e.seq);
            break;
          }
          if (chainHash(e.seq, p, toCanonicalEntry(e)) !== e.hash) {
            fail('chain_broken');
            problems.push('chain_broken:' + e.seq);
            break;
          }
          const body = {};
          for (const f of BODY_FIELDS) if (e[f] !== undefined) body[f] = e[f];
          if (sanitizeEntry(body).length) {
            fail('invalid_audit_row');
            problems.push('invalid_audit_row:' + e.seq);
            break;
          }
          p = e.hash;
          last = { seq: e.seq, hash: e.hash };
          expectSeq += 1;
        }
      }
      if (status.ok && anchorRow && (anchorRow.last_seq !== last.seq || anchorRow.last_hash !== last.hash)) {
        fail('anchor_mismatch');
        problems.push('anchor_mismatch');
      }

      // Phase 2. Grants, revalidated against the registry, with bounded
      // integer timestamps: a stored float, string or out-of-range number
      // refuses instead of passing through a finite check.
      const grantRecords = [];
      for (const g of db.all('SELECT tool, capability, granted_at, expires_at, revoked FROM agent_grants ORDER BY tool')) {
        const grantedAt = strictTimestamp(g.granted_at);
        const expiresAt = g.expires_at === null || g.expires_at === undefined ? null : strictTimestamp(g.expires_at);
        const rec = {
          tool: g.tool,
          capability: g.capability,
          grantedAt,
          expiresAt,
          revoked: g.revoked === 1 ? true : g.revoked === 0 ? false : null,
        };
        const badShape = rec.grantedAt === null
          || !(rec.expiresAt === null || Number.isSafeInteger(rec.expiresAt))
          || rec.revoked === null
          || (registry && (() => { const def = registry.get(rec.tool); return !def || def.capability !== rec.capability; })());
        if (badShape) {
          fail('invalid_grant_row');
          problems.push('invalid_grant_row:' + rec.tool);
          continue;
        }
        grantRecords.push(rec);
      }

      // Phase 3. Approvals: strict shape, bounded timestamps. Pending ones
      // never survive a restart as usable (invalidated in phase 6).
      const approvalRecords = [];
      for (const r of db.all('SELECT id, tool, args_digest, requested_at, expires_at, state FROM agent_approvals ORDER BY requested_at, id')) {
        const requestedAt = strictTimestamp(r.requested_at);
        const expiresAt = strictTimestamp(r.expires_at);
        const badShape = typeof r.id !== 'string' || !ID64_RE.test(r.id)
          || typeof r.tool !== 'string'
          || typeof r.args_digest !== 'string' || !ID64_RE.test(r.args_digest)
          || requestedAt === null || expiresAt === null
          || !APPROVAL_STATES.includes(r.state);
        if (badShape) {
          fail('invalid_approval_row');
          problems.push('invalid_approval_row:' + (r.id || '?'));
          continue;
        }
        approvalRecords.push({ id: r.id, tool: r.tool, argsDigest: r.args_digest, requestedAt, expiresAt, state: r.state });
      }

      // Phase 4a. Emergency stop: shape validated HERE so phase 5 hydrates
      // deterministically. Stored flags must be exactly 0 or 1.
      const stopRows = db.all('SELECT active, reason, activated_at, activated_by, reset_count FROM agent_emergency_stop WHERE id = 1');
      let stopSnap = null;
      if (stopRows.length) {
        const r = stopRows[0];
        const active = strictFlag(r.active);
        const resetCount = r.reset_count;
        let stopBad = active === null || !Number.isSafeInteger(resetCount) || resetCount < 0;
        if (!stopBad && active) {
          stopBad = typeof r.reason !== 'string' || !r.reason || r.reason.length > 200;
        }
        if (stopBad) {
          fail('invalid_stop_row');
          problems.push('invalid_stop_row');
        } else {
          stopSnap = {
            active,
            reason: r.reason === null || r.reason === undefined ? undefined : r.reason,
            activatedAt: r.activated_at === null || r.activated_at === undefined ? undefined : r.activated_at,
            activatedBy: r.activated_by === null || r.activated_by === undefined ? undefined : r.activated_by,
            resetCount,
          };
        }
      }

      // Phase 4b. Notifications and reminders: rows are projected into
      // record shape with STRICT flags (exactly 0 or 1) and bounded
      // integer timestamps. A stored 2, a string flag or an out-of-range
      // timestamp is an invalid row, never a truthy default.
      const notificationRecords = [];
      for (const r of db.all('SELECT id, title, body, priority, created_at, read FROM agent_notifications ORDER BY id')) {
        const read = strictFlag(r.read);
        const createdAt = strictTimestamp(r.created_at);
        const bad = read === null || createdAt === null
          || typeof r.id !== 'string' || typeof r.title !== 'string'
          || typeof r.body !== 'string' || typeof r.priority !== 'string';
        if (bad) {
          fail('invalid_notification_row');
          problems.push('invalid_notification_row:' + (r.id || '?'));
          continue;
        }
        notificationRecords.push({ id: r.id, title: r.title, body: r.body, priority: r.priority, createdAt, read });
      }
      const reminderRecords = [];
      for (const r of db.all('SELECT id, title, due_at, notes, created_at, cancelled, acknowledged FROM agent_reminders ORDER BY id')) {
        const cancelled = strictFlag(r.cancelled);
        const acknowledged = r.acknowledged === null || r.acknowledged === undefined ? false : strictFlag(r.acknowledged);
        const dueAt = strictTimestamp(r.due_at);
        const createdAt = strictTimestamp(r.created_at);
        const notes = r.notes === null || r.notes === undefined ? null : r.notes;
        const bad = cancelled === null || acknowledged === null || dueAt === null || createdAt === null
          || typeof r.id !== 'string' || typeof r.title !== 'string'
          || (notes !== null && typeof notes !== 'string');
        if (bad) {
          fail('invalid_reminder_row');
          problems.push('invalid_reminder_row:' + (r.id || '?'));
          continue;
        }
        const rec = { id: r.id, title: r.title, dueAt, notes, createdAt, cancelled };
        if (acknowledged) rec.acknowledged = true;
        reminderRecords.push(rec);
      }

      // Phase 5a. Validate every store read-only. The audit chain was
      // re-verified in phase 1, grants were checked against the registry in
      // phase 2, approvals and the stop snapshot above; here the two desks
      // run their own validate(). Only when EVERY store validates does any
      // module take state, so a later refusal leaves earlier stores
      // untouched (hydration is transactional in memory).
      if (status.ok && notifications) {
        const v = notifications.validate(notificationRecords);
        if (!v.ok) { fail('notification_hydrate_refused'); problems.push('notification_hydrate_refused:' + v.reason); }
      }
      if (status.ok && reminders) {
        const v = reminders.validate(reminderRecords);
        if (!v.ok) { fail('reminder_hydrate_refused'); problems.push('reminder_hydrate_refused:' + v.reason); }
      }

      // Phase 5b. Apply: hydrate the pure modules only when everything
      // verified. Each hydrate re-runs its own validation (deterministic:
      // identical input validated above), and a refusal here is treated as
      // an integrity failure rather than a partial load.
      if (status.ok) {
        if (audit) {
          const h = audit.hydrate({ base, entries });
          if (!h.ok) { fail('audit_hydrate_refused'); problems.push('audit_hydrate_refused:' + h.reason); }
        }
        if (engine) {
          const h = engine.hydrateGrants(grantRecords);
          if (!h.ok || h.skipped > 0) { fail('grant_hydrate_refused'); problems.push('grant_hydrate_refused'); }
        }
        if (approvals) {
          const h = approvals.hydrate(approvalRecords);
          if (!h.ok) { fail('approval_hydrate_refused'); problems.push('approval_hydrate_refused'); }
          invalidatedApprovals = h.invalidated;
        }
        if (emergencyStop && stopSnap) {
          const h = emergencyStop.hydrate(stopSnap);
          if (!h.ok) { fail('invalid_stop_row'); problems.push('invalid_stop_row'); }
        }
        if (notifications) {
          const h = notifications.hydrate(notificationRecords);
          if (!h.ok) { fail('notification_hydrate_refused'); problems.push('notification_hydrate_refused:' + h.reason); }
        }
        if (reminders) {
          const h = reminders.hydrate(reminderRecords);
          if (!h.ok) { fail('reminder_hydrate_refused'); problems.push('reminder_hydrate_refused:' + h.reason); }
        }
      }

      // Phase 6. Writes, ONLY when every check passed: stamp the schema
      // version on an unversioned store, initialize the anchor on a fresh
      // store, persist the pending-approval invalidation and audit it. A
      // database that failed any check above is left byte-for-byte alone.
      if (status.ok) {
        if (storedVersion === null) {
          try {
            tx(() => db.run("INSERT OR REPLACE INTO agent_schema (key, value) VALUES ('version', ?)", [String(SCHEMA_VERSION)]));
          } catch (err) {
            fail('persist_failure');
            problems.push('persist_failure:schema_init');
          }
        }
        if (status.ok && !anchorRow && !auditRows.length) {
          try {
            tx(() => putAnchor(0, GENESIS, 0, GENESIS));
          } catch (err) {
            fail('persist_failure');
            problems.push('persist_failure:anchor_init');
          }
        }
        if (status.ok && approvals && invalidatedApprovals > 0 && audit) {
          const pending = approvalRecords.filter((r) => r.state === 'pending').map((r) => r.id);
          try {
            tx(() => {
              for (const id of pending) db.run("UPDATE agent_approvals SET state = 'invalidated' WHERE id = ? AND state = 'pending'", [id]);
            });
            // appendAudit appends to the live log AND persists the entry and
            // anchor atomically; a persist failure leaves the entry in memory
            // for the next save() to converge.
            const written = appendAudit({ actor: 'system', action: 'approvals.invalidated_on_restart', detail: { count: pending.length } });
            if (!written.ok && written.reason !== 'persist_failure') {
              fail('persist_failure');
              problems.push('persist_failure:invalidation_audit');
            }
          } catch (err) {
            fail('persist_failure');
            problems.push('persist_failure:invalidation');
          }
        }
      }

      lastPersistedSeq = status.ok ? last.seq : 0;
      return { ok: status.ok, problems, invalidatedApprovals };
    }

    function save() {
      if (!status.ok) return { ok: false, reason: 'integrity_failure', problems: [...status.problems] };
      if (!audit) return { ok: false, reason: 'no_audit' };
      const snap = audit.snapshot();
      const fresh = snap.entries.filter((e) => e.seq > lastPersistedSeq);
      const grants = engine ? engine.listGrants() : [];
      const approvalRecords = approvals ? approvals.exportAll() : [];
      const stopSnap = emergencyStop ? emergencyStop.snapshot() : null;
      const notificationRecords = notifications ? notifications.exportAll() : [];
      const reminderRecords = reminders ? reminders.exportAll() : [];
      try {
        const lastEntry = snap.entries.length ? snap.entries[snap.entries.length - 1] : null;
        const lastSeq = lastEntry ? lastEntry.seq : snap.base.seq;
        const lastHash = lastEntry ? lastEntry.hash : snap.base.hash;
        tx(() => {
          for (const e of fresh) insertAuditRow(e);
          putAnchor(snap.base.seq, snap.base.hash, lastSeq, lastHash);
          db.run('DELETE FROM agent_grants');
          for (const g of grants) {
            db.run('INSERT INTO agent_grants (tool, capability, granted_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?)', [g.tool, g.capability, g.grantedAt, g.expiresAt, g.revoked ? 1 : 0]);
          }
          db.run('DELETE FROM agent_approvals');
          for (const r of approvalRecords) {
            db.run('INSERT INTO agent_approvals (id, tool, args_digest, requested_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?)', [r.id, r.tool, r.argsDigest, r.requestedAt, r.expiresAt, r.state]);
          }
          if (stopSnap) {
            db.run('INSERT OR REPLACE INTO agent_emergency_stop (id, active, reason, activated_at, activated_by, reset_count) VALUES (1, ?, ?, ?, ?, ?)', [stopSnap.active ? 1 : 0, stopSnap.reason === undefined || stopSnap.reason === null ? null : stopSnap.reason, stopSnap.activatedAt === undefined ? null : stopSnap.activatedAt, stopSnap.activatedBy === undefined ? null : stopSnap.activatedBy, stopSnap.resetCount]);
          }
          db.run('DELETE FROM agent_notifications');
          for (const n of notificationRecords) {
            db.run('INSERT INTO agent_notifications (id, title, body, priority, created_at, read) VALUES (?, ?, ?, ?, ?, ?)', [n.id, n.title, n.body, n.priority, n.createdAt, n.read ? 1 : 0]);
          }
          db.run('DELETE FROM agent_reminders');
          for (const r of reminderRecords) {
            db.run('INSERT INTO agent_reminders (id, title, due_at, notes, created_at, cancelled, acknowledged) VALUES (?, ?, ?, ?, ?, ?, ?)', [r.id, r.title, r.dueAt, r.notes === undefined ? null : r.notes, r.createdAt, r.cancelled ? 1 : 0, r.acknowledged ? 1 : 0]);
          }
        });
        lastPersistedSeq = lastSeq;
        return { ok: true, entries: fresh.length, base: { ...snap.base }, lastSeq, lastHash };
      } catch (err) {
        // The transaction rolled back: the database is exactly as it was
        // before this save. The in-memory log keeps the entries; the next
        // successful save converges.
        return { ok: false, reason: 'persist_failure', error: String((err && err.message) || err) };
      }
    }

    function appendAudit(entry) {
      if (!status.ok) return { ok: false, reason: 'integrity_failure', problems: [...status.problems] };
      if (!audit) return { ok: false, reason: 'no_audit' };
      const res = audit.append(entry);
      if (!res.ok) return res;
      try {
        tx(() => {
          const row = audit.read({ fromSeq: res.seq, limit: 1 })[0];
          insertAuditRow(row);
          const snap = audit.snapshot();
          const lastEntry = snap.entries.length ? snap.entries[snap.entries.length - 1] : null;
          putAnchor(snap.base.seq, snap.base.hash, lastEntry ? lastEntry.seq : snap.base.seq, lastEntry ? lastEntry.hash : snap.base.hash);
        });
        lastPersistedSeq = res.seq;
        return { ok: true, seq: res.seq, hash: res.hash };
      } catch (err) {
        return { ok: false, reason: 'persist_failure', seq: res.seq, error: String((err && err.message) || err) };
      }
    }

    function exportArchive() {
      if (!status.ok) return { ok: false, reason: 'integrity_failure', problems: [...status.problems] };
      if (!audit) return { ok: false, reason: 'no_audit' };
      const snap = audit.snapshot();
      const lastEntry = snap.entries.length ? snap.entries[snap.entries.length - 1] : null;
      return {
        ok: true,
        archive: {
          format: 'companiondesk.agent-audit.v1',
          exportedAt: nowIso(),
          base: { ...snap.base },
          anchor: { seq: lastEntry ? lastEntry.seq : snap.base.seq, hash: lastEntry ? lastEntry.hash : snap.base.hash },
          entries: snap.entries.map((e) => ({ ...e })),
        },
      };
    }

    function verifyArchive(archive) {
      if (!archive || archive.format !== 'companiondesk.agent-audit.v1' || !archive.base || !Array.isArray(archive.entries)) {
        return { ok: false, reason: 'malformed_archive' };
      }
      if (!Number.isInteger(archive.base.seq) || archive.base.seq < 0 || typeof archive.base.hash !== 'string' || !ID64_RE.test(archive.base.hash)) {
        return { ok: false, reason: 'malformed_archive' };
      }
      let p = archive.base.hash;
      let expectSeq = archive.base.seq + 1;
      for (const e of archive.entries) {
        if (!e || e.seq !== expectSeq) return { ok: false, reason: 'sequence_gap', brokenAt: (e && e.seq) || expectSeq };
        const body = {};
        for (const f of BODY_FIELDS) if (e[f] !== undefined) body[f] = e[f];
        if (sanitizeEntry(body).length) return { ok: false, reason: 'invalid_entry', brokenAt: e.seq };
        if (chainHash(e.seq, p, toCanonicalEntry(e)) !== e.hash) return { ok: false, reason: 'chain_broken', brokenAt: e.seq };
        p = e.hash;
        expectSeq += 1;
      }
      const through = archive.entries.length ? archive.entries[archive.entries.length - 1].seq : archive.base.seq;
      return { ok: true, through, hash: p };
    }

    // Bounded retention for the audit trail without silent deletion: the
    // caller must supply an archive that verifies and covers the entries
    // being dropped, and the prune itself is audited. The chain base moves
    // forward so the anchored tail stays locally verifiable.
    function prune({ beforeSeq, archive } = {}) {
      if (!status.ok) return { ok: false, reason: 'integrity_failure', problems: [...status.problems] };
      if (!audit) return { ok: false, reason: 'no_audit' };
      if (!Number.isInteger(beforeSeq) || beforeSeq < 0) return { ok: false, reason: 'bad_before_seq' };
      const snap = audit.snapshot();
      const lastSeq = snap.entries.length ? snap.entries[snap.entries.length - 1].seq : snap.base.seq;
      if (beforeSeq <= snap.base.seq || beforeSeq > lastSeq) return { ok: false, reason: 'prune_bounds' };
      const v = verifyArchive(archive);
      if (!v.ok) return { ok: false, reason: 'archive_refused', detail: v.reason };
      if (archive.base.seq !== snap.base.seq) return { ok: false, reason: 'archive_base_mismatch' };
      let baseHash;
      if (beforeSeq === snap.base.seq) {
        baseHash = snap.base.hash;
      } else {
        const anchorEntry = archive.entries.find((e) => e.seq === beforeSeq);
        if (!anchorEntry) return { ok: false, reason: 'archive_incomplete' };
        baseHash = anchorEntry.hash;
      }
      // Append the prune record to the live log first (it chains from the
      // current tail, which pruning does not change), then drop the archived
      // head entries in memory and in the database in one transaction.
      const appended = audit.append({ actor: 'system', action: 'audit.pruned', detail: { pruned_through: beforeSeq, archived: true } });
      if (!appended.ok) return { ok: false, reason: 'audit_append_refused', detail: appended.reason };
      const pr = audit.pruneBase(beforeSeq, baseHash);
      if (!pr.ok) return { ok: false, reason: 'prune_refused', detail: pr.reason };
      try {
        tx(() => {
          db.run('DELETE FROM agent_audit WHERE seq <= ?', [beforeSeq]);
          insertAuditRow(audit.read({ fromSeq: appended.seq, limit: 1 })[0]);
          putAnchor(beforeSeq, baseHash, appended.seq, appended.hash);
        });
        lastPersistedSeq = appended.seq;
        return { ok: true, prunedThrough: beforeSeq, base: { seq: beforeSeq, hash: baseHash }, auditSeq: appended.seq };
      } catch (err) {
        return { ok: false, reason: 'persist_failure', error: String((err && err.message) || err) };
      }
    }

    function startRun({ runId, kind } = {}) {
      if (!status.ok) return { ok: false, reason: 'integrity_failure', problems: [...status.problems] };
      if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return { ok: false, reason: 'bad_run_id' };
      if (typeof kind !== 'string' || !RUN_KIND_RE.test(kind)) return { ok: false, reason: 'bad_run_kind' };
      try {
        tx(() => db.run('INSERT INTO agent_runs (run_id, kind, status, started_at) VALUES (?, ?, ?, ?)', [runId, kind, 'running', nowIso()]));
        return { ok: true };
      } catch (err) {
        const msg = String((err && err.message) || err);
        return { ok: false, reason: /UNIQUE/i.test(msg) ? 'duplicate_run_id' : 'persist_failure', error: msg };
      }
    }

    function finishRun({ runId, status: endStatus, summary } = {}) {
      if (!status.ok) return { ok: false, reason: 'integrity_failure', problems: [...status.problems] };
      if (!RUN_STATES.includes(endStatus) || endStatus === 'running') return { ok: false, reason: 'bad_run_status' };
      if (summary !== undefined && (typeof summary !== 'string' || summary.length > 300)) return { ok: false, reason: 'bad_run_summary' };
      const rows = db.all("SELECT id FROM agent_runs WHERE run_id = ? AND status = 'running'", [runId]);
      if (!rows.length) return { ok: false, reason: 'run_not_running' };
      try {
        tx(() => db.run('UPDATE agent_runs SET status = ?, ended_at = ?, summary = ? WHERE id = ?', [endStatus, nowIso(), summary === undefined ? null : summary, rows[0].id]));
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: 'persist_failure', error: String((err && err.message) || err) };
      }
    }

    function listRuns() {
      return db.all('SELECT run_id, kind, status, started_at, ended_at, summary FROM agent_runs ORDER BY id');
    }

    function getAuditStatus() {
      return { ok: status.ok, problems: [...status.problems] };
    }

    // Wraps the real audit log so every append is persisted and acknowledged
    // before the caller may treat a transition as committed: append() returns
    // success only after the entry and the anchor were written in one
    // transaction. A persist leg failure reports failure (the entry stays in
    // memory for the next save() to converge; the caller must NOT treat the
    // transition as durable), an integrity failure refuses, and the audit's
    // own validation result passes through untouched. Reads and verification
    // pass through to the real log.
    function durableAudit() {
      if (!audit) throw new Error('no audit configured');
      return {
        append(entry) {
          const r = appendAudit(entry);
          if (r.ok) return { ok: true, seq: r.seq, hash: r.hash };
          if (r.reason === 'persist_failure' || r.reason === 'integrity_failure' || r.reason === 'no_audit') {
            return { ok: false, reason: r.reason };
          }
          return r;
        },
        snapshot() { return audit.snapshot(); },
        read(f) { return audit.read(f); },
        hydrate(h) { return audit.hydrate(h); },
        verify(a, b) { return audit.verify(a, b); },
        pruneBase(beforeSeq, baseHash) { return audit.pruneBase(beforeSeq, baseHash); },
        exportAll() { return audit.exportAll(); },
        get lastHash() { return audit.lastHash; },
        get length() { return audit.length; },
      };
    }

    return {
      load,
      save,
      appendAudit,
      exportArchive,
      verifyArchive,
      prune,
      startRun,
      finishRun,
      listRuns,
      status: getAuditStatus,
      durableAudit,
      // NOTE: intentionally no resume API. A 'running' agent_runs row after a
      // restart stays exactly as it is; resuming a run is an explicit
      // orchestrator decision, never an automatic one.
    };
  }

  return { createAgentPersistence, APPROVAL_STATES, RUN_STATES };
});
