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
 * OAuth token lifecycle (27 Nov 2026, Ninad's batch-2 go-ahead): for an
 * oauth_json adapter the engine parses the stored blob (connector-tokens)
 * before any request is built. When the access token is expired or inside
 * the refresh skew AND a refresh token plus the user's own client
 * credentials are present, it runs one refresh through the adapter's own
 * token endpoint request, rotates the blob in the vault through the
 * injected credentialWriter, and only then builds the action. A 400/401
 * from the token endpoint classifies as reauth_required: the injected
 * onReauthRequired hook disconnects the connector and drops its stored
 * credential so nothing stale survives, and the caller is told to
 * re-authenticate. Any other refresh failure is transient
 * (refresh_failed) and the stored credential is kept. A provider 401 on
 * the action itself earns exactly ONE refresh-and-retry; a second 401 is
 * reported as-is. Audit entries for refreshes carry status and duration
 * only: never URLs, headers, tokens or response bodies.
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

  var connectorTokens = typeof require === 'function' ? require('./connector-tokens.js') : (root && root.CompanionConnectorTokens) || null;

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
    const credentialWriter = opts.credentialWriter || null;
    const onReauthRequired = opts.onReauthRequired || null;
    const clock = opts.clock || function () { return 0; };
    const maxResponseChars = opts.maxResponseChars || DEFAULT_MAX_RESPONSE_CHARS;
    const auditLog = [];

    function pushAudit(entry) {
      auditLog.push(entry);
      if (auditLog.length > MAX_AUDIT) auditLog.splice(0, auditLog.length - MAX_AUDIT);
    }

    // One refresh attempt through the adapter's own token endpoint
    // request. On success the rotated blob is persisted through the
    // injected credentialWriter (the vault is the only place it lives);
    // on a 400/401 the grant is dead so the failure-safe hook disconnects
    // the connector; anything else stays transient and the stored
    // credential is left untouched.
    async function tryRefresh(id, blob) {
      const rr = adapters.refreshRequest(id, { client_id: blob.client_id, client_secret: blob.client_secret }, blob.refresh_token);
      if (!rr || !rr.ok) return { ok: false, reason: 'refresh_failed' };
      const t0 = clock();
      let res = null;
      try {
        res = await transport(rr.request);
      } catch (e) {
        pushAudit({ ts: clock(), action: 'connector_refresh', id: id, status: 'transport_error', ms: clock() - t0 });
        return { ok: false, reason: 'refresh_failed' };
      }
      if (!res || typeof res.status !== 'number' || typeof res.body !== 'string') {
        pushAudit({ ts: clock(), action: 'connector_refresh', id: id, status: 'transport_error', ms: clock() - t0 });
        return { ok: false, reason: 'refresh_failed' };
      }
      const ms = clock() - t0;
      if (res.status < 200 || res.status >= 300) {
        const cls = connectorTokens ? connectorTokens.classifyRefreshFailure(res.status) : 'refresh_failed';
        pushAudit({ ts: clock(), action: 'connector_refresh', id: id, status: cls, ms: ms });
        if (cls === 'reauth_required' && onReauthRequired) {
          try { onReauthRequired(id); } catch (e2) { /* never let the hook break the refusal */ }
        }
        return { ok: false, reason: cls, status: res.status };
      }
      const parsed = connectorTokens ? connectorTokens.parseTokenResponse(res.body) : { ok: false };
      if (!parsed || !parsed.ok) {
        pushAudit({ ts: clock(), action: 'connector_refresh', id: id, status: 'token_response_invalid', ms: ms });
        return { ok: false, reason: 'refresh_failed' };
      }
      const merged = connectorTokens ? connectorTokens.applyRefresh(blob, parsed.token, clock()) : { ok: false };
      if (!merged || !merged.ok) {
        pushAudit({ ts: clock(), action: 'connector_refresh', id: id, status: 'token_response_invalid', ms: ms });
        return { ok: false, reason: 'refresh_failed' };
      }
      if (credentialWriter) {
        let saved = false;
        try { saved = credentialWriter(id, JSON.stringify(merged.blob)) === true; } catch (e3) { saved = false; }
        if (!saved) {
          // Rotation must survive: a provider may invalidate the old
          // refresh token once a new one is issued, so an unpersisted
          // rotation would silently brick the connection on the NEXT
          // refresh. Fail the action instead of gambling.
          pushAudit({ ts: clock(), action: 'connector_refresh', id: id, status: 'persist_failed', ms: ms });
          return { ok: false, reason: 'refresh_persist_failed' };
        }
      }
      pushAudit({ ts: clock(), action: 'connector_refresh', id: id, status: 'ok', ms: ms });
      return { ok: true, blob: merged.blob };
    }

    async function requestOnce(id, action, params, credential) {
      const built = adapters.buildRequest(id, action.id, params, credential);
      if (!built.ok) return { builtFailed: true, reason: built.reason };
      const t0 = clock();
      let res;
      try {
        res = await transport(built.request);
      } catch (e) {
        // Transport failures must not leak the request: no URL (some
        // providers carry the secret in the URL), no headers, no body.
        pushAudit({ ts: clock(), action: 'connector_action', id: id, actionId: action.id, scope: action.scope, kind: action.kind, status: 'transport_error', ms: clock() - t0 });
        return { ok: false, reason: 'transport_error', status: (e && typeof e.status === 'number') ? e.status : null };
      }
      if (!res || typeof res.status !== 'number' || typeof res.body !== 'string') {
        pushAudit({ ts: clock(), action: 'connector_action', id: id, actionId: action.id, scope: action.scope, kind: action.kind, status: 'transport_error', ms: clock() - t0 });
        return { ok: false, reason: 'transport_error', status: null };
      }
      let data = null;
      if (res.body.length > 0) {
        try { data = JSON.parse(res.body); } catch (e) { data = { raw: res.body }; }
      }
      const statusOk = res.status >= 200 && res.status < 300;
      pushAudit({ ts: clock(), action: 'connector_action', id: id, actionId: action.id, scope: action.scope, kind: action.kind, status: statusOk ? 'ok' : 'http_' + res.status, ms: clock() - t0 });
      return {
        ok: statusOk,
        status: res.status,
        reason: statusOk ? null : 'provider_error',
        data: statusOk ? truncate(scrub(data, maxResponseChars), maxResponseChars) : scrub(data, maxResponseChars),
      };
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
      // Batch 3 (27 Nov 2026): a bad parameter set refuses BEFORE the
      // consent gate so an invalid run can never burn a single-use approval.
      const badParams = adapters.validateOnly ? adapters.validateOnly(id, actionId, params) : null;
      if (badParams) return { ok: false, reason: badParams };

      const authz = catalog.authorizeCall(id, action.scope, { approvalId: runOpts && runOpts.approvalId });
      if (!authz.allowed) return { ok: false, reason: authz.reason };

      const credential = credentialReader ? credentialReader(id) : null;
      // Batch 7 (27 Nov 2026): authShape 'public' adapters call keyless
      // public APIs; no credential exists to resolve and the connect +
      // scope gate above is the whole consent story.
      let credentialForBuild = credential;
      if (adapter.authShape === 'public') {
        credentialForBuild = null;
      } else if (typeof credential !== 'string' || credential.length === 0) {
        return { ok: false, reason: 'credential_missing' };
      }

      // OAuth lifecycle: an expired (or near-expiry) access token is
      // refreshed BEFORE the action, using the adapter's own refresh
      // request, and the rotated blob is written back to the vault.
      if (adapter.authShape === 'oauth_json' && connectorTokens) {
        const parsed = connectorTokens.parseBlob(credential);
        if (!parsed.ok) return { ok: false, reason: parsed.reason };
        const blob = parsed.blob;
        if (connectorTokens.canRefresh(blob) && connectorTokens.needsRefresh(blob, clock())) {
          const rf = await tryRefresh(id, blob);
          if (!rf.ok) return { ok: false, reason: rf.reason, status: rf.status || null };
          credentialForBuild = JSON.stringify(rf.blob);
        }
      }

      let out = await requestOnce(id, action, params, credentialForBuild);
      if (out.builtFailed) return { ok: false, reason: out.reason };
      // A provider 401 on the action itself earns exactly ONE
      // refresh-and-retry when the blob is refreshable; a second 401 (or
      // any non-refreshable credential) is reported as-is.
      if (out.status === 401 && adapter.authShape === 'oauth_json' && connectorTokens) {
        const pb = connectorTokens.parseBlob(credentialForBuild);
        if (pb.ok && connectorTokens.canRefresh(pb.blob)) {
          const rf = await tryRefresh(id, pb.blob);
          if (rf.ok) {
            const retry = await requestOnce(id, action, params, JSON.stringify(rf.blob));
            if (!retry.builtFailed) out = retry;
          }
          // A failed post-401 refresh leaves the original 401 standing:
          // honest provider_error with the status the provider returned.
        }
      }
      return out;
    }

    function audit() { return auditLog.slice(); }

    return { run: run, audit: audit, maxResponseChars: maxResponseChars };
  }

  return { createActionEngine: createActionEngine, scrub: scrub, truncate: truncate };
});
