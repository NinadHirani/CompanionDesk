'use strict';

// M5 slice 2: the pure schedules shaper. Takes the records served by the
// user-facing schedules:list channel and returns bounded plain-text display
// lines plus per-record action ids for the panel. Pure data shaping only:
// no DOM, no IPC, no writes, no timers, no network. The panel renders the
// lines with textContent, so nothing here can become markup.
//
// Boundaries (all fail closed), mirroring agent-notifications-view.js:
//   - Display cap: at most MAX_DISPLAY (10) records per call; the list is
//     already sorted by due time. A caller may only lower the cap.
//   - Allowlisted fields only; a record carrying any other own enumerable
//     key, a symbol key, an accessor property, an array or an exotic
//     prototype is skipped, never displayed. Descriptors are inspected
//     before any value is read.
//   - Records are never mutated; the output is fresh plain strings.
//   - Malformed records are skipped and counted, never thrown on.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionSchedulesView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_DISPLAY = 10;
  const MAX_TITLE = 120;
  const SCOPES = ['reminder', 'deadline'];
  const ID_RE = /^sch-\d{6}$/;
  const ALLOWED = ['id', 'title', 'scope', 'dueAt', 'notes', 'createdAt', 'paused', 'cancelled', 'deferredTo', 'firedAt'];

  function accept(r) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
    const proto = Object.getPrototypeOf(r);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(r).length > 0) return null;
    const keys = Object.keys(r);
    for (const k of keys) {
      if (!ALLOWED.includes(k)) return null;
      const d = Object.getOwnPropertyDescriptor(r, k);
      if (!d || !('value' in d) || d.get || d.set) return null;
    }
    for (const k of ALLOWED) {
      if (!Object.prototype.hasOwnProperty.call(r, k)) return null;
    }
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
    if (typeof r.title !== 'string' || r.title.length === 0 || r.title.length > MAX_TITLE) return null;
    if (!SCOPES.includes(r.scope)) return null;
    if (!Number.isSafeInteger(r.dueAt)) return null;
    if (r.notes !== null && typeof r.notes !== 'string') return null;
    if (!Number.isSafeInteger(r.createdAt)) return null;
    if (typeof r.paused !== 'boolean' || typeof r.cancelled !== 'boolean') return null;
    if (r.deferredTo !== null && !Number.isSafeInteger(r.deferredTo)) return null;
    if (r.firedAt !== null && !Number.isSafeInteger(r.firedAt)) return null;
    return r;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // Local wall-clock rendering of an epoch-ms stamp; the panel shows what
  // the user's own clock will mean, never a UTC dump.
  function when(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function shape(records, opts) {
    const cap = opts && Number.isInteger(opts.max) && opts.max >= 0 && opts.max < MAX_DISPLAY ? opts.max : MAX_DISPLAY;
    const list = Array.isArray(records) ? records : [];
    const lines = [];
    const actions = [];
    let skipped = 0;
    for (const raw of list) {
      if (lines.length >= cap) break;
      const r = accept(raw);
      if (!r) { skipped += 1; continue; }
      let state = 'active';
      if (r.firedAt !== null) state = 'fired ' + when(r.firedAt);
      else if (r.cancelled) state = 'cancelled';
      else if (r.paused) state = 'paused';
      else if (r.deferredTo !== null) state = 'deferred until ' + when(r.deferredTo);
      lines.push(r.id + ' ' + r.scope + ': ' + r.title + ' — due ' + when(r.dueAt) + ' [' + state + ']');
      if (r.firedAt === null && !r.cancelled) {
        if (r.paused) actions.push({ id: r.id, kind: 'resume' });
        else actions.push({ id: r.id, kind: 'pause' });
        actions.push({ id: r.id, kind: 'cancel' });
      }
    }
    const hidden = Math.max(0, list.length - lines.length - skipped);
    return { ok: true, lines, actions, skipped, hidden };
  }

  return { shape, MAX_DISPLAY };
});
