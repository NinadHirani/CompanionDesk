'use strict';

// M4 sidecar slice (26 Nov 2026): the session-only sidecar for sensitive
// memory state, per Ninad's approved decision (decision-sheet item 6:
// sensitive sidecar markings, sensitive content session-only). This
// resolves the last open M4 sub-decision: there is NO on-disk format for
// sensitive marks. The sidecar is the only place sensitive state lives:
//   - marks: sensitivity CLASSIFICATIONS on on-disk bullets, keyed by
//     section + normalized text. A mark is never consent; marked bullets
//     stay hidden from retrieval by the consent gate.
//   - entries: session-only sensitive content the About-me file never
//     sees. The session view re-injects them after every rebuild, so
//     they survive refreshes within the session and die with it.
// The module is pure and in-memory only: no require, no fs, no timers,
// no serialization, nothing that could put sensitive state on disk.
// persistSensitive() upstream stays fail-closed (sensitive_storage_blocked).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionMemorySidecar = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_MARKS = 100;
  const MAX_ENTRIES = 50;
  const MAX_SECTION = 40;
  const MAX_TEXT = 200; // memory.js MAX_BULLET
  const MAX_KEY = 300;

  function createSidecar({ normalize } = {}) {
    const norm = typeof normalize === 'function' ? normalize : (s) => String(s);
    const marks = new Map();   // key -> true
    const entries = new Map(); // key -> { section, text }

    function key(section, text) {
      if (typeof section !== 'string' || section.length === 0 || section.length > MAX_SECTION) return null;
      if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) return null;
      const k = `${section}\u0000${norm(text)}`;
      if (k.length > MAX_KEY) return null;
      return k;
    }

    function mark(section, text) {
      const k = key(section, text);
      if (!k) return { ok: false, reason: 'bad_input' };
      if (marks.has(k)) return { ok: true, duplicated: true };
      if (marks.size >= MAX_MARKS) return { ok: false, reason: 'sidecar_full' };
      marks.set(k, true);
      return { ok: true };
    }

    // Idempotent: unmarking an unmarked key is fine.
    function unmark(section, text) {
      const k = key(section, text);
      if (!k) return { ok: false, reason: 'bad_input' };
      marks.delete(k);
      return { ok: true };
    }

    function isMarked(section, text) {
      const k = key(section, text);
      return k ? marks.has(k) : false;
    }

    function remember(section, text) {
      const k = key(section, text);
      if (!k) return { ok: false, reason: 'bad_input' };
      if (entries.has(k)) return { ok: true, duplicated: true };
      if (entries.size >= MAX_ENTRIES) return { ok: false, reason: 'sidecar_full' };
      entries.set(k, { section, text });
      return { ok: true };
    }

    function forget(section, text) {
      const k = key(section, text);
      if (!k) return { ok: false, reason: 'bad_input' };
      if (!entries.has(k)) return { ok: false, reason: 'not_found' };
      entries.delete(k);
      return { ok: true };
    }

    function has(section, text) {
      const k = key(section, text);
      return k ? entries.has(k) : false;
    }

    function entryList() {
      return [...entries.values()].map((e) => ({ section: e.section, text: e.text }));
    }

    function counts() {
      return { marks: marks.size, entries: entries.size };
    }

    function clear() {
      marks.clear();
      entries.clear();
      return { ok: true };
    }

    return Object.freeze({
      mark, unmark, isMarked, remember, forget, has, entryList, counts, clear,
      MAX_MARKS, MAX_ENTRIES,
    });
  }

  return { createSidecar };
});
