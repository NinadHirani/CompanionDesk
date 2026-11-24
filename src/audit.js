'use strict';

// Gate 2 slice 1: append-only audit log. Pure.
//
// Records what the agent-foundation layer decided: who asked, for which
// tool, what was decided and why. It never records prompts, secrets,
// credentials or raw tool outputs: the event schema is an ALLOWLIST of
// short, typed fields, and any disallowed key, secret-shaped key, or
// oversized or structured value is refused, never truncated or stored.
// Entries are hash-chained (SHA-256 over the entry plus the previous
// entry's hash), so edits, insertions or deletions are detectable with
// verify(). There is deliberately no update or delete API: the only write
// is append.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAudit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const digestModule = (typeof require === 'function') ? require('./digest') : root.CompanionDigest;
  const { canonicalJson, sha256Hex } = digestModule;

  const ACTORS = ['user', 'agent', 'system'];
  const DECISIONS = ['allowed', 'denied'];
  const ACTION_RE = /^[a-z][a-z0-9_.]{0,47}$/;
  const TOOL_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;
  const ID_RE = /^[a-f0-9]{8,128}$/;
  const REASON_RE = /^[a-z][a-z0-9_]{0,47}$/;
  const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const GENESIS = '0'.repeat(64);

  // Key fragments that must never appear in an audit event, in any form:
  // prompt text, secrets, credentials, raw arguments or tool output.
  const FORBIDDEN_KEY_PARTS = ['prompt', 'secret', 'password', 'token', 'key', 'credential', 'apikey', 'args', 'output', 'content', 'message', 'text', 'result', 'payload', 'body', 'blob', 'history', 'transcript'];
  const ENTRY_FIELDS = ['at', 'actor', 'action', 'tool', 'decision', 'reason', 'grantId', 'approvalId', 'detail'];
  const MAX_DETAIL_KEYS = 8;
  const MAX_DETAIL_STRING = 200;

  function keyIsForbidden(k) {
    const lower = k.toLowerCase();
    return FORBIDDEN_KEY_PARTS.some((p) => lower.includes(p));
  }

  function sanitize(entry) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return ['entry_not_object'];
    const errors = [];
    for (const k of Object.keys(entry)) {
      if (!ENTRY_FIELDS.includes(k)) errors.push('unknown_field:' + k);
    }
    if (typeof entry.actor !== 'string' || !ACTORS.includes(entry.actor)) errors.push('bad_actor');
    if (typeof entry.action !== 'string' || !ACTION_RE.test(entry.action)) errors.push('bad_action');
    if (entry.at !== undefined && (typeof entry.at !== 'string' || !AT_RE.test(entry.at))) errors.push('bad_at');
    if (entry.tool !== undefined && (typeof entry.tool !== 'string' || !TOOL_RE.test(entry.tool))) errors.push('bad_tool');
    if (entry.decision !== undefined && (typeof entry.decision !== 'string' || !DECISIONS.includes(entry.decision))) errors.push('bad_decision');
    if (entry.reason !== undefined && (typeof entry.reason !== 'string' || !REASON_RE.test(entry.reason))) errors.push('bad_reason');
    for (const idf of ['grantId', 'approvalId']) {
      if (entry[idf] !== undefined && (typeof entry[idf] !== 'string' || !ID_RE.test(entry[idf]))) errors.push('bad_' + idf);
    }
    if (entry.detail !== undefined) {
      const d = entry.detail;
      if (d === null || typeof d !== 'object' || Array.isArray(d)) {
        errors.push('bad_detail');
      } else {
        const keys = Object.keys(d);
        if (keys.length > MAX_DETAIL_KEYS) errors.push('detail_too_many_keys');
        for (const k of keys) {
          if (!/^[a-z][a-z0-9_]{0,31}$/.test(k)) { errors.push('bad_detail_key:' + k); continue; }
          if (keyIsForbidden(k)) { errors.push('forbidden_detail_key:' + k); continue; }
          const v = d[k];
          const tv = typeof v;
          if (tv === 'string') { if (v.length > MAX_DETAIL_STRING) errors.push('detail_value_too_long:' + k); }
          else if (tv === 'number') { if (!Number.isFinite(v)) errors.push('bad_detail_value:' + k); }
          else if (tv === 'boolean') { /* fine */ }
          else errors.push('bad_detail_value:' + k);
        }
      }
    }
    return errors;
  }

  // The exact canonical string an entry hashes over. Both append and verify
  // go through this one function, so they can never disagree.
  function toCanonicalEntry(e) {
    const clean = { at: e.at, actor: e.actor, action: e.action };
    for (const f of ['tool', 'decision', 'reason', 'grantId', 'approvalId', 'detail']) {
      if (e[f] !== undefined) clean[f] = e[f];
    }
    return canonicalJson(clean);
  }

  function chainHash(seq, prevHash, canonicalEntry) {
    return sha256Hex('companiondesk.audit.v1|' + seq + '|' + prevHash + '|' + canonicalEntry);
  }

  function createAuditLog({ clock } = {}) {
    const nowIso = clock ? () => new Date(clock()).toISOString() : () => new Date().toISOString();
    const entries = [];
    let seq = 0;
    let prevHash = GENESIS;

    const log = {
      append(entry) {
        const errors = sanitize(entry);
        if (errors.length) return { ok: false, errors };
        const clean = {
          at: entry.at !== undefined ? entry.at : nowIso(),
          actor: entry.actor,
          action: entry.action,
        };
        for (const f of ['tool', 'decision', 'reason', 'grantId', 'approvalId', 'detail']) {
          if (entry[f] !== undefined) clean[f] = entry[f];
        }
        seq += 1;
        const canonicalEntry = toCanonicalEntry(clean);
        const hash = chainHash(seq, prevHash, canonicalEntry);
        entries.push(Object.freeze({ ...clean, seq, hash }));
        prevHash = hash;
        return { ok: true, seq, hash };
      },

      read({ fromSeq = 1, limit } = {}) {
        const out = [];
        for (const e of entries) {
          if (e.seq >= fromSeq) {
            out.push({ ...e });
            if (limit !== undefined && out.length >= limit) break;
          }
        }
        return out;
      },

      // Full copy for persistence or an external checker. Copies only: the
      // caller cannot reach the stored entries from here.
      exportAll() {
        return entries.map((e) => ({ ...e }));
      },

      get lastHash() { return prevHash; },
      get length() { return entries.length; },

      // Recomputes the chain. With no argument it checks the live log; with
      // an exported record array it checks that copy, which is what makes
      // tampering with a persisted export detectable.
      verify(records) {
        const list = records || entries;
        let p = GENESIS;
        for (const e of list) {
          if (typeof e.seq !== 'number' || typeof e.hash !== 'string') return { ok: false, brokenAt: e.seq || 0, reason: 'malformed_entry' };
          const expect = chainHash(e.seq, p, toCanonicalEntry(e));
          if (expect !== e.hash) return { ok: false, brokenAt: e.seq };
          p = e.hash;
        }
        return { ok: true };
      },
    };
    return log;
  }

  return { createAuditLog, sanitize, GENESIS };
});
