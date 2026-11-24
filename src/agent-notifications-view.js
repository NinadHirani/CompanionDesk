'use strict';

// Gate 2 delivery display slice: the pure notification display shaper.
// Takes the records served by the EXISTING read-only notifications:read
// channel and returns bounded plain-text display lines for the agent panel.
// Pure data shaping only: no DOM, no IPC, no writes, no timers, no network.
// The panel renders the lines with textContent, so nothing here can become
// markup; no escaping is attempted and none is needed.
//
// Boundaries (all fail closed):
//   - Display cap: at most MAX_DISPLAY (10) lines per call, newest first
//     (the read channel's list is oldest first). A caller may only lower
//     the cap.
//   - Allowlisted fields only: id, title, body, priority, createdAt, read.
//     A record carrying any other own enumerable key, a symbol key, an
//     accessor property, an array or exotic prototype is skipped, never
//     displayed; descriptors are inspected before any value is read.
//   - Records are never mutated: the input is read, never written; the
//     output is fresh plain strings.
//   - Title and body are truncated for display; hostile characters are
//     passed through verbatim as plain text (textContent renders them
//     inert), never interpreted.
//   - Malformed records are skipped and counted, never displayed and never
//     thrown on.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionNotificationsView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_DISPLAY = 10;
  const MAX_TITLE = 200;   // the read surface clips strings at 200
  const MAX_BODY = 500;    // the desk's own cap; display truncates further
  const MAX_BODY_LINE = 140;
  const PRIORITIES = ['low', 'normal', 'high'];
  const ID_RE = /^ntf-\d{6}$/;
  const ALLOWED = ['id', 'title', 'body', 'priority', 'createdAt', 'read'];

  function truncate(s, max) {
    return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
  }

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
      const v = r[k];
      if (k === 'id') { if (typeof v !== 'string' || !ID_RE.test(v)) return null; }
      else if (k === 'createdAt') { if (typeof v !== 'number' || !Number.isFinite(v)) return null; }
      else if (k === 'read') { if (typeof v !== 'boolean') return null; }
      else if (k === 'priority') { if (!PRIORITIES.includes(v)) return null; }
      else { if (typeof v !== 'string' || v.length < 1 || v.length > (k === 'title' ? MAX_TITLE : MAX_BODY)) return null; }
    }
    return { id: r.id, title: r.title, body: r.body, priority: r.priority, createdAt: r.createdAt, read: r.read };
  }

  function shape(records, { max } = {}) {
    let cap = MAX_DISPLAY;
    if (max !== undefined) {
      if (!Number.isInteger(max) || max < 1) return { ok: false, reason: 'max_invalid' };
      cap = Math.min(max, MAX_DISPLAY);
    }
    if (!Array.isArray(records)) return { ok: true, lines: [], shown: 0, skipped: 0, hidden: 0, total: 0 };
    const accepted = [];
    let skipped = 0;
    for (const r of records) {
      const c = accept(r);
      if (c) accepted.push(c);
      else skipped += 1;
    }
    accepted.reverse(); // newest first for display
    const lines = [];
    for (const r of accepted) {
      if (lines.length >= cap) break;
      const tag = r.priority === 'normal' ? '' : '[' + r.priority + '] ';
      const readMark = r.read ? '(read) ' : '';
      lines.push(readMark + tag + truncate(r.title, MAX_TITLE) + ' \u00b7 ' + truncate(r.body, MAX_BODY_LINE));
    }
    return {
      ok: true,
      lines,
      shown: lines.length,
      skipped,
      hidden: Math.max(0, accepted.length - lines.length),
      total: records.length,
    };
  }

  return { shape, MAX_DISPLAY };
});
