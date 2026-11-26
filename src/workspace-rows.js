'use strict';

// Workspace rows provider (Gate 3/8 wiring, approved by Ninad on 26 Nov
// 2026). The pure aggregator the workspace bridge uses: it turns each
// wired view's owning module rows into EXACTLY the records the
// workspace-views schema accepts, projecting away every extra key the
// owning record carries (an acknowledged flag, a persisted marker) so
// the fail-closed shaper never silently skips good rows. Fail-closed at
// every step: an unknown view, a view whose schema is not wired, a
// missing provider, a provider that throws and a provider that returns
// something other than an array each refuse with a reason instead of
// guessing. Pure data only: no DOM, no IPC, no DB, no timers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionWorkspaceRows = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function createWorkspaceRows(opts) {
    const providers = opts && typeof opts === 'object' ? opts : {};
    const views = require('./workspace-views.js');

    function rows(name) {
      if (typeof name !== 'string' || name.length === 0) return { ok: false, reason: 'bad_input' };
      const cat = views.catalog();
      const entry = cat.find((v) => v.name === name);
      if (!entry) return { ok: false, reason: 'unknown_view' };
      if (!entry.wired) return { ok: false, reason: 'view_not_wired' };
      const provider = providers[name];
      if (typeof provider !== 'function') return { ok: false, reason: 'provider_missing' };
      let raw;
      try {
        raw = provider();
      } catch {
        return { ok: false, reason: 'provider_failed' };
      }
      if (!Array.isArray(raw)) return { ok: false, reason: 'bad_provider_output' };
      const fields = views.fields(name);
      if (!fields) return { ok: false, reason: 'view_not_wired' };
      const out = [];
      for (const r of raw) {
        if (r === null || typeof r !== 'object' || Array.isArray(r)) continue;
        const projected = {};
        for (const f of fields) projected[f] = r[f];
        out.push(projected);
      }
      return { ok: true, view: name, rows: out };
    }

    return { rows };
  }

  return { createWorkspaceRows };
});
