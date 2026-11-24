'use strict';

// Gate 2 delivery display store (blueprint 3j.3): a MAIN-OWNED, in-memory
// display surface for notification records accepted for display. It is
// deliberately SEPARATE from the persisted notification desk
// (src/agent-notifications.js): it never reads, writes or flips the desk's
// read/unread state, and it carries NO read semantics at all. A record
// stored here is a record displayed, never an acknowledgement; the
// acknowledgement decision is recorded in the blueprint (3j.1) and belongs
// to the user.
//
// Boundaries (all fail closed):
//   - Owned and mutated only by the main process. Nothing here touches
//     IPC, the renderer, disk, the network, timers or scheduling.
//   - Ephemeral in-memory by design (this gate adds no persistence and no
//     migrations): records are lost on restart, which is acceptable
//     because the display store is not a record of truth.
//   - Bounded capacity: at most MAX_RECORDS (50) records; on overflow the
//     OLDEST record is evicted first (deterministic FIFO).
//   - Strict plain-data validation of every append: allowlisted fields
//     only (id, title, body, priority, createdAt), the desk's id format,
//     no extra keys (secrets and internal metadata cannot enter), no
//     accessors, no symbol keys, no arrays, no exotic prototypes; property
//     descriptors are inspected before any value is read. Hostile or
//     malformed input is refused with a reason, never thrown on.
//   - Duplicate ids are ignored: the first record kept for an id stands, a
//     redelivery changes nothing (deterministic).
//   - Stored records are frozen; list() returns fresh copies, so no
//     returned reference can mutate the store.
//   - close() is explicit lifecycle: appends are refused after close (fail
//     closed), list() keeps returning the frozen snapshot.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionNotificationsDisplay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_RECORDS = 50;
  const MAX_TITLE = 200;
  const MAX_BODY = 500;
  const PRIORITIES = ['low', 'normal', 'high'];
  const ID_RE = /^ntf-\d{6}$/;
  const ALLOWED = ['id', 'title', 'body', 'priority', 'createdAt'];
  const POLLUTING = ['__proto__', 'constructor', 'prototype'];

  function accept(r) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
    const proto = Object.getPrototypeOf(r);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(r).length > 0) return null;
    const keys = Object.keys(r);
    if (keys.length !== ALLOWED.length) return null;
    for (const k of keys) {
      if (POLLUTING.includes(k) || !ALLOWED.includes(k)) return null;
      const d = Object.getOwnPropertyDescriptor(r, k);
      if (!d || !('value' in d) || d.get || d.set) return null;
    }
    for (const k of ALLOWED) {
      if (!Object.prototype.hasOwnProperty.call(r, k)) return null;
      const v = r[k];
      if (k === 'id') { if (typeof v !== 'string' || !ID_RE.test(v)) return null; }
      else if (k === 'createdAt') { if (typeof v !== 'number' || !Number.isFinite(v)) return null; }
      else if (k === 'priority') { if (!PRIORITIES.includes(v)) return null; }
      else { if (typeof v !== 'string' || v.length < 1 || v.length > (k === 'title' ? MAX_TITLE : MAX_BODY)) return null; }
    }
    return { id: r.id, title: r.title, body: r.body, priority: r.priority, createdAt: r.createdAt };
  }

  function createNotificationsDisplayStore() {
    const records = []; // oldest first, insertion order
    const ids = new Set();
    let closed = false;

    function append(raw) {
      if (closed) return { ok: false, reason: 'closed' };
      const rec = accept(raw);
      if (!rec) return { ok: true, accepted: false, reason: 'invalid_record', size: records.length };
      if (ids.has(rec.id)) return { ok: true, accepted: false, reason: 'duplicate_id', size: records.length };
      const frozen = Object.freeze(rec);
      records.push(frozen);
      ids.add(rec.id);
      let evicted = null;
      if (records.length > MAX_RECORDS) {
        evicted = records.shift();
        ids.delete(evicted.id);
      }
      return { ok: true, accepted: true, size: records.length, evictedId: evicted ? evicted.id : null };
    }

    function list(limit) {
      const cap = (Number.isInteger(limit) && limit >= 1) ? Math.min(limit, MAX_RECORDS) : MAX_RECORDS;
      // fresh copies of frozen records: no returned reference can mutate
      // the store
      return records.slice(0, cap).map((r) => ({ ...r }));
    }

    function size() { return records.length; }

    function close() {
      closed = true;
      return { ok: true, closed: true, size: records.length };
    }

    function isClosed() { return closed; }

    return { append, list, size, close, isClosed };
  }

  return { createNotificationsDisplayStore, MAX_RECORDS };
});
