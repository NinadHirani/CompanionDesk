'use strict';

// M8 connector catalog + connection settings core. Gate 2 decision by Ninad
// (26 Nov 2026 evening): build the free-first worldwide connector discovery
// catalog and the settings to manage connections, with paid requirements and
// limits made clear BEFORE activation, secure credential handling, explicit
// per-connector permission scopes, the full connection lifecycle
// (connect/disconnect/reconnect/revoke/readmit + authorize/test), and
// approval gates for sensitive/write/send/delete/external actions. There is
// deliberately NO blanket auto-connect and NO automatic permission grant:
// AUTO_CONNECT is a constant false and the only door to a connected state is
// an explicit user action with exact scopes and an opaque credential
// reference. Pure: no fs, no network, no timers, no model, no real
// connectors; secrets never enter this module because it only ever accepts
// opaque keychain/vault references. The catalog is broad but everything in
// it starts 'discovered' and activation always requires the user's choice.
// Extensibility is reviewed registration: a new entry joins the catalog as
// 'discovered' only after strict validation, never connected.
//
// Rules (all fail closed, pinned by tests):
//  1. Discovery is free-first: free/open-source and self-hostable or local
//     entries sort before free-tier cloud, and paid entries sort last with
//     their cost and limits visible in the same record.
//  2. connect() without userInitiated:true, exact declared scopes, and a
//     credential reference shaped like keychain:/vault:/credential-store:
//     is refused. Raw secret material is refused as an invalid reference.
//  3. Grants are exact and never widened: no wildcard scopes, no scope
//     inheritance, and a connected entry cannot gain scopes without an
//     explicit disconnect + reconnect.
//  4. authorizeCall(id, scope) is the only door for a call: allowed only
//     when connected and the exact scope was granted. Every scope class
//     except read_only additionally consumes a single-use per-scope
//     approval bound to that connector, made by an explicit user action.
//  5. Lifecycle: disconnect clears every grant and always works; reconnect
//     re-grants explicitly; revoke blocks reconnection until an explicit
//     readmit returns the entry to discovery (never auto-connecting it).
//  6. Audit entries are appended only for accepted state changes and carry
//     ids, actions and scope lists only; refusals never produce one and
//     credential references never appear in the audit.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionConnectors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const AUTO_CONNECT = false;
  const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
  const NAME_MAX = 80;
  const SCOPE_RE = /^[a-z][a-z0-9_.]{2,63}$/;
  const COST_RANK = Object.freeze({ free_open_source: 0, free_tier: 1, paid: 2 });
  const CREDENTIAL_RE = /^(keychain|vault|credential-store):[A-Za-z0-9._-]{1,120}$/;
  const SCOPE_CLASSES = Object.freeze({
    read_only: Object.freeze({ requiresApproval: false }),
    write: Object.freeze({ requiresApproval: true }),
    send: Object.freeze({ requiresApproval: true }),
    delete: Object.freeze({ requiresApproval: true }),
    external: Object.freeze({ requiresApproval: true }),
    sensitive: Object.freeze({ requiresApproval: true }),
  });
  const CLASS_NAMES = Object.freeze(Object.keys(SCOPE_CLASSES));
  const MAX_CONNECTIONS = 200;
  const MAX_AUDIT = 1000;
  const MAX_EXTRA = 400;

  // The shipped catalog. Discovery data only: every entry names what it
  // would cost and how it is limited BEFORE anyone can activate it, and the
  // hosting flags make local-first/self-hostable options easy to prefer.
  // Entries are frozen; the runtime additions list below is for reviewed
  // registration.
  const CATALOG = Object.freeze([
    { id: 'rss', name: 'RSS feeds', category: 'feeds', hosting: 'local', costModel: 'free_open_source', auth: 'none', costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] },
    { id: 'ollama', name: 'Ollama (local models)', category: 'ai_local', hosting: 'local', costModel: 'free_open_source', auth: 'local', costNote: 'Free, open-source; runs on your own machine', limits: 'Bound by local hardware and model sizes', scopes: [{ name: 'model.infer', class: 'read_only' }] },
    { id: 'matrix', name: 'Matrix', category: 'messaging', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'access_token', costNote: 'Free, open-source; self-host or use free homeservers', limits: 'Homeserver rate limits apply', scopes: [{ name: 'rooms.read', class: 'read_only' }, { name: 'message.send', class: 'send' }] },
    { id: 'mastodon', name: 'Mastodon', category: 'social', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'oauth2', costNote: 'Free, open-source; most instances are free', limits: 'Instance rate limits apply', scopes: [{ name: 'timeline.read', class: 'read_only' }, { name: 'post.write', class: 'write' }] },
    { id: 'nextcloud', name: 'Nextcloud', category: 'files', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'app_password', costNote: 'Free, open-source; self-hosted or free-tier providers', limits: 'Storage quota of the chosen server', scopes: [{ name: 'files.read', class: 'read_only' }, { name: 'files.write', class: 'write' }] },
    { id: 'jellyfin', name: 'Jellyfin', category: 'media', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'api_key', costNote: 'Free, open-source media server', limits: 'Bound by your own server', scopes: [{ name: 'library.read', class: 'read_only' }] },
    { id: 'grafana', name: 'Grafana', category: 'monitoring', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'api_key', costNote: 'Free open-source tier; cloud tiers are paid', limits: 'Self-hosted: your hardware; cloud: plan quotas', scopes: [{ name: 'dashboards.read', class: 'read_only' }, { name: 'dashboards.write', class: 'write' }, { name: 'alerting.delete', class: 'delete' }] },
    { id: 'miniflux', name: 'Miniflux', category: 'feeds', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'api_key', costNote: 'Free, open-source feed reader', limits: 'Bound by your own server', scopes: [{ name: 'entries.read', class: 'read_only' }] },
    { id: 'joplin', name: 'Joplin', category: 'notes', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'api_key', costNote: 'Free, open-source notes; sync target may cost', limits: 'Sync storage quota', scopes: [{ name: 'notes.read', class: 'read_only' }, { name: 'notes.write', class: 'write' }] },
    { id: 'home-assistant', name: 'Home Assistant', category: 'home', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'access_token', costNote: 'Free, open-source home automation', limits: 'Bound by your own hub', scopes: [{ name: 'state.read', class: 'read_only' }, { name: 'service.call', class: 'write' }] },
    { id: 'gitlab', name: 'GitLab', category: 'code', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'oauth2', costNote: 'Free, open-source; self-host or use the free tier', limits: 'Free tier rate limits per user', scopes: [{ name: 'projects.read', class: 'read_only' }, { name: 'projects.write', class: 'write' }] },
    { id: 'wikimedia', name: 'Wikimedia', category: 'reference', hosting: 'cloud', costModel: 'free_open_source', auth: 'none', costNote: 'Free; Wikimedia APIs are open', limits: 'Polite-use rate limits; a user agent is required', scopes: [{ name: 'search.read', class: 'read_only' }] },
    { id: 'internet-archive', name: 'Internet Archive', category: 'reference', hosting: 'cloud', costModel: 'free_open_source', auth: 'api_key', costNote: 'Free, non-profit archive', limits: 'Upload throttling applies', scopes: [{ name: 'metadata.read', class: 'read_only' }, { name: 'items.upload', class: 'write' }] },
    { id: 'openlibrary', name: 'Open Library', category: 'reference', hosting: 'cloud', costModel: 'free_open_source', auth: 'none', costNote: 'Free; Open Library is an open project', limits: 'Polite-use rate limits', scopes: [{ name: 'books.read', class: 'read_only' }] },
    { id: 'healthchecks-io', name: 'healthchecks.io', category: 'monitoring', hosting: 'self_hostable', costModel: 'free_open_source', auth: 'api_key', costNote: 'Free open-source; the hosted tier is free for 20 checks', limits: 'Hosted free tier: 20 checks', scopes: [{ name: 'checks.read', class: 'read_only' }, { name: 'pings.send', class: 'send' }] },
    { id: 'github', name: 'GitHub', category: 'code', hosting: 'cloud', costModel: 'free_tier', auth: 'oauth2', costNote: 'Free for public repos; paid plans for private features', limits: '5,000 REST requests per hour on the free tier', scopes: [{ name: 'repos.read', class: 'read_only' }, { name: 'issues.write', class: 'write' }] },
    { id: 'huggingface', name: 'Hugging Face', category: 'ai_cloud', hosting: 'cloud', costModel: 'free_tier', auth: 'access_token', costNote: 'Free tier; paid compute is optional', limits: 'Free tier API rate limits apply', scopes: [{ name: 'models.read', class: 'read_only' }, { name: 'datasets.upload', class: 'write' }] },
    { id: 'open-meteo', name: 'Open-Meteo', category: 'weather', hosting: 'cloud', costModel: 'free_tier', auth: 'none', costNote: 'Free for non-commercial use', limits: 'Free tier daily API call quota', scopes: [{ name: 'weather.read', class: 'read_only' }] },
    { id: 'openai', name: 'OpenAI', category: 'ai_cloud', hosting: 'cloud', costModel: 'paid', auth: 'api_key', costNote: 'Paid per token; the API has no free tier', limits: 'Model-dependent rate and token limits', scopes: [{ name: 'models.read', class: 'read_only' }, { name: 'completions.send', class: 'send' }] },
    { id: 'twilio', name: 'Twilio', category: 'messaging', hosting: 'cloud', costModel: 'paid', auth: 'api_key', costNote: 'Paid per message or minute; trial credit only', limits: 'Per-message and per-minute billing', scopes: [{ name: 'messages.send', class: 'send' }] },
  ]);

  function fail(reason) { return { ok: false, reason: reason }; }

  function createConnectorCatalog(opts) {
    const clock = opts && typeof opts.clock === 'function' ? opts.clock : function () { return 0; };
    const states = new Map(); // id -> 'discovered' | 'connected' | 'disconnected' | 'revoked'
    const grants = new Map(); // id -> array of granted scope names
    const approvals = new Map(); // approvalId -> { id, scope, ts }
    const additions = [];
    const auditLog = [];
    let approvalSeq = 0;

    function entry(id) {
      if (CATALOG.some(function (e) { return e.id === id; })) return CATALOG.find(function (e) { return e.id === id; });
      return additions.find(function (e) { return e.id === id; }) || null;
    }
    function declaredScope(e, name) {
      return (e.scopes || []).find(function (s) { return s.name === name; }) || null;
    }
    function pushAudit(action, id, scopes) {
      const e = { ts: clock(), action: action, id: id };
      if (scopes) e.scopes = scopes.slice();
      auditLog.push(e);
      if (auditLog.length > MAX_AUDIT) auditLog.splice(0, auditLog.length - MAX_AUDIT);
    }
    function validateConnectArgs(e, args) {
      if (!args || args.userInitiated !== true) return 'requires_user_action';
      if (!Array.isArray(args.scopes) || args.scopes.length === 0) return 'requires_explicit_scopes';
      for (const s of args.scopes) if (typeof s !== 'string' || !declaredScope(e, s)) return 'scope_not_declared';
      const ref = args.credentialRef;
      if (typeof ref !== 'string' || ref.length === 0) return 'credential_ref_required';
      if (!CREDENTIAL_RE.test(ref) || ref.length > 140) return 'credential_ref_invalid';
      return null;
    }
    function grantExact(id, e, args) {
      const unique = [];
      for (const s of args.scopes) if (unique.indexOf(s) === -1) unique.push(s);
      grants.set(id, unique);
      states.set(id, 'connected');
      return unique;
    }

    return {
      AUTO_CONNECT_MARKER: AUTO_CONNECT,
      SCOPE_CLASSES: SCOPE_CLASSES,
      connect: function (id, args) {
        const e = entry(id);
        if (!e) return fail('unknown_connector');
        const st = states.get(id) || 'discovered';
        if (st === 'connected') return fail('already_connected');
        if (st === 'disconnected') return fail('use_reconnect');
        if (st === 'revoked') return fail('revoked_requires_readmit');
        const bad = validateConnectArgs(e, args);
        if (bad) return fail(bad);
        if (grants.size >= MAX_CONNECTIONS) return fail('limit_reached');
        const scopes = grantExact(id, e, args);
        pushAudit('connect', id, scopes);
        return { ok: true, state: 'connected' };
      },
      disconnect: function (id, args) {
        const e = entry(id);
        if (!e) return fail('unknown_connector');
        if ((states.get(id) || 'discovered') !== 'connected') return fail('not_connected');
        if (!args || args.userInitiated !== true) return fail('requires_user_action');
        grants.delete(id);
        states.set(id, 'disconnected');
        pushAudit('disconnect', id, null);
        return { ok: true, state: 'disconnected' };
      },
      reconnect: function (id, args) {
        const e = entry(id);
        if (!e) return fail('unknown_connector');
        const st = states.get(id) || 'discovered';
        if (st === 'connected') return fail('already_connected');
        if (st === 'discovered') return fail('use_connect');
        if (st === 'revoked') return fail('revoked_requires_readmit');
        const bad = validateConnectArgs(e, args);
        if (bad) return fail(bad);
        if (grants.size >= MAX_CONNECTIONS) return fail('limit_reached');
        const scopes = grantExact(id, e, args);
        pushAudit('reconnect', id, scopes);
        return { ok: true, state: 'connected' };
      },
      revoke: function (id, args) {
        const e = entry(id);
        if (!e) return fail('unknown_connector');
        const st = states.get(id) || 'discovered';
        if (st !== 'connected' && st !== 'disconnected') return fail('not_connected');
        if (!args || args.userInitiated !== true) return fail('requires_user_action');
        grants.delete(id);
        for (const [aid, a] of Array.from(approvals)) if (a.id === id) approvals.delete(aid);
        states.set(id, 'revoked');
        pushAudit('revoke', id, null);
        return { ok: true, state: 'revoked' };
      },
      readmit: function (id, args) {
        const e = entry(id);
        if (!e) return fail('unknown_connector');
        if ((states.get(id) || 'discovered') !== 'revoked') return fail('not_revoked');
        if (!args || args.userInitiated !== true) return fail('requires_user_action');
        states.set(id, 'discovered');
        pushAudit('readmit', id, null);
        return { ok: true, state: 'discovered' };
      },
      approve: function (id, scopeName, args) {
        const e = entry(id);
        if (!e) return fail('unknown_connector');
        if (!args || args.userInitiated !== true) return fail('requires_user_action');
        const s = declaredScope(e, scopeName);
        if (!s) return fail('scope_not_declared');
        if (!SCOPE_CLASSES[s.class].requiresApproval) return fail('approval_not_needed');
        const st = states.get(id) || 'discovered';
        const granted = grants.get(id) || [];
        if (st !== 'connected' || granted.indexOf(scopeName) === -1) return fail('not_connected');
        approvalSeq += 1;
        const approvalId = 'apr-' + approvalSeq;
        approvals.set(approvalId, { id: id, scope: scopeName, ts: clock() });
        pushAudit('approve', id, [scopeName]);
        return { ok: true, approvalId: approvalId };
      },
      authorizeCall: function (id, scopeName, args) {
        const e = entry(id);
        if (!e) return { allowed: false, reason: 'unknown_connector' };
        if ((states.get(id) || 'discovered') !== 'connected') return { allowed: false, reason: 'not_connected' };
        const s = declaredScope(e, scopeName);
        if (!s || !grants.get(id) || grants.get(id).indexOf(scopeName) === -1) return { allowed: false, reason: 'scope_not_granted' };
        if (SCOPE_CLASSES[s.class].requiresApproval) {
          const aid = args && args.approvalId;
          const a = aid ? approvals.get(aid) : null;
          if (!a || a.id !== id || a.scope !== scopeName) return { allowed: false, reason: 'approval_required' };
          approvals.delete(aid); // single-use
        }
        return { allowed: true };
      },
      registerConnector: function (m) {
        if (!m || typeof m.id !== 'string' || !ID_RE.test(m.id)) return fail('id_invalid');
        if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > NAME_MAX) return fail('name_invalid');
        if (!COST_RANK[m.costModel]) return fail('cost_model_invalid');
        if (!Array.isArray(m.scopes) || m.scopes.length === 0) return fail('requires_explicit_scopes');
        for (const s of m.scopes) {
          if (!s || typeof s.name !== 'string' || !SCOPE_RE.test(s.name) || !SCOPE_CLASSES[s.class]) return fail('scope_invalid');
        }
        if (entry(m.id)) return fail('id_taken');
        if (additions.length >= MAX_EXTRA) return fail('limit_reached');
        const clean = Object.freeze({ id: m.id, name: m.name, category: m.category || 'other', hosting: m.hosting || 'cloud', selfHostable: m.hosting === 'self_hostable', localFirst: m.hosting === 'local', costModel: m.costModel, auth: m.auth || 'oauth2', costNote: m.costNote, limits: m.limits, scopes: Object.freeze(m.scopes.map(function (s) { return Object.freeze({ name: s.name, class: s.class }); })) });
        additions.push(clean);
        states.set(m.id, 'discovered');
        pushAudit('register', m.id, null);
        return { ok: true, state: 'discovered' };
      },
      list: function (filter) {
        const f = filter || {};
        let all = CATALOG.concat(additions).map(function (e) {
          return { id: e.id, name: e.name, category: e.category, hosting: e.hosting, selfHostable: e.hosting === 'self_hostable' || e.selfHostable === true, localFirst: e.hosting === 'local' || e.localFirst === true, costModel: e.costModel, auth: e.auth, costNote: e.costNote, limits: e.limits, scopes: e.scopes.map(function (s) { return { name: s.name, class: s.class }; }) };
        });
        if (f.hosting) all = all.filter(function (e) { return e.hosting === f.hosting; });
        if (f.selfHostable) all = all.filter(function (e) { return e.selfHostable; });
        if (f.costModel) all = all.filter(function (e) { return e.costModel === f.costModel; });
        all.sort(function (a, b) {
          const r = COST_RANK[a.costModel] - COST_RANK[b.costModel];
          if (r !== 0) return r;
          const la = (a.localFirst || a.selfHostable) ? 0 : 1;
          const lb = (b.localFirst || b.selfHostable) ? 0 : 1;
          if (la !== lb) return la - lb;
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
        return all;
      },
      describe: function (id) {
        const e = entry(id);
        if (!e) return null;
        return { id: e.id, name: e.name, category: e.category, hosting: e.hosting, selfHostable: e.hosting === 'self_hostable' || e.selfHostable === true, localFirst: e.hosting === 'local' || e.localFirst === true, costModel: e.costModel, auth: e.auth, costNote: e.costNote, limits: e.limits, classes: e.scopes.map(function (s) { return s.class; }), scopes: e.scopes.map(function (s) { return { name: s.name, class: s.class }; }) };
      },
      state: function (id) { return entry(id) ? (states.get(id) || 'discovered') : null; },
      // Persistence (27 Nov 2026 AI-access decision: a connection is
      // one-time and persistent until the user disconnects). snapshot()
      // exports states and exact granted scopes only, never credential
      // references; restore() validates strictly and fails closed: unknown
      // ids, undeclared or duplicate scopes, grants without a connected
      // state and connected states without grants are refused, not repaired.
      snapshot: function () {
        const out = { states: [], grants: [] };
        for (const [id, st] of states) if (st !== 'discovered') out.states.push({ id: id, state: st });
        for (const [id, sc] of grants) out.grants.push({ id: id, scopes: sc.slice() });
        return out;
      },
      restore: function (snap) {
        const problems = [];
        if (!snap || !Array.isArray(snap.states) || !Array.isArray(snap.grants)) return { ok: false, problems: ['bad_snapshot'] };
        if (snap.states.length > MAX_CONNECTIONS || snap.grants.length > MAX_CONNECTIONS) return { ok: false, problems: ['limit_reached'] };
        for (const s of snap.states) {
          if (!s || typeof s.id !== 'string' || !entry(s.id)) { problems.push('unknown_connector'); continue; }
          if (['connected', 'disconnected', 'revoked'].indexOf(s.state) === -1) { problems.push('bad_state'); continue; }
          states.set(s.id, s.state);
        }
        for (const g of snap.grants) {
          const e = g && typeof g.id === 'string' ? entry(g.id) : null;
          if (!e) { problems.push('unknown_connector'); continue; }
          if (!Array.isArray(g.scopes) || g.scopes.length === 0) { problems.push('bad_scopes'); continue; }
          const unique = [];
          let bad = false;
          for (const sc of g.scopes) {
            if (typeof sc !== 'string' || !declaredScope(e, sc) || unique.indexOf(sc) !== -1) { bad = true; break; }
            unique.push(sc);
          }
          if (bad) { problems.push('bad_scopes'); continue; }
          if ((states.get(g.id) || 'discovered') !== 'connected') { problems.push('not_connected'); continue; }
          grants.set(g.id, unique);
        }
        for (const [id, sc] of Array.from(grants)) {
          if ((states.get(id) || 'discovered') !== 'connected') { problems.push('grant_without_connection'); grants.delete(id); }
        }
        for (const [id, st] of Array.from(states)) {
          if (st === 'connected' && !grants.has(id)) { problems.push('connection_without_grants'); states.set(id, 'discovered'); }
        }
        for (const [id, st] of Array.from(states)) {
          if (st !== 'discovered') pushAudit('restore', id, grants.get(id) || null);
        }
        return { ok: problems.length === 0, problems: problems };
      },
      audit: function () { return auditLog.slice(); },
    };
  }

  return { createConnectorCatalog: createConnectorCatalog, AUTO_CONNECT: AUTO_CONNECT, COST_RANK: COST_RANK, SCOPE_CLASSES: SCOPE_CLASSES };
});
