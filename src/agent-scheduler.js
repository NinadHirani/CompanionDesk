'use strict';

// M5 slice 1: the proactive scheduler. A pure, bounded, in-memory book of
// SCHEDULE records the USER set through the product surface (schedules:*
// IPC channels), persisted through the agent persistence layer's durable
// audit guarantees. This module creates, lists, pauses, cancels and
// evaluates records only. It never wakes anything on its own, holds no
// timers, and never contacts anything: a tick(at) is a pure evaluation the
// main-process wiring calls on its own clock, and DELIVERY (the OS
// notification) is the wiring layer's job behind the user's explicit
// opt-in settings. No network, no cloud, no sensitive storage.
//
// Roadmap rules encoded here, not left to callers:
//   - "Proactive actions run only on schedules the user set": this module
//     is the only creator of schedules and its only caller is the
//     user-facing product surface. The agent registry never receives it
//     and no agent tool can create, pause or fire a schedule (wiring-lock
//     test pins this).
//   - "Quiet hours": a due schedule inside the user's quiet window is
//     DEFERRED to the window's end, never dropped and never fired early.
//   - Exactly-once firing: a due schedule is marked fired at tick time and
//     is never re-fired. A failed delivery is audited by the caller, never
//     retried by re-ticking, so a broken notifier can never spam the user.
//
// Fail-closed validation: typed fields, length caps, a safe-integer epoch
// ms dueAt in the future, and a bounded book that refuses to grow past its
// cap rather than silently evicting records.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentScheduler = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const strictRecords = (typeof require === 'function')
    ? require('./strict-record').plainRecords
    : root.CompanionStrictRecord.plainRecords;

  const MAX_TITLE = 120;
  const MAX_NOTES = 500;
  const MAX_SCHEDULES = 100;
  const MAX_ID = 16;
  const SCOPES = ['reminder', 'deadline'];

  // ---- Quiet hours (pure helpers, exported for tests and the wiring) ----

  // Accepts { enabled, start, end } with 'HH:MM' strings. Returns
  // { enabled, startMin, endMin } or null when the config is invalid or
  // disabled. An invalid config disables quiet hours: the settings layer
  // refuses invalid values, so this path is defensive only.
  function parseQuietHours(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    if (cfg.enabled !== true) return null;
    const re = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
    if (typeof cfg.start !== 'string' || !re.test(cfg.start)) return null;
    if (typeof cfg.end !== 'string' || !re.test(cfg.end)) return null;
    const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    return { enabled: true, startMin: toMin(cfg.start), endMin: toMin(cfg.end) };
  }

  function minutesOfDay(atMs) {
    const d = new Date(atMs);
    return d.getHours() * 60 + d.getMinutes();
  }

  // Is `atMs` inside the quiet window? A start equal to end is an empty
  // window (never quiet). A start after end wraps midnight (22:00-08:00).
  function inQuiet(atMs, qh) {
    if (!qh) return false;
    const m = minutesOfDay(atMs);
    if (qh.startMin === qh.endMin) return false;
    if (qh.startMin < qh.endMin) return m >= qh.startMin && m < qh.endMin;
    return m >= qh.startMin || m < qh.endMin;
  }

  // The next moment the quiet window ends, at or after `atMs`. Local
  // clock time of the machine, matching minutesOfDay.
  function nextQuietEnd(atMs, qh) {
    if (!qh) return atMs;
    const d = new Date(atMs);
    let end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, qh.endMin, 0, 0);
    if (end.getTime() <= atMs) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    // Same-day windows that have already passed today end tomorrow.
    if (qh.startMin < qh.endMin) {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, qh.startMin, 0, 0);
      if (start.getTime() > atMs) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }
    return end.getTime();
  }

  function createScheduleBook({ clock } = {}) {
    const now = clock || (() => Date.now());
    const book = new Map(); // id -> record
    const scopePaused = new Set(); // scopes the user paused wholesale
    let seq = 0;

    function validScope(s) { return SCOPES.includes(s); }
    function get(id) {
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) return null;
      return book.get(id) || null;
    }

    return {
      // Create one schedule record. The ONLY creation path, and it is
      // reachable only from the user-facing product surface: the roadmap
      // rule "proactive actions run only on schedules the user set" lives
      // here as a structural fact, not a caller promise.
      create({ title, scope, dueAt, notes } = {}) {
        if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE) return { ok: false, reason: 'title_invalid' };
        if (!validScope(scope)) return { ok: false, reason: 'scope_invalid' };
        if (!Number.isSafeInteger(dueAt)) return { ok: false, reason: 'due_at_invalid' };
        if (dueAt <= now()) return { ok: false, reason: 'due_at_past' };
        if (book.size >= MAX_SCHEDULES) return { ok: false, reason: 'book_full' };
        if (notes !== undefined && (typeof notes !== 'string' || notes.length > MAX_NOTES)) return { ok: false, reason: 'notes_invalid' };
        seq += 1;
        const rec = {
          id: 'sch-' + String(seq).padStart(6, '0'),
          title,
          scope,
          dueAt,
          notes: notes || null,
          createdAt: now(),
          paused: false,
          cancelled: false,
          deferredTo: null,
          firedAt: null,
        };
        book.set(rec.id, rec);
        return { ok: true, schedule: { ...rec } };
      },

      // Edit the title and/or due time of an ACTIVE schedule. The scope is
      // immutable here (a scope change is a different commitment; cancel and
      // recreate it), and a fired, cancelled or unknown schedule is refused.
      update({ id, title, dueAt } = {}) {
        const rec = get(id);
        if (!rec) return { ok: false, reason: 'schedule_unknown' };
        if (rec.cancelled) return { ok: false, reason: 'schedule_cancelled' };
        if (rec.firedAt !== null) return { ok: false, reason: 'already_fired' };
        if (title !== undefined) {
          if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE) return { ok: false, reason: 'title_invalid' };
        }
        if (dueAt !== undefined) {
          if (!Number.isSafeInteger(dueAt)) return { ok: false, reason: 'due_at_invalid' };
          if (dueAt <= now()) return { ok: false, reason: 'due_at_past' };
        }
        if (title === undefined && dueAt === undefined) return { ok: false, reason: 'nothing_to_update' };
        if (title !== undefined) rec.title = title;
        if (dueAt !== undefined) rec.dueAt = dueAt;
        return { ok: true, schedule: { ...rec } };
      },

      // A copy of the book sorted by due time, soonest first.
      list() {
        return [...book.values()]
          .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
          .map((r) => ({ ...r }));
      },

      count() { return book.size; },

      pause(id) {
        const rec = get(id);
        if (!rec) return { ok: false, reason: 'schedule_unknown' };
        if (rec.cancelled) return { ok: false, reason: 'schedule_cancelled' };
        rec.paused = true;
        return { ok: true, schedule: { ...rec } };
      },

      resume(id) {
        const rec = get(id);
        if (!rec) return { ok: false, reason: 'schedule_unknown' };
        if (rec.cancelled) return { ok: false, reason: 'schedule_cancelled' };
        if (rec.firedAt !== null) return { ok: false, reason: 'already_fired' };
        rec.paused = false;
        return { ok: true, schedule: { ...rec } };
      },

      cancel(id) {
        const rec = get(id);
        if (!rec) return { ok: false, reason: 'schedule_unknown' };
        rec.cancelled = true;
        return { ok: true, schedule: { ...rec } };
      },

      remove(id) {
        const rec = get(id);
        if (!rec) return { ok: false, reason: 'schedule_unknown' };
        book.delete(id);
        return { ok: true, removed: { ...rec } };
      },

      // Per-scope controls (roadmap: "per-scope user controls"). A scope
      // pause is book state, not a per-record flag, so a schedule created
      // INTO a paused scope stays quiet even when the scope had no other
      // records, and resuming a scope never disturbs an individually
      // paused record. tick() consults both the record flag and the set.
      pauseScope(scope) {
        if (!validScope(scope)) return { ok: false, reason: 'scope_invalid' };
        scopePaused.add(scope);
        return { ok: true, scope };
      },

      resumeScope(scope) {
        if (!validScope(scope)) return { ok: false, reason: 'scope_invalid' };
        scopePaused.delete(scope);
        return { ok: true, scope };
      },

      // Scope state export/hydrate for persistence. Kept separate from the
      // record array so the record contract stays exactly as documented.
      exportScopeState() {
        return [...scopePaused].sort().map((scope) => ({ scope, paused: true }));
      },

      hydrateScopeState(rows) {
        if (!Array.isArray(rows)) return { ok: false, reason: 'not_a_list' };
        const clean = [];
        for (const r of rows) {
          if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, reason: 'invalid_row' };
          if (!validScope(r.scope) || r.paused !== true) return { ok: false, reason: 'invalid_row' };
          clean.push(r.scope);
        }
        scopePaused.clear();
        for (const scope of clean) scopePaused.add(scope);
        return { ok: true, restored: clean.length };
      },

      // Evaluate the book at `at`. Pure with respect to the world: the
      // only state change is marking due schedules fired (exactly once) or
      // deferring them under quiet hours (defer, never drop).
      //
      // tick(at, { quietHours }) -> { quiet, due: [...], deferred: [...] }
      tick(at, opts) {
        const atMs = Number.isSafeInteger(at) ? at : now();
        const qh = opts ? parseQuietHours(opts.quietHours) : null;
        const quiet = inQuiet(atMs, qh);
        const due = [];
        const deferred = [];
        const candidates = [...book.values()]
          .filter((r) => !r.cancelled && !r.paused && !scopePaused.has(r.scope) && r.firedAt === null)
          .filter((r) => Math.max(r.dueAt, r.deferredTo || 0) <= atMs)
          .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
        for (const r of candidates) {
          if (quiet) {
            r.deferredTo = nextQuietEnd(atMs, qh);
            deferred.push({ ...r });
          } else {
            r.firedAt = atMs;
            due.push({ ...r });
          }
        }
        return { quiet, due, deferred };
      },

      // Bounded export for persistence: copies sorted by due time.
      exportAll() {
        return this.list();
      },

      // Read-only pass over prospective records: identical rules to
      // hydrate(), mutating nothing. The persistence layer validates every
      // store first and only then applies. A past dueAt is accepted: this
      // restores history, it does not re-run create()'s future-only rule.
      validate(records) {
        const v = strictRecords(records);
        if (!v.ok) return { ok: false, reason: v.reason };
        const list = v.records;
        if (list.length > MAX_SCHEDULES) return { ok: false, reason: 'book_overflow' };
        const clean = [];
        for (const r of list) {
          if (typeof r.id !== 'string' || !/^sch-\d{6}$/.test(r.id)) return { ok: false, reason: 'invalid_record' };
          if (typeof r.title !== 'string' || r.title.length === 0 || r.title.length > MAX_TITLE) return { ok: false, reason: 'invalid_record' };
          if (!validScope(r.scope)) return { ok: false, reason: 'invalid_record' };
          if (!Number.isSafeInteger(r.dueAt)) return { ok: false, reason: 'invalid_record' };
          if (r.notes !== null && (typeof r.notes !== 'string' || r.notes.length > MAX_NOTES)) return { ok: false, reason: 'invalid_record' };
          if (!Number.isFinite(r.createdAt)) return { ok: false, reason: 'invalid_record' };
          if (typeof r.paused !== 'boolean') return { ok: false, reason: 'invalid_record' };
          if (typeof r.cancelled !== 'boolean') return { ok: false, reason: 'invalid_record' };
          if (r.deferredTo !== null && !Number.isSafeInteger(r.deferredTo)) return { ok: false, reason: 'invalid_record' };
          if (r.firedAt !== null && !Number.isSafeInteger(r.firedAt)) return { ok: false, reason: 'invalid_record' };
          clean.push({
            id: r.id, title: r.title, scope: r.scope, dueAt: r.dueAt, notes: r.notes,
            createdAt: r.createdAt, paused: r.paused, cancelled: r.cancelled,
            deferredTo: r.deferredTo, firedAt: r.firedAt,
          });
        }
        const ids = new Set();
        let maxSeq = 0;
        for (const r of clean) {
          if (ids.has(r.id)) return { ok: false, reason: 'duplicate_id' };
          ids.add(r.id);
          const seqNo = parseInt(r.id.slice(4), 10);
          if (seqNo > maxSeq) maxSeq = seqNo;
        }
        return { ok: true, count: clean.length, records: clean, maxSeq };
      },

      hydrate(records) {
        const v = this.validate(records);
        if (!v.ok) return v;
        book.clear();
        for (const r of v.records) book.set(r.id, r);
        seq = v.maxSeq;
        return { ok: true, restored: v.count };
      },
    };
  }

  return {
    createScheduleBook,
    MAX_SCHEDULES,
    SCOPES,
    parseQuietHours,
    inQuiet,
    nextQuietEnd,
  };
});
