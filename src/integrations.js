'use strict';

// M8 slice 1: the integrations registry. Pure: no fs, no network, no timers,
// no model, no real connectors. It defines the shape every third-party
// integration must have and the least-privilege rules around it, so that a
// later connector slice cannot quietly widen what an integration may do.
// Per the roadmap, connectors are chosen by Ninad and verified against
// official APIs BEFORE any capability claim, so this module ships empty and
// only test fixtures register manifests; nothing is ever connected on its
// own, and nothing here talks to the outside world.
//
// Rules (all fail closed, pinned by tests):
//  1. A manifest declares its id, name, version and the scopes it COULD
//     ask for. Every scope must exist in the built-in scope catalog; an
//     unknown scope, a wildcard, a forbidden-class scope request or an
//     empty scope list is refused at registration. Manifests are frozen
//     and an id is never re-registered (a new version is a new review).
//  2. Connecting is explicit: connect(id, { scopes }) grants ONLY a
//     non-empty subset of the manifest's declared scopes, and records the
//     consent moment. Nothing implicit is ever granted, and grants are
//     never widened after connect (a wider set means disconnect + a new
//     explicit connect).
//  3. Disconnect always works and clears every grant. Revoke is stronger:
//     a revoked integration keeps its manifest on file (for the audit
//     trail) but is marked refused and cannot reconnect until it is
//     explicitly re-admitted, and never silently.
//  4. authorizeCall(id, scope) is the only door: allowed only when the
//     integration is connected, not revoked, and this exact scope was
//     granted. No wildcard scope, no scope inheritance.
//  5. Every accepted state change returns one audit entry; refusals never
//     produce one. Entries carry only ids, actions and scope lists.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionIntegrations = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
  const NAME_MAX = 80;
  const VERSION_RE = /^\d+\.\d+\.\d+$/;
  const MANIFESTS_MAX = 100;

  // The least-privilege scope catalog. Each scope maps to exactly one
  // capability class from the Gate 2 vocabulary. A scope whose class is
  // 'forbidden' exists so a manifest ASKING for it can be named and
  // refused; it can never be granted. Adding a scope is a roadmap decision,
  // not a runtime one.
  const SCOPES = Object.freeze({
    'contacts.read': 'read_only',
    'calendar.read': 'read_only',
    'calendar.write': 'reversible_write',
    'files.read': 'read_only',
    'notes.write': 'reversible_write',
    'notifications.send': 'reversible_write',
    'clipboard.write': 'reversible_write',
    'network.fetch': 'sensitive',
    'screen.observe': 'sensitive',
    'audio.record': 'sensitive',
    'credentials.read': 'forbidden',
    'shell.exec': 'forbidden',
  });
  const GRANTABLE = Object.freeze(Object.keys(SCOPES).filter((s) => SCOPES[s] !== 'forbidden'));

  function validateManifest(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return 'bad_manifest';
    const keys = Object.keys(m);
    for (const k of keys) {
      if (!['id', 'name', 'version', 'scopes'].includes(k)) return 'unknown_field:' + k;
    }
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return 'bad_id';
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > NAME_MAX) return 'bad_name';
    if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) return 'bad_version';
    if (!Array.isArray(m.scopes) || m.scopes.length === 0) return 'no_scopes';
    for (const s of m.scopes) {
      if (typeof s !== 'string') return 'bad_scope';
      if (s === '*') return 'wildcard_refused';
      if (!Object.prototype.hasOwnProperty.call(SCOPES, s)) return 'unknown_scope:' + s;
      if (SCOPES[s] === 'forbidden') return 'forbidden_scope:' + s;
    }
    if (new Set(m.scopes).size !== m.scopes.length) return 'duplicate_scope';
    return null;
  }

  function createIntegrationRegistry({ clock } = {}) {
    const now = typeof clock === 'function' ? clock : () => Date.now();
    const manifests = new Map(); // id -> frozen manifest
    const state = new Map(); // id -> { connected, scopes[], consentedAt, revoked }

    function audit(action, id, extra) {
      return Object.freeze({ action, id, at: now(), ...(extra || {}) });
    }

    // -> { ok: true, manifest, audit } | { ok: false, reason }
    function register(manifest) {
      const problem = validateManifest(manifest);
      if (problem) return { ok: false, reason: problem };
      if (manifests.has(manifest.id)) return { ok: false, reason: 'id_already_registered' };
      if (manifests.size >= MANIFESTS_MAX) return { ok: false, reason: 'registry_full' };
      const frozen = Object.freeze({
        id: manifest.id,
        name: manifest.name.trim(),
        version: manifest.version,
        scopes: Object.freeze([...manifest.scopes]),
      });
      manifests.set(frozen.id, frozen);
      state.set(frozen.id, { connected: false, scopes: [], consentedAt: null, revoked: false });
      return { ok: true, manifest: frozen, audit: audit('integrations.registered', frozen.id, { version: frozen.version, declaredScopes: [...frozen.scopes] }) };
    }

    function check(id) {
      const m = manifests.get(id);
      const s = state.get(id);
      if (!m || !s) return { m: null, s: null };
      return { m, s };
    }

    // explicit consent required; scopes must be a subset of the manifest's
    function connect(id, { scopes, consentedAt } = {}) {
      const { m, s } = check(id);
      if (!m) return { ok: false, reason: 'unknown_integration' };
      if (s.revoked) return { ok: false, reason: 'revoked' };
      if (s.connected) return { ok: false, reason: 'already_connected' }; // a change of scopes is disconnect, then a new explicit connect
      if (!Array.isArray(scopes) || scopes.length === 0) return { ok: false, reason: 'no_scopes' };
      if (new Set(scopes).size !== scopes.length) return { ok: false, reason: 'duplicate_scope' };
      for (const sc of scopes) {
        if (!m.scopes.includes(sc)) return { ok: false, reason: 'scope_not_declared:' + sc };
        if (SCOPES[sc] === 'forbidden') return { ok: false, reason: 'forbidden_scope:' + sc };
      }
      s.connected = true;
      s.scopes = [...scopes];
      s.consentedAt = typeof consentedAt === 'number' ? consentedAt : now();
      return { ok: true, granted: [...scopes], audit: audit('integrations.connected', id, { scopes: [...scopes] }) };
    }

    function disconnect(id) {
      const { s } = check(id);
      if (!s) return { ok: false, reason: 'unknown_integration' };
      if (!s.connected && !s.revoked) return { ok: false, reason: 'not_connected' };
      const had = s.scopes.slice();
      s.connected = false;
      s.scopes = [];
      s.consentedAt = null;
      return { ok: true, audit: audit('integrations.disconnected', id, { clearedScopes: had }) };
    }

    function revoke(id) {
      const { s } = check(id);
      if (!s) return { ok: false, reason: 'unknown_integration' };
      const had = s.scopes.slice();
      s.revoked = true;
      s.connected = false;
      s.scopes = [];
      s.consentedAt = null;
      return { ok: true, audit: audit('integrations.revoked', id, { clearedScopes: had }) };
    }

    // Re-admission after a revoke is always explicit and never silent.
    function readmit(id) {
      const { s } = check(id);
      if (!s) return { ok: false, reason: 'unknown_integration' };
      if (!s.revoked) return { ok: false, reason: 'not_revoked' };
      s.revoked = false;
      return { ok: true, audit: audit('integrations.readmitted', id) };
    }

    function authorizeCall(id, scope) {
      const { m, s } = check(id);
      if (!m || !s) return { allowed: false, reason: 'unknown_integration' };
      if (s.revoked) return { allowed: false, reason: 'revoked' };
      if (!s.connected) return { allowed: false, reason: 'not_connected' };
      if (typeof scope !== 'string' || scope === '*') return { allowed: false, reason: 'bad_scope' };
      if (!s.scopes.includes(scope)) return { allowed: false, reason: 'scope_not_granted' };
      return { allowed: true, capability: SCOPES[scope] };
    }

    function list() {
      const out = [];
      for (const [id, m] of manifests) {
        const s = state.get(id);
        out.push(Object.freeze({ id, name: m.name, version: m.version, declaredScopes: [...m.scopes], connected: s.connected, revoked: s.revoked, grantedScopes: [...s.scopes], consentedAt: s.consentedAt }));
      }
      return out;
    }

    return Object.freeze({ register, connect, disconnect, revoke, readmit, authorizeCall, list });
  }

  return { createIntegrationRegistry, validateManifest, SCOPES, GRANTABLE };
});
