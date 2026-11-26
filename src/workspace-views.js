'use strict';

// M8 slice 3 (groundwork) + the schemas-first slice (approved by Ninad on
// 26 Nov 2026): the pure workspace-views groundwork for CompanionDesk's
// workspace surface (roadmap M8). The view catalog itself and a
// fail-closed record shaper a view can use to turn stored rows into
// bounded plain-text lines. Pure data shaping only: no DOM, no IPC, no
// DB, no timers, no network, and no require of any other app module.
//
// The catalog is the eleven views the roadmap names, fixed and complete:
// a view not in the catalog does not exist, and a view in the catalog
// whose record schema is not wired yet refuses to shape anything (fail
// closed, never a guess at someone else's record shape).
//
// Six schemas are wired, each mirroring one owning module's rows exactly
// and none of them touching a closed file: conversations
// (chat-history.listConversations), tasks (agent-reminders), memory
// (memory-session.items, sensitive-flagged rows skipped until M4 defines
// the workspace treatment), tools (tool-registry.list), permissions
// (device-access.list), activity (audit-log entries), integrations
// (integrations.js list). Four stay unwired: files, workflows and models
// have no owning row store yet (no stable rows to mirror), and settings'
// owning module (settings.js) is in the m84 checkpoint-closed set, so its
// schema waits until Ninad reopens that module.
//
// Boundaries (all fail closed), mirroring schedules-view.js:
//   - Display cap: at most MAX_DISPLAY (10) records per call. A caller may
//     only lower the cap.
//   - Allowlisted fields only; a record carrying any other own enumerable
//     key, a symbol key, an accessor property, or an exotic prototype is
//     skipped, never displayed. Descriptors are inspected before any value
//     is read. A schema may name optional fields: absent is fine, present
//     must still pass the schema's checks.
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
    { name: 'tasks', label: 'Tasks', wired: true },
    { name: 'memory', label: 'Memory', wired: true },
    { name: 'tools', label: 'Tools', wired: true },
    { name: 'files', label: 'Files', wired: true },
    { name: 'databases', label: 'Databases', wired: true },
    { name: 'appdata', label: 'App data', wired: true },
    { name: 'workflows', label: 'Workflows', wired: true },
    { name: 'settings', label: 'Settings', wired: false },
    { name: 'permissions', label: 'Permissions', wired: true },
    { name: 'activity', label: 'Activity', wired: true },
    { name: 'models', label: 'Models', wired: true },
    { name: 'integrations', label: 'Integrations', wired: true },
  ];
  const NAMES = VIEWS.map(v => v.name);

  // Display helpers: clip an already-checked string to the title cap;
  // stamp a safe epoch millisecond as ISO (always 24 chars, within
  // MAX_STAMP).
  const clip = (s) => (s.length > MAX_TITLE ? s.slice(0, MAX_TITLE) : s);
  const stamp = (ms) => new Date(ms).toISOString();
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

  const SCHEMAS = {
    // Rows exactly as src/chat-history.listConversations returns them
    // (id, title, created_at, updated_at, message_count). Types are
    // checked per field; anything else fails the record.
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
      line(r) {
        const msgs = r.message_count === 1 ? '1 message' : `${r.message_count} messages`;
        return `#${r.id} ${r.title} (${msgs}, updated ${r.updated_at})`;
      },
    },

    // agent-reminders rows exactly: { id 'rem-NNNNNN', title (<=120),
    // dueAt (safe integer epoch ms), notes (string <=500 or null),
    // createdAt (safe integer), cancelled (boolean) }.
    tasks: {
      fields: ['id', 'title', 'dueAt', 'notes', 'createdAt', 'cancelled'],
      check(r) {
        if (typeof r.id !== 'string' || !/^rem-\d{6}$/.test(r.id)) return false;
        if (typeof r.title !== 'string' || r.title.length === 0 || r.title.length > 120) return false;
        if (!Number.isSafeInteger(r.dueAt) || r.dueAt <= 0) return false;
        if (r.notes !== null && (typeof r.notes !== 'string' || r.notes.length > 500)) return false;
        if (!Number.isSafeInteger(r.createdAt) || r.createdAt <= 0) return false;
        if (typeof r.cancelled !== 'boolean') return false;
        return true;
      },
      line(r) {
        return `#${r.id} ${clip(r.title)} (due ${stamp(r.dueAt)}, ${r.cancelled ? 'cancelled' : 'active'})`;
      },
    },

    // memory-session.items() rows exactly: { id 'm<N>', section, text
    // (<=200, memory.js MAX_BULLET) }. A row carrying the session-only
    // `sensitive` flag carries a field outside this schema, so it is
    // skipped and counted (fail closed) until M4 defines the workspace
    // treatment of sensitive marks.
    memory: {
      fields: ['id', 'section', 'text'],
      check(r) {
        if (typeof r.id !== 'string' || !/^m\d+$/.test(r.id)) return false;
        if (typeof r.section !== 'string' || r.section.length === 0 || r.section.length > MAX_TITLE) return false;
        if (typeof r.text !== 'string' || r.text.length === 0 || r.text.length > MAX_TITLE) return false;
        return true;
      },
      line(r) { return `#${r.id} ${clip(r.section)}: ${clip(r.text)}`; },
    },

    // tool-registry.list() definitions exactly: { name (<=64),
    // description (<=400, LIMITS.description), capability (string),
    // schema (plain object), critical (optional boolean) }.
    tools: {
      fields: ['name', 'description', 'capability', 'schema'],
      optional: ['critical'],
      check(r) {
        if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 64) return false;
        if (typeof r.description !== 'string' || r.description.length === 0 || r.description.length > 400) return false;
        if (typeof r.capability !== 'string' || r.capability.length === 0 || r.capability.length > MAX_TITLE) return false;
        if (r.schema === null || typeof r.schema !== 'object' || Array.isArray(r.schema)) return false;
        const sproto = Object.getPrototypeOf(r.schema);
        if (sproto !== Object.prototype && sproto !== null) return false;
        if (r.critical !== undefined && typeof r.critical !== 'boolean') return false;
        return true;
      },
      line(r) { return `${r.name} (${r.capability}${r.critical ? ', critical' : ''})`; },
    },

    // device-access.list() grant rows exactly: { appId, capability,
    // scopes (non-empty string[]), grantedAt (safe integer epoch ms) }.
    permissions: {
      fields: ['appId', 'capability', 'scopes', 'grantedAt'],
      check(r) {
        if (typeof r.appId !== 'string' || r.appId.length === 0 || r.appId.length > MAX_TITLE) return false;
        if (typeof r.capability !== 'string' || r.capability.length === 0 || r.capability.length > MAX_TITLE) return false;
        if (!Array.isArray(r.scopes) || r.scopes.length === 0) return false;
        for (const s of r.scopes) {
          if (typeof s !== 'string' || s.length === 0 || s.length > MAX_TITLE) return false;
        }
        if (!Number.isSafeInteger(r.grantedAt) || r.grantedAt <= 0) return false;
        return true;
      },
      line(r) {
        return `${r.appId}: ${r.capability} (${r.scopes.length} scope${r.scopes.length === 1 ? '' : 's'})`;
      },
    },

    // Audit-log entries exactly as audit.js append() stores them:
    // { at, actor, action } plus the append-allowlisted extras (tool,
    // decision, reason, grantId, approvalId, detail) and the chain
    // fields (seq, hash; hash bounded 128, a hex digest is 64). An
    // entry carrying any other payload key is skipped and counted:
    // fail closed, never a guess at a future producer's shape.
    activity: {
      fields: ['at', 'actor', 'action'],
      optional: ['tool', 'decision', 'reason', 'grantId', 'approvalId', 'detail', 'seq', 'hash'],
      check(r) {
        if (typeof r.at !== 'string' || !ISO_RE.test(r.at)) return false;
        if (typeof r.actor !== 'string' || !['user', 'agent', 'system'].includes(r.actor)) return false;
        if (typeof r.action !== 'string' || !/^[a-z][a-z0-9_.]{0,47}$/.test(r.action)) return false;
        for (const k of ['tool', 'decision', 'reason', 'grantId', 'approvalId']) {
          if (r[k] !== undefined && (typeof r[k] !== 'string' || r[k].length === 0 || r[k].length > MAX_TITLE)) return false;
        }
        if (r.detail !== undefined) {
          if (r.detail === null || typeof r.detail !== 'object' || Array.isArray(r.detail)) return false;
          const dproto = Object.getPrototypeOf(r.detail);
          if (dproto !== Object.prototype && dproto !== null) return false;
        }
        if (r.seq !== undefined && (!Number.isSafeInteger(r.seq) || r.seq < 0)) return false;
        if (r.hash !== undefined && (typeof r.hash !== 'string' || r.hash.length === 0 || r.hash.length > 128)) return false;
        return true;
      },
      line(r) { return `${r.actor} ${r.action}${r.decision ? ' ' + r.decision : ''}`; },
    },

    // integrations.js list() rows exactly: { id, name (<=80), version
    // (semver), declaredScopes (string[]), connected, revoked,
    // grantedScopes (string[]), consentedAt (safe integer or null) }.
    integrations: {
      fields: ['id', 'name', 'version', 'declaredScopes', 'connected', 'revoked', 'grantedScopes', 'consentedAt'],
      check(r) {
        if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > MAX_TITLE) return false;
        if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 80) return false;
        if (typeof r.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(r.version)) return false;
        for (const k of ['declaredScopes', 'grantedScopes']) {
          if (!Array.isArray(r[k])) return false;
          for (const s of r[k]) {
            if (typeof s !== 'string' || s.length === 0 || s.length > MAX_TITLE) return false;
          }
        }
        if (typeof r.connected !== 'boolean' || typeof r.revoked !== 'boolean') return false;
        if (r.consentedAt !== null && (!Number.isSafeInteger(r.consentedAt) || r.consentedAt <= 0)) return false;
        return true;
      },
      line(r) {
        const state = r.revoked ? 'revoked' : r.connected ? 'connected' : 'registered';
        return `${r.id} ${clip(r.name)} ${r.version} (${state})`;
      },
    },

    // Gate 8 row stores (approved 26 Nov 2026; renderer wiring landed
    // 27 Nov 2026, Ninad-approved): files/folders, local databases,
    // structured app data, workflow/task data, model/AI views. These
    // schemas shape the five row stores main keeps; the stores start
    // EMPTY and fill only through explicit app actions (no auto-scan, no
    // auto-exposure, no model downloads, no persistence).
    files: {
      fields: ['id', 'name', 'path', 'kind', 'size', 'modifiedAt', 'source'],
      check(r) {
        if (typeof r.id !== 'string' || !/^f\d+$/.test(r.id)) return false;
        if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > MAX_TITLE) return false;
        if (typeof r.path !== 'string' || r.path.length === 0 || r.path.length > MAX_TITLE) return false;
        if (r.kind !== 'file' && r.kind !== 'folder') return false;
        if (!Number.isSafeInteger(r.size) || r.size < 0) return false;
        if (!Number.isSafeInteger(r.modifiedAt) || r.modifiedAt <= 0) return false;
        if (r.source !== 'app_data' && r.source !== 'user_picked') return false;
        return true;
      },
      line(r) { return `${r.id} ${clip(r.name)} (${r.kind}, ${r.size}B) ${clip(r.path)}`; },
    },

    // Gate 8 A continuation (26 Nov 2026 night): local databases and
    // structured app data, the two remaining approved store categories.
    // Same contract: rows arrive only through explicit app actions; the
    // stores start EMPTY and expose nothing on their own. These adapters
    // are shaped like files/workflows/models and wire into the renderer
    // in a later wiring lane, never by auto-exposure.
    databases: {
      fields: ['id', 'name', 'kind', 'state', 'updatedAt', 'detail'],
      check(r) {
        if (typeof r.id !== 'string' || !/^db\d+$/.test(r.id)) return false;
        if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > MAX_TITLE) return false;
        if (['sqlite', 'json', 'other'].indexOf(r.kind) === -1) return false;
        if (['available', 'configured', 'unavailable'].indexOf(r.state) === -1) return false;
        if (!Number.isSafeInteger(r.updatedAt) || r.updatedAt <= 0) return false;
        if (typeof r.detail !== 'string' || r.detail.length > MAX_TITLE) return false;
        return true;
      },
      line(r) { return `${r.id} ${clip(r.name)} (${r.kind}, ${r.state}) ${clip(r.detail)}`; },
    },

    appdata: {
      fields: ['id', 'name', 'kind', 'state', 'updatedAt', 'detail'],
      check(r) {
        if (typeof r.id !== 'string' || !/^ad\d+$/.test(r.id)) return false;
        if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > MAX_TITLE) return false;
        if (['kv', 'document', 'other'].indexOf(r.kind) === -1) return false;
        if (['active', 'archived'].indexOf(r.state) === -1) return false;
        if (!Number.isSafeInteger(r.updatedAt) || r.updatedAt <= 0) return false;
        if (typeof r.detail !== 'string' || r.detail.length > MAX_TITLE) return false;
        return true;
      },
      line(r) { return `${r.id} ${clip(r.name)} (${r.kind}, ${r.state}) ${clip(r.detail)}`; },
    },

    workflows: {
      fields: ['id', 'name', 'kind', 'state', 'updatedAt', 'detail'],
      check(r) {
        if (typeof r.id !== 'string' || !/^w\d+$/.test(r.id)) return false;
        if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > MAX_TITLE) return false;
        if (r.kind !== 'workflow' && r.kind !== 'task') return false;
        if (['draft', 'active', 'paused', 'done'].indexOf(r.state) === -1) return false;
        if (!Number.isSafeInteger(r.updatedAt) || r.updatedAt <= 0) return false;
        if (typeof r.detail !== 'string' || r.detail.length > MAX_TITLE) return false;
        return true;
      },
      line(r) { return `${r.id} ${clip(r.name)} (${r.kind}, ${r.state}) ${clip(r.detail)}`; },
    },

    models: {
      fields: ['id', 'name', 'kind', 'source', 'status', 'notes'],
      check(r) {
        if (typeof r.id !== 'string' || !/^md\d+$/.test(r.id)) return false;
        if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > MAX_TITLE) return false;
        if (['llm', 'stt', 'tts', 'embedding'].indexOf(r.kind) === -1) return false;
        if (r.source !== 'local' && r.source !== 'cloud') return false;
        if (['available', 'configured', 'unavailable'].indexOf(r.status) === -1) return false;
        if (typeof r.notes !== 'string' || r.notes.length > MAX_TITLE) return false;
        return true;
      },
      line(r) { return `${r.id} ${clip(r.name)} (${r.kind}, ${r.source}, ${r.status})`; },
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
    const optional = schema.optional || [];
    const keys = Object.keys(r);
    for (const k of keys) {
      if (!schema.fields.includes(k) && !optional.includes(k)) return false;
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
      lines.push(schema.line(r));
    }
    return { ok: true, view: name, lines, shown: lines.length, skipped, total: records.length };
  }

  // Field list of a wired view's schema (for providers that must project
  // owning rows to exactly what the schema accepts); null when unwired.
  function fields(name) {
    const schema = SCHEMAS[name];
    return schema ? schema.fields.slice() : null;
  }

  return { MAX_DISPLAY, catalog, resolve, shape, fields };
});
