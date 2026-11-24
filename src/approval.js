'use strict';

// Gate 2 slice 1: approval decisions for dangerous tool executions. Pure.
//
// An approval binds ONE action: the exact tool name and the exact argument
// set, via a SHA-256 digest over the canonical JSON of both. It is one-time:
// consuming it marks it used, and any second consumption, any change to the
// arguments, any other tool, or an expiry is refused. There is deliberately
// no way to approve "a tool in general": every approval carries the digest
// of the exact run it authorizes. The default lifetime is short (2 minutes)
// because the point is approval immediately before execution, not consent in
// advance.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionApprovals = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const digestModule = (typeof require === 'function') ? require('./digest') : root.CompanionDigest;
  const { canonicalJson, sha256Hex } = digestModule;

  const DEFAULT_TTL_MS = 2 * 60000;
  const MAX_TTL_MS = 15 * 60000;
  const TOOL_MAX = 128;

  function argsDigest(tool, args) {
    return sha256Hex('companiondesk.approval.v1\n' + tool + '\n' + canonicalJson(args));
  }

  function createApprovalDesk({ clock, ttlMs } = {}) {
    const now = clock || (() => Date.now());
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS)) {
      throw new TypeError('approval ttl out of range');
    }
    const ttl = ttlMs === undefined ? DEFAULT_TTL_MS : ttlMs;
    const byId = new Map();
    let seq = 0;

    const desk = {
      // The user's explicit yes for one exact run. Returns the record the
      // policy engine later verifies against the exact same args.
      request({ tool, args } = {}) {
        if (typeof tool !== 'string' || tool.length === 0 || tool.length > TOOL_MAX) return { ok: false, reason: 'approval_tool_invalid' };
        if (args === undefined || args === null || typeof args !== 'object') return { ok: false, reason: 'approval_args_missing' };
        const dg = argsDigest(tool, args);
        seq += 1;
        const requestedAt = now();
        const record = {
          id: sha256Hex('companiondesk.nonce.v1\n' + seq + '\n' + dg + '\n' + String(requestedAt)),
          tool,
          argsDigest: dg,
          requestedAt,
          expiresAt: requestedAt + ttl,
          state: 'pending',
        };
        byId.set(record.id, record);
        const { id, argsDigest: digestEcho, state } = record;
        return { ok: true, approval: { id, tool, argsDigest: digestEcho, requestedAt, expiresAt: record.expiresAt, state } };
      },

      // Read-only check: the policy engine calls this. It changes nothing.
      verify(id, { tool, args } = {}) {
        const record = (typeof id === 'string') ? byId.get(id) : null;
        if (!record) return { ok: false, reason: 'approval_unknown' };
        if (record.state !== 'pending') return { ok: false, reason: record.state === 'used' ? 'approval_used' : 'approval_cancelled' };
        if (now() >= record.expiresAt) return { ok: false, reason: 'approval_expired' };
        if (record.tool !== tool) return { ok: false, reason: 'approval_tool_mismatch' };
        if (argsDigest(tool, args) !== record.argsDigest) return { ok: false, reason: 'approval_args_mismatch' };
        return { ok: true };
      },

      // The executor's step, immediately before execution. One-time: a
      // second consume of the same id is refused even with identical args.
      consume(id, { tool, args } = {}) {
        const check = desk.verify(id, { tool, args });
        if (!check.ok) return check;
        byId.get(id).state = 'used';
        return { ok: true };
      },

      cancel(id) {
        const record = (typeof id === 'string') ? byId.get(id) : null;
        if (!record) return { ok: false, reason: 'approval_unknown' };
        if (record.state !== 'pending') return { ok: false, reason: 'approval_not_cancellable' };
        record.state = 'cancelled';
        return { ok: true };
      },

      get(id) {
        const record = (typeof id === 'string') ? byId.get(id) : null;
        if (!record) return null;
        const { id: _omit, tool, argsDigest, requestedAt, expiresAt, state } = record;
        return { id, tool, argsDigest, requestedAt, expiresAt, state };
      },
    };
    return desk;
  }

  return { createApprovalDesk, argsDigest, DEFAULT_TTL_MS, MAX_TTL_MS };
});
