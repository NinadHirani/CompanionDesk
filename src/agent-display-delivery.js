'use strict';

// Gate 2 delivery gate, blueprint 3j.6: the narrow MAIN-ONLY delivery
// operation that copies eligible notification records from the persisted
// notification desk into the main-owned display store
// (src/agent-notifications-display.js), from which the renderer panel
// already renders read-only.
//
// This module is deliberately SEPARATE from src/agent-delivery.js (the
// pure delivery bridge of 3j.1). The bridge acknowledges delivery by
// marking the desk record read in the same step; that semantics is
// incompatible with the 3j.4/3j.5 decision (option C: only an explicit
// user gesture acknowledges). This module never calls markRead, never
// writes the audit log and never mutates the desk in any way: the desk's
// read flag stays canonical and delivery cannot acknowledge. The bridge is
// left untouched for its future callers.
//
// What "sink success" means here: a record ACCEPTED INTO THE DISPLAY
// STORE. It is a record displayed, never a record seen, read or
// acknowledged. No acknowledgement happens at delivery, ever.
//
// Eligibility: a desk record is eligible exactly when its canonical read
// flag is false. A read record is never delivered and never re-delivered,
// so restart reconciliation repopulates only unread records: after an app
// restart the ephemeral display store is rebuilt from the desk's unread
// records, and every source record survives in the desk regardless of what
// the display store does.
//
// Boundaries this module enforces (all fail closed):
//   - Main-only by construction: the display store object never reaches
//     the renderer, and this module adds no IPC channel. The renderer can
//     neither trigger delivery, choose records, nor write anything here.
//   - No OS notification APIs, no network, no timers, no scheduling. A
//     pass runs only when main calls it: once after the agent runtime
//     starts (restart reconciliation) and after every successful
//     acknowledgement. A future main-side creation site must call the
//     pass in the same step; there is no other trigger and no renderer
//     trigger.
//   - The source is read defensively: a non-array source is a refusal
//     (source_invalid); each record must be a plain object with exactly
//     the allowlisted fields plus the read flag, the desk's id format and
//     value caps, and a strictly boolean read flag. A malformed record is
//     refused (counted, never silently skipped) and can never become
//     eligible; the desk still holds it.
//   - Duplicate handling: an id already in the display store is a
//     duplicate (counted, nothing changes), so replay and re-delivery
//     after a restart are safe. Within one hostile source pass, the first
//     occurrence of an id wins and later ones are counted.
//   - Bounded batch: at most maxBatch appends per pass. The default is 10
//     and a caller may only lower it; a pass that hits the cap stops with
//     stopped 'batch_limit' and reports the remaining eligible records,
//     which the next pass delivers. This is the backpressure bound.
//   - Capacity and eviction safety: the display store's own FIFO eviction
//     may only remove a record that the desk still holds AND whose read
//     flag is true. Before every append into a full store the pass inspects
//     the store's oldest record and refuses to append (stopped 'overflow',
//     with the remaining count and the next eligible id reported) unless
//     that record is acked in the desk. An unread record is therefore
//     never silently displaced from display, and no source record is ever
//     lost: everything stays in the desk.
//   - Orphan garbage collection: a displayed record whose id the desk no
//     longer holds (possible only if a future caller removes desk records;
//     the desk itself refuses to overflow rather than evict) can never be
//     acknowledged again, so each pass drops it explicitly and REPORTS the
//     drop (count and bounded id list). This is the only way a displayed
//     record leaves the store other than a safe eviction.
//   - Store faults are failures, not fallbacks: a closed store refuses the
//     whole pass (store_closed); an append that throws or returns an
//     unrecognized verdict stops the pass with store_error, leaving the
//     desk untouched. The next pass retries nothing automatically; there
//     is no silent fallback and no retry loop (no timers).
//
// Progress guarantee (no starvation): every eligible unread record becomes
// displayed after a bounded number of later passes. Each successful
// acknowledgement triggers a pass; acknowledging the oldest displayed
// unread record frees exactly one safe-evict slot, so the next oldest
// unread record is delivered. A record is blocked only by records older
// than it, and those are always displayed (hence ackable) before it.
// Orphans are the one reported exception: the desk already discarded them,
// which is a property of the desk's own bounded design, not of delivery.

const MAX_RECORDS = 50; // mirrors the display store's cap
const DEFAULT_MAX_BATCH = 10;
const MAX_IDS_REPORTED = 10;
const MAX_TITLE = 120; // the desk's caps: a stricter source than the store's
const MAX_BODY = 500;
const PRIORITIES = ['low', 'normal', 'high'];
const ID_RE = /^ntf-\d{6}$/;
const ALLOWED = ['id', 'title', 'body', 'priority', 'createdAt', 'read'];

