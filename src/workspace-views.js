'use strict';

// M8 slice 3: the pure workspace-views groundwork. CompanionDesk's workspace
// surface (roadmap M8) is a set of fixed views; this module is the
// decision-independent part: the view catalog itself and a fail-closed
// record shaper a view can use to turn stored rows into bounded plain-text
// lines. Pure data shaping only: no DOM, no IPC, no DB, no timers, no
// network, and no require of any other app module.
//
// The catalog is the eleven views the roadmap names, fixed and complete:
// a view not in the catalog does not exist, and a view in the catalog whose
// record schema is not wired yet refuses to shape anything (fail closed,
// never a guess at someone else's record shape).
//
// Boundaries (all fail closed), mirroring schedules-view.js:
//   - Display cap: at most MAX_DISPLAY (10) records per call. A caller may
//     only lower the cap.
//   - Allowlisted fields only; a record carrying any other own enumerable
//     key, a symbol key, an accessor property, or an exotic prototype is
//     skipped, never displayed. Descriptors are inspected before any value
//     is read.
//   - Records are never mutated; the output is fresh plain strings.
//   - Malformed records are skipped and counted, never thrown on.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionWorkspaceViews = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_DISPLAY = 10;
  const MAX_TITLE = 200;
  const MAX_STAMP = 40;

  // The fixed catalog, in roadmap order. schema: null means the view exists
  // but its record schema is not wired yet; shaping refuses for it.
  const VIEWS = [
    { name: 'conversations', label: 'Conversations', wired: true },
    { name: 'tasks', label: 'Tasks', wired: false },
    { name: 'memory', label: 'Memory', wired: false },
    { name: 'tools', label: 'Tools', wired: false },
    { name: 'files', label: 'Files', wired: false },
    { name: 'workflows', label: 'Workflows', wired: false },
    { name: 'settings', label: 'Settings', wired: false },
    { name: 'permissions', label: 'Permissions', wired: false },
    { name: 'activity', label: 'Activity', wired: false },
    { name: 'models', label: 'Models', wired: false },
    { name: 'integrations', label: 'Integrations', wired: false },
  ];
  const NAMES = VIEWS.map(v => v.name);

  // The one wired schema: rows exactly as src/chat-history.listConversations
  // returns them (id, title, created_at, updated_at, message_count). Types
  // are checked per field; anything else fails the record.
  const SCHEMAS = {
    conversations: {
      fields: ['id', 'title', 'created_at', 'updated_at', 'message_count'],
      check(r) {
        if (!Number.isSafeInteger(r.id) || r.id < 1) return false;
        if (typeof r.title !== 'string' || r.title.length > MAX_TITLE) return false;
        if (typeof r.created_at !== 'string' || r.created_at.length === 0 || r.created_at.length > MAX_STAMP) return false;
        if (typeof r.updated_at !== 'string' || r.updated_at.length === 0 || r.updated_at.length > MAX_STAMP) return false;
        if (!Number.isSafeInteger(r.message_count) || r.message_count < 0) return false;
        return true;
      },
    },
  };

  function view(name) {
    return VIEWS.find(v => v.name === name) || null;
  }

  // One active view at a time; the workspace can only be on a catalog view.
  function resolve(requested) {
    if (typeof requested !== 'string') return { ok: false, reason: 'unknown_view' };
    const v = view(requested);
    if (!v) return { ok: false, reason: 'unknown_view' };
    return { ok: true, view: v.name, label: v.label, wired: v.wired };
  }

  // The catalog, fresh copies, in fixed order.
  function catalog() {
    return VIEWS.map(v => ({ name: v.name, label: v.label, wired: v.wired }));
  }

  function accept(r, schema) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return false;
    const proto = Object.getPrototypeOf(r);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(r).length > 0) return false;
    const keys = Object.keys(r);
    for (const k of keys) {
      if (!schema.fields.includes(k)) return false;
      const d = Object.getOwnPropertyDescriptor(r, k);
      if (!d || !('value' in d) || d.get || d.set) return false;
    }
    for (const k of schema.fields) {
      if (!Object.prototype.hasOwnProperty.call(r, k)) return false;
    }
    return schema.check(r);
  }

  // Shape one view's records into bounded plain lines. Returns
  // { ok, view, lines, shown, skipped, total } or { ok: false, reason }.
  function shape(name, records, cap) {
    const v = view(name);
    if (!v) return { ok: false, reason: 'unknown_view' };
    if (!v.wired || !SCHEMAS[name]) return { ok: false, reason: 'view_not_wired' };
    if (!Array.isArray(records)) return { ok: false, reason: 'bad_input' };
    let limit = MAX_DISPLAY;
    if (cap !== undefined) {
      if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_DISPLAY) return { ok: false, reason: 'bad_cap' };
      limit = cap;
    }
    const schema = SCHEMAS[name];
    const lines = [];
    let skipped = 0;
    for (const r of records) {
      if (!accept(r, schema)) { skipped += 1; continue; }
      if (lines.length >= limit) { skipped += 1; continue; }
      const msgs = r.message_count === 1 ? '1 message' : `${r.message_count} messages`;
      lines.push(`#${r.id} ${r.title} (${msgs}, updated ${r.updated_at})`);
    }
    return { ok: true, view: name, lines, shown: lines.length, skipped, total: records.length };
  }

  return { MAX_DISPLAY, catalog, resolve, shape };
});
