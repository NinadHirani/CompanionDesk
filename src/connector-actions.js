/**
 * Connector action engine (27 Nov 2026, Ninad's go-ahead: real adapter
 * execution with the consent model intact). Pure: the HTTPS transport is
 * injected, so tests drive it with a fake and nothing here opens a socket.
 *
 * Every action runs the FULL gate chain before any request is built:
 *   1. the connector must exist in the catalog (unknown_connector),
 *   2. an implemented adapter must exist for it (no_adapter: definition-only
 *      entries and legacy entries without adapters can never execute),
 *   3. the connector must be CONNECTED by the user (not_connected),
 *   4. the action's scope must be declared AND granted at connect time
 *      (authorizeCall: scope_not_granted),
 *   5. write/send/delete scopes additionally need a single-use approval the
 *      user granted for exactly this connector + scope (authorizeCall:
 *      approval_required),
 *   6. a credential must exist in the OS vault (credential_missing).
 * authorizeCall stays the single consent authority; this engine adds no
 * bypass and accepts no state that the catalog did not already allow.
 *
 * Secrets never leak: the audit trail carries connector id, action id,
 * scope, kind, status and duration only (never URLs, headers, tokens or
 * param values), transport failures are reported as transport_error with
 * the status code alone, and result bodies are scrubbed of common
 * credential-shaped URL parameters before returning.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionConnectorActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_MAX_RESPONSE_CHARS = 20000;
  const MAX_AUDIT = 500;
  // Credential-shaped URL parameters that must never survive into a result.
  const SECRET_QUERY_RE = /((?:key|token|access_token|client_secret|api_?key|sig|signature)=)[^&\s"'<>]+/gi;

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  }

  function scrub(value, maxChars) {
    let out;
    if (typeof value === 'string') {
      out = value.replace(SECRET_QUERY_RE, '$1REDACTED');
    } else if (Array.isArray(value)) {
      out = value.map(function (v) { return scrub(v, maxChars); });
    } else if (isPlainObject(value)) {
      out = {};
      for (const k of Object.keys(value)) out[k] = scrub(value[k], maxChars);
    } else {
      out = value;
    }
    return out;
  }

  function truncate(data, maxChars) {
    if (data === null || data === undefined) return data;
    let json = null;
    try { json = JSON.stringify(data); } catch (e) { return { raw: '[unserializable response]' }; }
    if (json.length <= maxChars) return data;
    return { truncated: true, raw: json.slice(0, maxChars) };
  }

  function createActionEngine(opts) {
    const catalog = opts.catalog;
    const adapters = opts.adapters;
    const transport = opts.transport;
    const credentialReader = opts.credentialReader;
    const clock = opts.clock || function () { return 0; };
    const maxResponseChars = opts.maxResponseChars || DEFAULT_MAX_RESPONSE_CHARS;
    const auditLog = [];

    function pushAudit(entry) {
      auditLog.push(entry);
      if (auditLog.length > MAX_AUDIT) auditLog.splice(0, auditLog.length - MAX_AUDIT);
    }

    async function run(id, actionId, params, runOpts) {
      const entry = catalog.describe(id);
      if (!entry) return { ok: false, reason: 'unknown_connector' };
      const adapter = adapters.get(id);
      if (!adapter) return { ok: false, reason: 'no_adapter' };
      if (catalog.state(id) !== 'connected') return { ok: false, reason: 'not_connected' };
      const actions = adapters.listActions(id) || [];
      const action = actions.find(function (a) { return a.id === actionId; });
      if (!action) return { ok: false, reason: 'unknown_action' };

      // The single consent gate: the catalog decides whether this connector
      // + scope + approval combination is allowed to run at all.
      const authz = catalog.authorizeCall(id, action.scope, { approvalId: runOpts && runOpts.approvalId });
      if (!authz.allowed) return { ok: false, reason: authz.reason };

      const credential = credentialReader ? credentialReader(id) : null;
      if (typeof credential !== 'string' || credential.length === 0) return { ok: false, reason: 'credential_missing' };

      const built = adapters.buildRequest(id, actionId, params, credential);
      if (!built.ok) return { ok: false, reason: built.reason };

      const t0 = clock();
      let res;
      try {
        res = await transport(built.request);
      } catch (e) {
        // Transport failures must not leak the request: no URL (some
        // providers carry the secret in the URL), no headers, no body.
        pushAudit({ ts: clock(), action: 'connector_action', id: id, actionId: actionId, scope: action.scope, kind: action.kind, status: 'transport_error', ms: clock() - t0 });
        return { ok: false, reason: 'transport_error', status: (e && typeof e.status === 'number') ? e.status : null };
      }
      if (!res || typeof res.status !== 'number' || typeof res.body !== 'string') {
        pushAudit({ ts: clock(), action: 'connector_action', id: id, actionId: actionId, scope: action.scope, kind: action.kind, status: 'transport_error', ms: clock() - t0 });
        return { ok: false, reason: 'transport_error', status: null };
      }
      let data = null;
      if (res.body.length > 0) {
        try { data = JSON.parse(res.body); } catch (e) { data = { raw: res.body }; }
      }
      const statusOk = res.status >= 200 && res.status < 300;
      pushAudit({ ts: clock(), action: 'connector_action', id: id, actionId: actionId, scope: action.scope, kind: action.kind, status: statusOk ? 'ok' : 'http_' + res.status, ms: clock() - t0 });
      return {
        ok: statusOk,
        status: res.status,
        reason: statusOk ? null : 'provider_error',
        data: statusOk ? truncate(scrub(data, maxResponseChars), maxResponseChars) : scrub(data, maxResponseChars),
      };
    }

    function audit() { return auditLog.slice(); }

    return { run: run, audit: audit, maxResponseChars: maxResponseChars };
  }

  return { createActionEngine: createActionEngine, scrub: scrub, truncate: truncate };
});