function validSourceRecord(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return false;
  const proto = Object.getPrototypeOf(r);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(r).length > 0) return false;
  const keys = Object.keys(r);
  if (keys.length !== ALLOWED.length) return false;
  for (const k of keys) {
    if (!ALLOWED.includes(k)) return false;
    const d = Object.getOwnPropertyDescriptor(r, k);
    if (!d || !('value' in d) || d.get || d.set) return false;
  }
  const id = r.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return false;
  if (typeof r.read !== 'boolean') return false;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return false;
  if (!PRIORITIES.includes(r.priority)) return false;
  if (typeof r.title !== 'string' || r.title.length < 1 || r.title.length > MAX_TITLE) return false;
  if (typeof r.body !== 'string' || r.body.length < 1 || r.body.length > MAX_BODY) return false;
  return true;
}

function createDisplayDelivery({ readDesk, store, maxBatch } = {}) {
  if (typeof readDesk !== 'function') throw new TypeError('source_invalid');
  if (!store || typeof store.append !== 'function' || typeof store.list !== 'function'
    || typeof store.size !== 'function' || typeof store.isClosed !== 'function') {
    throw new TypeError('store_invalid');
  }
  let cap = DEFAULT_MAX_BATCH;
  if (maxBatch !== undefined) {
    if (!Number.isInteger(maxBatch) || maxBatch < 1) throw new TypeError('max_batch_invalid');
    cap = Math.min(maxBatch, DEFAULT_MAX_BATCH);
  }

  function deliver() {
    // A closed store refuses the whole pass; nothing else is touched.
    if (store.isClosed()) return { ok: false, reason: 'store_closed' };
    let recs;
    try { recs = readDesk(); } catch (e) { return { ok: false, reason: 'source_error' }; }
    if (!Array.isArray(recs)) return { ok: false, reason: 'source_invalid' };

    // One pass over the source: validate, index read flags, dedup ids.
    const deskRead = new Map(); // id -> boolean read flag (valid records only)
    const eligible = []; // eligible copies, source order (oldest first)
    let refused = 0;
    const refusedIds = [];
    let sourceDuplicates = 0;
    for (const r of recs) {
      if (!validSourceRecord(r)) {
        refused += 1;
        if (r && typeof r === 'object' && typeof r.id === 'string' && ID_RE.test(r.id) && refusedIds.length < MAX_IDS_REPORTED) refusedIds.push(r.id);
        continue;
      }
      if (deskRead.has(r.id)) { sourceDuplicates += 1; continue; }
      deskRead.set(r.id, r.read);
      if (r.read === false) eligible.push({ id: r.id, title: r.title, body: r.body, priority: r.priority, createdAt: r.createdAt });
    }

    // Orphan garbage collection, reported: a displayed id the valid desk
    // view no longer holds can never be acknowledged again.
    const displayed = store.list();
    const orphans = [];
    for (const d of displayed) {
      if (!deskRead.has(d.id)) orphans.push(d.id);
    }
    let droppedOrphans = 0;
    const droppedIds = [];
    for (const id of orphans) {
      const v = store.drop(id);
      if (v && v.ok === true) {
        droppedOrphans += 1;
        if (droppedIds.length < MAX_IDS_REPORTED) droppedIds.push(id);
      }
    }

    // Delivery: oldest unread first, bounded batch, eviction-safe. An id
    // already displayed is a duplicate BEFORE any capacity question: the
    // store's own append short-circuits duplicates without evicting, so a
    // replay pass changes nothing and reports only counts. The batch cap
    // and the eviction-safety gate therefore bound REAL deliveries only.
    const displayedIds = new Set(store.list().map((d) => d.id));
    let delivered = 0;
    let duplicates = 0;
    let stopped = null;
    let remaining = 0;
    let nextId = null;
    for (let i = 0; i < eligible.length; i++) {
      const rec = eligible[i];
      if (displayedIds.has(rec.id)) { duplicates += 1; continue; }
      if (delivered >= cap) { stopped = 'batch_limit'; remaining = eligible.length - i; nextId = rec.id; break; }
      if (store.size() >= MAX_RECORDS) {
        // FIFO eviction may only remove a record the desk still holds and
        // has already acked.
        const oldest = store.list(1)[0] || null;
        const safe = oldest && deskRead.has(oldest.id) && deskRead.get(oldest.id) === true;
        if (!safe) { stopped = 'overflow'; remaining = eligible.length - i; nextId = rec.id; break; }
      }
      let verdict;
      try { verdict = store.append({ id: rec.id, title: rec.title, body: rec.body, priority: rec.priority, createdAt: rec.createdAt }); }
      catch (e) { return { ok: false, reason: 'store_error', delivered, duplicates, refused, droppedOrphans }; }
      if (verdict && verdict.ok === true && verdict.accepted === true) {
        delivered += 1;
        displayedIds.add(rec.id);
      } else if (verdict && verdict.ok === true && verdict.reason === 'invalid_record') {
        refused += 1;
      } else {
        return { ok: false, reason: 'store_error', delivered, duplicates, refused, droppedOrphans };
      }
    }
    return {
      ok: true,
      delivered,
      duplicates,
      refused,
      refusedIds,
      sourceDuplicates,
      droppedOrphans,
      droppedIds,
      stopped,
      remaining,
      nextId,
      size: store.size(),
    };
  }

  return { deliver, maxBatch: cap };
}

module.exports = { createDisplayDelivery };
