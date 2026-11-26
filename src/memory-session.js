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
// Sensitive state (decision D1, docs/M4_MEMORY_DECISIONS.md; the sidecar
// slice approved by Ninad on 26 Nov 2026) stays SESSION-ONLY and fails
// closed, held in src/memory-sidecar.js:
//   - a mark is a sensitivity CLASSIFICATION, never consent;
//   - a marked bullet is hidden from retrieval by the consent gate but is
//     still the user's own file content, so list() keeps showing it;
//   - a mark on an on-disk bullet survives refreshes within the session
//     (tracked by section + normalized text in the sidecar), never
//     silently dropped;
//   - persistSensitive() refuses (sensitive_storage_blocked): the owner
//     sub-decision is now RESOLVED (26 Nov 2026) as a session-only
//     sidecar, so there is deliberately NO on-disk format for sensitive
//     state and this module does not choose one;
//   - add(..., {sensitive:true}) keeps the entry in the sidecar and the
//     session view only (persisted:false); it is never written to the
//     file, and the sidecar re-injects it after every rebuild so it
//     survives refreshes within the session and dies with it. If the
//     sidecar is full the add is refused and rolled back (fail closed).
//     The only product surface that passes sensitive entries is the
//     memory panel's explicit, user-commanded controls (M2/M4 UI slice,
//     26 Nov 2026); the ask paths stay non-sensitive.
//
// Ids (m1, m2, ...) are session-view handles: stable within one sync
// epoch, reassigned by file position on every rebuild. They are NOT
// durable identifiers; nothing outside this module should store them.

const fs = require('fs');
const memory = require('./memory');
const storeMod = require('./memory-store');
const sidecarMod = require('./memory-sidecar');

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

function createSession(file) {
  let store = null;
  let fileKey = null;
  // The session-only sidecar holds ALL sensitive state: marks on on-disk
  // bullets and session-only sensitive entries. It never touches the file.
  const sidecar = sidecarMod.createSidecar({ normalize: memory.normalize });

  function sync() {
    const key = statKey(file);
    if (store && key === fileKey) return store;
    const bullets = storeMod.parseMarkdown(memory.readText(file));
    for (const b of bullets) if (sidecar.isMarked(b.section, b.text)) b.sensitive = true;
    store = storeMod.createStore(bullets);
    // Re-inject the sidecar's session-only sensitive entries: they live in
    // the sidecar, not the file, so a rebuild must re-add them or a
    // refresh would silently drop session content. A re-inject refused as
    // duplicate means the same bullet is now file content (a manual edit):
    // drop the sidecar's copy so no ghost entry lingers; the file bullet
    // stays the user's own unmarked line.
    for (const e of sidecar.entryList()) {
      const r = store.addMemory(e.section, e.text, { sensitive: true });
      if (!r.ok && r.error === 'duplicate') sidecar.forget(e.section, e.text);
    }
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
      if (sensitive) {
        // Session-only: the sidecar must hold it or the entry does not
        // exist reliably. Fail closed: roll the view add back and refuse.
        const sr = sidecar.remember(section, r.text);
        if (!sr.ok) {
          view.forgetMemory(r.id);
          return { ok: false, error: sr.reason === 'sidecar_full' ? 'sidecar_full' : 'bad_input' };
        }
        return r; // { ok, id, text, persisted:false }; never written to the file
      }
      const res = memory.addBullet(memory.readText(file), section, r.text);
      if (!res.added) { sync(); return { ok: false, error: 'duplicate' }; }
      try {
        memory.writeText(file, res.text);
      } catch (err) {
        // The file never changed, so the stat cache would keep serving the
        // view that already gained the bullet: invalidate it so the next
        // sync rebuilds from the canonical file and the phantom never shows.
        fileKey = null;
        throw err;
      }
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
      // A session-only sidecar entry is not file content: forget it in the
      // sidecar and rebuild, leaving the file untouched.
      if (hit.sensitive && sidecar.has(section, hit.text)) {
        const fr = sidecar.forget(section, hit.text);
        if (!fr.ok) return { ok: false, error: 'not_found' };
        fileKey = null; // the file did not change, so force the rebuild
        sync();
        return { ok: true };
      }
      const res = memory.removeBullet(memory.readText(file), section, value);
      if (!res.removed) { sync(); return { ok: false, error: 'not_found' }; }
      memory.writeText(file, res.text);
      // The mark is keyed by section + normalized text, not by id: without
      // this, an orphaned mark would silently re-mark a later re-add of
      // the same text (sidecar.isMarked matches it on the next rebuild)
      // and sit in the bounded mark set. Only after the file write: if the
      // write failed the bullet still exists and its mark must stay.
      sidecar.unmark(section, hit.text);
      sync();
      return { ok: true };
    },

    // Session-only mark on a view bullet. Returns the bullet's id so a
    // future UI can address it; the mark is a classification, not consent.
    markSensitive(id, value = true) {
      const view = sync();
      const b = view.list().find((x) => x.id === id);
      // A session-only sidecar entry is sensitive BY CONSTRUCTION: it
      // exists only because it was added as sensitive, and an unmarked
      // session-only entry has no home (persisting it would silently
      // downgrade sensitive content to plain file text). Fail closed with
      // an explicit error instead of a mark the next rebuild would
      // silently restore.
      if (!value && b && sidecar.has(b.section, b.text)) {
        return {
          ok: false,
          error: 'session_only_entry',
          detail: 'a session-only sensitive entry stays sensitive; forget it instead',
        };
      }
      const r = view.markSensitive(id, value);
      if (!r.ok) return r;
      if (b) {
        if (value) {
          const mr = sidecar.mark(b.section, b.text);
          if (!mr.ok && mr.reason === 'sidecar_full') {
            view.markSensitive(id, false); // roll the mark back: fail closed
            return { ok: false, error: 'sidecar_full' };
          }
        } else {
          sidecar.unmark(b.section, b.text);
        }
      }
      return r;
    },

    // Fail-closed: refuses for a marked bullet (no on-disk format preserves
    // the mark); an unmarked bullet is already persisted on disk.
    persistSensitive(id) {
      return sync().persistSensitive(id);
    },

    // Persistence provenance for one view bullet, for the panel's status
    // lines: 'file' when the bullet is the user's own file content (a mark
    // does not change where the bullet lives; only the mark is
    // session-only), 'session-only' when it lives only in the sidecar,
    // null for an unknown id.
    persisted(id) {
      const view = sync();
      const b = view.list().find((x) => x.id === id);
      if (!b) return null;
      return sidecar.has(b.section, b.text) ? 'session-only' : 'file';
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
