'use strict';

// Gate 2 AI-access connector flow (Ninad's decision, 27 Nov 2026): the AI
// may ASK the user to connect an app/website when a task requires it. This
// module is the pure request center for exactly that: the agent raises a
// user-facing connect request naming one catalog connector and a bounded
// reason, the user approves or dismisses it from the Workspace panel's
// Connectors section, and ONLY an explicit user gesture resolves a request.
// Nothing here connects anything: approving a request records the decision
// and the panel then runs the SAME explicit connect gate as the user's own
// pick (exact declared scopes, explicit user action, credential reference).
// AUTO_CONNECT stays false; a request is never a grant; no credential
// material passes through this module. Pure: no fs, no network, no timers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionConnectorRequests = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_OPEN = 25;
  const MAX_TOTAL = 50;
  const REASON_MAX = 280;
  const AUDIT_MAX = 500;

  function fail(reason) { return { ok: false, reason: reason }; }

  function createConnectorRequestCenter(opts) {
    const clock = opts && typeof opts.clock === 'function' ? opts.clock : function () { return 0; };
    const exists = opts && typeof opts.exists === 'function' ? opts.exists : function () { return false; };
    const requests = new Map(); // id -> record
    const auditLog = [];
    let seq = 0;

    function openCount() {
      let n = 0;
      for (const r of requests.values()) if (r.status === 'pending' || r.status === 'approved') n += 1;
      return n;
    }
    function pushAudit(action, id, connectorId) {
      auditLog.push({ ts: clock(), action: action, requestId: id, connectorId: connectorId });
      if (auditLog.length > AUDIT_MAX) auditLog.splice(0, auditLog.length - AUDIT_MAX);
    }

    return {
      // The agent's ask. One open request per connector; a repeat refreshes
      // the reason and counts, it never bypasses the user's decision.
      request: function (connectorId, args) {
        if (typeof connectorId !== 'string' || connectorId.length === 0 || connectorId.length > 64) return fail('bad_connector_id');
        if (!exists(connectorId)) return fail('unknown_connector');
        const reason = args && typeof args.reason === 'string' ? args.reason.trim() : '';
        if (reason.length === 0 || reason.length > REASON_MAX) return fail('reason_required_1_280');
        for (let i = 0; i < reason.length; i++) {
          const c = reason.charCodeAt(i);
          if (c < 32 || c === 127) return fail('reason_invalid');
        }
        for (const r of requests.values()) {
          if (r.connectorId === connectorId && (r.status === 'pending' || r.status === 'approved')) {
            r.reason = reason;
            r.requestedAt = clock();
            r.repeats += 1;
            pushAudit('request_repeated', r.id, connectorId);
            return { ok: true, requestId: r.id, state: r.status };
          }
        }
        if (openCount() >= MAX_OPEN) return fail('limit_reached');
        seq += 1;
        const id = 'cr-' + seq;
        requests.set(id, { id: id, connectorId: connectorId, reason: reason, requestedAt: clock(), status: 'pending', repeats: 0, resolvedAt: null });
        pushAudit('request_created', id, connectorId);
        return { ok: true, requestId: id, state: 'pending' };
      },
      list: function () {
        const all = Array.from(requests.values()).sort(function (a, b) { return a.requestedAt - b.requestedAt; });
        const kept = all.slice(-MAX_TOTAL);
        const dropped = new Set(all.slice(0, Math.max(0, all.length - MAX_TOTAL)).map(function (r) { return r.id; }));
        for (const id of dropped) requests.delete(id);
        return kept.map(function (r) {
          return { id: r.id, connectorId: r.connectorId, reason: r.reason, requestedAt: r.requestedAt, status: r.status, repeats: r.repeats };
        });
      },
      // ONLY an explicit user gesture resolves a request. Approval does NOT
      // connect: the panel runs the existing explicit connect gate after it.
      resolve: function (requestId, args) {
        if (typeof requestId !== 'string' || requestId.length === 0) return fail('bad_request_id');
        const r = requests.get(requestId);
        if (!r) return fail('unknown_request');
        if (!args || args.userInitiated !== true) return fail('requires_user_action');
        const decision = args.decision;
        if (decision !== 'approved' && decision !== 'dismissed') return fail('bad_decision');
        if (r.status !== 'pending') return fail('not_pending');
        r.status = decision;
        r.resolvedAt = clock();
        pushAudit(decision === 'approved' ? 'request_approved' : 'request_dismissed', r.id, r.connectorId);
        return { ok: true, status: r.status, connectorId: r.connectorId };
      },
      audit: function () { return auditLog.slice(); },
      snapshot: function () {
        return { requests: Array.from(requests.values()).map(function (r) {
          return { id: r.id, connectorId: r.connectorId, reason: r.reason, requestedAt: r.requestedAt, status: r.status, repeats: r.repeats, resolvedAt: r.resolvedAt };
        }) };
      },
      restore: function (snap) {
        const problems = [];
        if (!snap || !Array.isArray(snap.requests)) return { ok: false, problems: ['bad_snapshot'] };
        for (const r of snap.requests) {
          if (!r || typeof r !== 'object') { problems.push('bad_record'); continue; }
          if (typeof r.id !== 'string' || !/^cr-[0-9]+$/.test(r.id)) { problems.push('bad_id'); continue; }
          if (typeof r.connectorId !== 'string' || !exists(r.connectorId)) { problems.push('unknown_connector'); continue; }
          if (typeof r.reason !== 'string' || r.reason.length === 0 || r.reason.length > REASON_MAX) { problems.push('bad_reason'); continue; }
          if (r.status !== 'pending' && r.status !== 'approved' && r.status !== 'dismissed') { problems.push('bad_status'); continue; }
          if (typeof r.requestedAt !== 'number' || !isFinite(r.requestedAt)) { problems.push('bad_ts'); continue; }
          if (requests.has(r.id)) { problems.push('duplicate_id'); continue; }
          const n = parseInt(r.id.slice(3), 10);
          if (n > seq) seq = n;
          requests.set(r.id, { id: r.id, connectorId: r.connectorId, reason: r.reason, requestedAt: r.requestedAt, status: r.status, repeats: typeof r.repeats === 'number' ? r.repeats : 0, resolvedAt: typeof r.resolvedAt === 'number' ? r.resolvedAt : null });
        }
        return { ok: problems.length === 0, problems: problems };
      },
    };
  }

  return { createConnectorRequestCenter: createConnectorRequestCenter };
});
