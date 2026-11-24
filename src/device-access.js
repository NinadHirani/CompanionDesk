'use strict';

// M8 slice 2: the Device Access Centre policy core, per Ninad's requirement
// that CompanionDesk offer broad device/app access WITHOUT ever holding
// "access to everything". Pure: no fs, no network, no OS calls, no real
// permission requests. It is the app-side policy layer under the OS's own
// permission system, which is and stays the real boundary: nothing here
// can bypass a sandbox, a TCC prompt, or an Android runtime permission,
// and nothing here claims unrestricted access, which is impossible on
// normal operating systems.
//
// Rules (fail closed, pinned by tests):
//  1. Capabilities come from a fixed catalog. Each capability declares the
//     platforms it exists on, the OS permission it needs there, and its
//     class: read_only capabilities still need an explicit per-app grant;
//     write/send/delete/purchase classes additionally need a one-time
//     approval bound to the specific action (mirroring Gate 2 approvals).
//  2. Nothing is granted by default. A grant covers exactly one
//     capability for exactly one requesting integration id, with a
//     least-privilege scope inside it. No wildcards, no bulk grants.
//  3. An OS permission may be requested only as part of an explicit user
//     action on a capability about to be used - never at startup, never
//     preemptively, never in bulk.
//  4. Revocation is immediate and per app; the audit log records grants,
//     revocations and approvals with ids and scopes only.
//  5. UNRESTRICTED_DEVICE_ACCESS is a constant false: the architecture
//     states in code that total access is not a thing the app can have.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionDeviceAccess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const UNRESTRICTED_DEVICE_ACCESS = false;
  const MAX_APPS = 200;

  // The catalog. osPermission is what the OPERATING SYSTEM will ask for;
  // the app can only surface that ask at the right moment. ui_automation
  // is desktop-only wherever the OS permits it at all, and always behind
  // an explicit enable. Classes reuse the Gate 2 vocabulary.
  const CATALOG = Object.freeze({
    microphone: { platforms: ['darwin', 'win32', 'linux', 'android'], osPermission: 'microphone', class: 'sensitive', indicator: 'visible_while_active' },
    screen_capture: { platforms: ['darwin', 'win32', 'linux', 'android'], osPermission: 'screen_recording', class: 'sensitive', indicator: 'visible_while_active' },
    ui_automation: { platforms: ['darwin', 'win32', 'linux'], osPermission: 'accessibility', class: 'sensitive', indicator: 'visible_while_active', explicitEnable: true },
    files_read: { platforms: ['darwin', 'win32', 'linux', 'android'], osPermission: 'scoped_file_picker', class: 'read_only', indicator: 'none' },
    files_write: { platforms: ['darwin', 'win32', 'linux', 'android'], osPermission: 'scoped_file_picker', class: 'reversible_write', indicator: 'none' },
    contacts_read: { platforms: ['darwin', 'android'], osPermission: 'contacts', class: 'read_only', indicator: 'none' },
    notifications_send: { platforms: ['darwin', 'win32', 'linux', 'android'], osPermission: 'notifications', class: 'reversible_write', indicator: 'none' },
    location_read: { platforms: ['win32', 'linux', 'android'], osPermission: 'location', class: 'read_only', indicator: 'none' },
    calendar_read: { platforms: ['darwin', 'win32', 'linux', 'android'], osPermission: 'calendar', class: 'read_only', indicator: 'none' },
    calendar_write: { platforms: ['darwin', 'win32', 'linux', 'android'], osPermission: 'calendar', class: 'reversible_write', indicator: 'none' },
    purchase: { platforms: ['darwin', 'win32', 'linux', 'android'], osPermission: null, class: 'sensitive', indicator: 'none' },
  });
  const APPROVAL_CLASSES = ['sensitive', 'reversible_write'];

  function supports(cap, platform) {
    const def = CATALOG[cap];
    return !!def && def.platforms.includes(platform);
  }

  function createDeviceAccessCentre({ clock, platform } = {}) {
    const t = typeof clock === 'function' ? clock : () => Date.now();
    if (typeof platform !== 'string' || !platform) throw new TypeError('device access centre needs a platform');
    const grants = new Map(); // appId -> Map(capability -> { scopes[], grantedAt })
    const audit = [];
    const enabled = new Set(); // capabilities the user explicitly enabled (ui_automation needs this)

    function auditEntry(action, appId, cap, extra) {
      audit.push(Object.freeze({ action, appId, capability: cap, at: t(), ...(extra || {}) }));
    }

    function list() {
      const out = [];
      for (const [appId, caps] of grants) {
        for (const [cap, g] of caps) out.push(Object.freeze({ appId, capability: cap, scopes: [...g.scopes], grantedAt: g.grantedAt }));
      }
      return out;
    }
    function listAudit() { return audit.map((a) => a); }

    // Explicit opt-in for a capability (ui_automation requires it; others
    // may also be gated this way). Returns the OS permission that will be
    // needed, but requests nothing.
    function enable(cap, { userInitiated } = {}) {
      if (!CATALOG[cap]) return { ok: false, reason: 'unknown_capability' };
      if (!supports(cap, platform)) return { ok: false, reason: 'unsupported_platform' };
      if (userInitiated !== true) return { ok: false, reason: 'requires_user_action' };
      const def = CATALOG[cap];
      if (def.explicitEnable && !enabled.has(cap)) {
        enabled.add(cap);
        auditEntry('device_access.enabled', null, cap, { osPermission: def.osPermission });
      }
      return { ok: true, osPermission: def.osPermission, class: def.class };
    }

    // A grant covers one capability for one app id with explicit scopes.
    function grant(appId, cap, { scopes = [], userInitiated } = {}) {
      if (!CATALOG[cap]) return { ok: false, reason: 'unknown_capability' };
      if (typeof appId !== 'string' || !appId.trim() || appId === '*') return { ok: false, reason: 'bad_app_id' };
      if (!supports(cap, platform)) return { ok: false, reason: 'unsupported_platform' };
      if (userInitiated !== true) return { ok: false, reason: 'requires_user_action' };
      const def = CATALOG[cap];
      if (def.explicitEnable && !enabled.has(cap)) return { ok: false, reason: 'capability_not_enabled' };
      if (!Array.isArray(scopes) || scopes.length === 0) return { ok: false, reason: 'no_scopes' };
      if (new Set(scopes).size !== scopes.length) return { ok: false, reason: 'duplicate_scope' };
      if (grants.size >= MAX_APPS) return { ok: false, reason: 'too_many_apps' };
      if (!grants.has(appId)) grants.set(appId, new Map());
      const caps = grants.get(appId);
      if (!caps.has(cap)) caps.set(cap, { scopes: [], grantedAt: t() });
      const g = caps.get(cap);
      for (const s of scopes) {
        if (!g.scopes.includes(s)) g.scopes.push(s);
      }
      auditEntry('device_access.granted', appId, cap, { scopes: [...g.scopes] });
      return { ok: true, osPermission: def.osPermission, class: def.class };
    }

    function revoke(appId, cap) {
      const caps = grants.get(appId);
      if (!caps || !caps.has(cap)) return { ok: false, reason: 'not_granted' };
      const g = caps.get(cap);
      caps.delete(cap);
      if (!caps.size) grants.delete(appId);
      auditEntry('device_access.revoked', appId, cap, { clearedScopes: [...g.scopes] });
      return { ok: true };
    }

    function revokeApp(appId) {
      const caps = grants.get(appId);
      if (!caps) return { ok: false, reason: 'not_granted' };
      for (const cap of [...caps.keys()]) revoke(appId, cap);
      return { ok: true };
    }

    // The only door to a capability. Write-ish classes additionally
    // require a fresh approval digest for the exact action (the caller
    // supplies it; the Gate 2 approval desk mints those).
    function authorize(appId, cap, { scope, approvalDigest } = {}) {
      const caps = grants.get(appId);
      const g = caps && caps.get(cap);
      if (!g) return { allowed: false, reason: 'not_granted' };
      if (typeof scope !== 'string' || scope === '*') return { allowed: false, reason: 'bad_scope' };
      if (!g.scopes.includes(scope)) return { allowed: false, reason: 'scope_not_granted' };
      const def = CATALOG[cap];
      if (APPROVAL_CLASSES.includes(def.class) && typeof approvalDigest !== 'string') {
        return { allowed: false, reason: 'approval_required' };
      }
      return { allowed: true, class: def.class, indicator: def.indicator };
    }

    // An OS permission request is allowed only here, only for an enabled
    // capability, only because the user is about to use it.
    function osPermissionRequest(cap, { userInitiated } = {}) {
      const def = CATALOG[cap];
      if (!def || !supports(cap, platform)) return { ok: false, reason: 'unsupported' };
      if (userInitiated !== true) return { ok: false, reason: 'permission_requires_user_action' };
      if (def.explicitEnable && !enabled.has(cap)) return { ok: false, reason: 'capability_not_enabled' };
      auditEntry('device_access.os_permission_request', null, cap, { osPermission: def.osPermission });
      return { ok: true, osPermission: def.osPermission };
    }

    return Object.freeze({ enable, grant, revoke, revokeApp, authorize, osPermissionRequest, list, listAudit, platform: () => platform });
  }

  return { createDeviceAccessCentre, CATALOG, supports, APPROVAL_CLASSES, UNRESTRICTED_DEVICE_ACCESS };
});
