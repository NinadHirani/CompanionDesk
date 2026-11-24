'use strict';

// M4 store-contract wiring (24 Nov 2026): the v2 store contract
// (src/memory-store.js) is the product's in-session memory view.
//
// The About-me markdown file stays canonical and the ONLY memory store.
// Every mutation writes through the product module's single-bullet
// add/remove (memory.addBullet / memory.removeBullet), so manual edits and
// comments in the file survive exactly as before and the file is never
// rewritten whole; the store contract's toMarkdown() is deliberately NOT
// used for persistence. After each file write the session view is rebuilt
// from the file, so view and file cannot drift.
//
// The view is refreshed on demand: a cheap stat (mtime + size) check gives
// the same freshness guarantee the previous per-ask file read had, so a
// hand edit to the file is picked up by the next operation.
//
// Sensitive marks (decision D1, docs/M4_MEMORY_DECISIONS.md) stay
// SESSION-ONLY and fail closed:
//   - a mark is a sensitivity CLASSIFICATION, never consent;
//   - a marked bullet is hidden from retrieval by the consent gate but is
//     still the user's own file content, so list() keeps showing it;
//   - a mark on an on-disk bullet survives refreshes within the session
//     (tracked by section + normalized text), never silently dropped;
//   - persistSensitive() refuses (sensitive_storage_blocked) because no
//     on-disk format preserves the mark yet; that format is the owner's
//     still-open sub-decision and this module does NOT choose one;
//   - add(..., {sensitive:true}) keeps the entry in the session view only
//     (persisted:false); it is never written to the file and does not
//     survive a refresh. No product surface passes sensitive entries yet:
//     the IPC/service layer stays non-sensitive in this slice.
//
// Ids (m1, m2, ...) are session-view handles: stable within one sync
// epoch, reassigned by file position on every rebuild. They are NOT
// durable identifiers; nothing outside this module should store them.

const fs = require('fs');
const memory = require('./memory');
const storeMod = require('./memory-store');

const sessions = new Map(); // resolved path -> session

function statKey(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'missing';
    throw err;
  }
}

function markKey(section, text) {
  return `${section}\u0000${memory.normalize(text)}`;
}

function createSession(file) {
  let store = null;
  let fileKey = null;
  // Session-only sensitivity marks for (section, normalized text). Marks
  // never touch the file; they are re-applied to matching bullets after a
  // rebuild so a mark is not silently lost mid-session.
  const marks = new Set();

  function sync() {
    const key = statKey(file);
    if (store && key === fileKey) return store;
    const bullets = storeMod.parseMarkdown(memory.readText(file));
    for (const b of bullets) if (marks.has(markKey(b.section, b.text))) b.sensitive = true;
    store = storeMod.createStore(bullets);
    fileKey = key;
    return store;
  }

  return {
    // Exact legacy shape: [{ section, text }]. Marked (sensitive) bullets
    // are the user's own file content and stay listed.
    list() {
      return sync().list().map(({ section, text }) => ({ section, text }));
    },

    // Full view incl. ids and sensitivity flags (for tests and a future UI).
    items() {
      return sync().list();
    },

    count() {
      return sync().count();
    },

    // Non-sensitive path mirrors src/memory.js addMemory exactly: same
    // order of checks (unknown_section -> empty -> duplicate), same return
    // shape, and the file gains ONE bullet line via memory.addBullet.
    add(section, value, { sensitive = false } = {}) {
      const view = sync();
      const r = view.addMemory(section, value, { sensitive });
      if (!r.ok) return r;
      if (sensitive) return r; // session-only; never written to the file
      const res = memory.addBullet(memory.readText(file), section, r.text);
      if (!res.added) { sync(); return { ok: false, error: 'duplicate' }; }
      memory.writeText(file, res.text);
      sync();
      return { ok: true, text: r.text };
    },

    // Legacy signature: forget by section + text (first normalized match),
    // same semantics as memory.forgetMemory. The file loses ONE bullet
    // line via memory.removeBullet, then the view is rebuilt.
    forget(section, value) {
      sync();
      const target = memory.normalize(value);
      const hit = store.list().find((b) => b.section === section && memory.normalize(b.text) === target);
      if (!hit) return { ok: false, error: 'not_found' };
      const res = memory.removeBullet(memory.readText(file), section, value);
      if (!res.removed) { sync(); return { ok: false, error: 'not_found' }; }
      memory.writeText(file, res.text);
      sync();
      return { ok: true };
    },

    // Session-only mark on a view bullet. Returns the bullet's id so a
    // future UI can address it; the mark is a classification, not consent.
    markSensitive(id, value = true) {
      const view = sync();
      const r = view.markSensitive(id, value);
      if (!r.ok) return r;
      const b = view.list().find((x) => x.id === id);
      if (b) {
        const k = markKey(b.section, b.text);
        if (value) marks.add(k); else marks.delete(k);
      }
      return r;
    },

    // Fail-closed: refuses for a marked bullet (no on-disk format preserves
    // the mark); an unmarked bullet is already persisted on disk.
    persistSensitive(id) {
      return sync().persistSensitive(id);
    },

    // The measured ranker over the session view (consent gate included).
    search(query, opts = {}) {
      return sync().search(query, opts);
    },
  };
}

// One session per resolved file path, shared across every caller in the
// process, so the view, the marks and the stat cache stay coherent.
function get(meFile) {
  const key = String(require('path').resolve(meFile));
  let s = sessions.get(key);
  if (!s) { s = createSession(meFile); sessions.set(key, s); }
  return s;
}

function _resetForTests() { sessions.clear(); }

module.exports = { get, _resetForTests };
