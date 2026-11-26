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

  // Secure 32-byte randomness for approval ids. Node: crypto.randomBytes.
  // Browser: crypto.getRandomValues. If NEITHER is available the function
  // returns null and every approval request must fail closed: a predictable
  // id is not a nonce, so no weaker fallback (Math.random, counters, clocks)
  // is ever used. Tests inject their own generator through randomHex.
  function secureRandomHex(bytes) {
    if (typeof require === 'function') {
      try {
        const nodeCrypto = require('crypto');
        if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') {
          return nodeCrypto.randomBytes(bytes).toString('hex');
        }
      } catch (e) { /* fall through to the Web API */ }
    }
    const webCrypto = (typeof globalThis !== 'undefined') ? globalThis.crypto : undefined;
    if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
      const buf = new Uint8Array(bytes);
      webCrypto.getRandomValues(buf);
      let out = '';
      for (const b of buf) out += b.toString(16).padStart(2, '0');
      return out;
    }
    return null;
  }

  function createApprovalDesk({ clock, ttlMs, randomHex } = {}) {
    const now = clock || (() => Date.now());
    const nextRandom = randomHex === undefined ? secureRandomHex : randomHex;
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS)) {
      throw new TypeError('approval ttl out of range');
    }
    const ttl = ttlMs === undefined ? DEFAULT_TTL_MS : ttlMs;
    const byId = new Map();
    const STATE_REASONS = { used: 'approval_used', cancelled: 'approval_cancelled', invalidated: 'approval_invalidated' };

      // Persisted-state surface: export for save, hydrate for load. Pending
      // approvals never survive a restart as usable; the loader invalidates
      // them and they can only be safely reissued as fresh requests.
    const desk = {
      exportAll() {
        return [...byId.values()].map((r) => ({ id: r.id, tool: r.tool, argsDigest: r.argsDigest, requestedAt: r.requestedAt, expiresAt: r.expiresAt, state: r.state }));
      },
      hydrate(records, { invalidatePending = true } = {}) {
        const list = Array.isArray(records) ? records : [];
        let restored = 0;
        let invalidated = 0;
        for (const r of list) {
          if (!r || typeof r.id !== 'string' || !/^[a-f0-9]{64}$/.test(r.id) || typeof r.tool !== 'string' || typeof r.argsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.argsDigest) || !Number.isFinite(r.requestedAt) || !Number.isFinite(r.expiresAt)) continue;
          if (byId.has(r.id)) continue;
          let state = r.state;
          if (state === 'pending' && invalidatePending) state = 'invalidated';
          if (!STATE_REASONS[state] && state !== 'pending') continue;
          byId.set(r.id, { id: r.id, tool: r.tool, argsDigest: r.argsDigest, requestedAt: r.requestedAt, expiresAt: r.expiresAt, state });
          if (state === 'invalidated') invalidated += 1;
          else restored += 1;
        }
        return { ok: true, restored, invalidated };
      },
      // The user's explicit yes for one exact run. Returns the record the
      // policy engine later verifies against the exact same args.
      request({ tool, args } = {}) {
        if (typeof tool !== 'string' || tool.length === 0 || tool.length > TOOL_MAX) return { ok: false, reason: 'approval_tool_invalid' };
        if (args === undefined || args === null || typeof args !== 'object') return { ok: false, reason: 'approval_args_missing' };
        let dg;
        try {
          dg = argsDigest(tool, args);
        } catch (e) {
          // args are not plain JSON-like data (accessors, symbols, sparse
          // arrays, hidden properties): fail closed, never digest them
          return { ok: false, reason: 'approval_args_not_plain_data' };
        }
        // Fail closed when secure randomness is unavailable: an id that a
        // caller could predict is not a nonce, so no approval is issued.
        const id = nextRandom ? nextRandom(32) : null;
        if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return { ok: false, reason: 'secure_randomness_unavailable' };
        const requestedAt = now();
        const record = {
          id,
          tool,
          argsDigest: dg,
          requestedAt,
          expiresAt: requestedAt + ttl,
          state: 'pending',
        };
        byId.set(record.id, record);
        const { argsDigest: digestEcho, state } = record;
        return { ok: true, approval: { id, tool, argsDigest: digestEcho, requestedAt, expiresAt: record.expiresAt, state } };
      },

      // Read-only check: the policy engine calls this. It changes nothing.
      verify(id, { tool, args } = {}) {
        const record = (typeof id === 'string') ? byId.get(id) : null;
        if (!record) return { ok: false, reason: 'approval_unknown' };
        if (record.state !== 'pending') return { ok: false, reason: STATE_REASONS[record.state] || 'approval_unknown_state' };
        if (now() >= record.expiresAt) return { ok: false, reason: 'approval_expired' };
        if (record.tool !== tool) return { ok: false, reason: 'approval_tool_mismatch' };
        // Fail closed (26 Nov 2026): the same non-plain args request()
        // refuses with approval_args_not_plain_data must be refused here
        // too, never a TypeError escaping the desk.
        let dg;
        try {
          dg = argsDigest(tool, args);
        } catch (e) {
          return { ok: false, reason: 'approval_args_not_plain_data' };
        }
        if (dg !== record.argsDigest) return { ok: false, reason: 'approval_args_mismatch' };
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
