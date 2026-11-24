'use strict';

// Gate 2 delivery gate: the pure delivery bridge between the agent
// notification desk and the user-visible surface.
//
// agent-notifications.js creates notification RECORDS and never delivers
// anything. This module is the delivery mediator: it drains pending
// records, oldest first, to a delivery SINK the wiring layer supplies (a
// plain function that records one notification in the app's own
// user-visible surface) and acknowledges delivery by marking the record
// read in the desk itself, so there is no second source of delivery state.
//
// Boundaries this module enforces (all fail closed):
//   - No OS notification APIs, no network, no timers. The sink is
//     injectable; this module calls nothing else.
//   - A record is scanned only while it is unread. A successful sink call
//     is acknowledged by markRead in the same step, so in the normal path
//     the sink receives a record exactly once. Documented limit: the desk's
//     read flag is the only delivery state, so if markRead fails AFTER the
//     sink accepted a record, a later drain may hand that record to the
//     sink again; the sink must tolerate a duplicate.
//   - The sink receives a fresh plain copy of allowlisted fields only
//     (id, title, body, priority, createdAt): own data properties with
//     values only (accessors refused before any read), symbol keys never
//     copied, exotic prototypes refused. Mutating the copy cannot reach
//     the desk.
//   - The sink's verdict is read defensively: ok must be exactly true;
//     anything else is a refusal, and a refusal reason is sanitized to a
//     bounded printable string before it is reported. A sink that throws
//     is caught: the record stays undelivered and the drain stops with the
//     code sink_error.
//   - The drain stops at the first failure: records after a failed one stay
//     unread and are picked up by a later drain.
//   - The batch is bounded: at most maxBatch records per drain. The wiring
//     default is 10; a caller may only lower it.
//   - A malformed record is refused unread (record_invalid) before it can
//     reach the sink, even from a desk-shaped source that does not
//     validate its own records.

const ALLOWED = ['id', 'title', 'body', 'priority', 'createdAt'];
const ID_RE = /^ntf-\d{6}$/;
const MAX_TITLE = 120;
const MAX_BODY = 500;
const PRIORITIES = ['low', 'normal', 'high'];
const DEFAULT_MAX_BATCH = 10;
const MAX_REASON = 40;

function sanitizeReason(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_REASON) return 'sink_refused';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return 'sink_refused';
  }
  return value;
}

function deliverableCopy(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
  const proto = Object.getPrototypeOf(r);
  if (proto !== Object.prototype && proto !== null) return null;
  for (const k of ALLOWED) {
    const d = Object.getOwnPropertyDescriptor(r, k);
    if (!d || !('value' in d) || d.get || d.set) return null;
    const v = d.value;
    if (k === 'id') { if (typeof v !== 'string' || !ID_RE.test(v)) return null; }
    else if (k === 'createdAt') { if (typeof v !== 'number' || !Number.isFinite(v)) return null; }
    else if (k === 'priority') { if (!PRIORITIES.includes(v)) return null; }
    else { if (typeof v !== 'string' || v.length < 1 || v.length > (k === 'title' ? MAX_TITLE : MAX_BODY)) return null; }
  }
  const out = {};
  for (const k of ALLOWED) out[k] = r[k];
  return out;
}

function createDeliveryBridge({ notifications, sink, maxBatch } = {}) {
  if (!notifications || typeof notifications.pending !== 'function' || typeof notifications.markRead !== 'function') {
    throw new TypeError('desk_invalid');
  }
  if (typeof sink !== 'function') throw new TypeError('sink_invalid');
  let cap = DEFAULT_MAX_BATCH;
  if (maxBatch !== undefined) {
    if (!Number.isInteger(maxBatch) || maxBatch < 1) throw new TypeError('max_batch_invalid');
    cap = Math.min(maxBatch, DEFAULT_MAX_BATCH);
  }

  function drain({ limit } = {}) {
    let n = cap;
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1) return { ok: false, reason: 'limit_invalid' };
      n = Math.min(limit, cap);
    }
    const pending = notifications.pending();
    if (!Array.isArray(pending)) return { ok: true, delivered: 0, stopped: 'desk_invalid', remainingPending: 0 };
    const batch = pending.slice(0, n);
    let delivered = 0;
    let stopped = null;
    for (const rec of batch) {
      const copy = deliverableCopy(rec);
      if (!copy) { stopped = 'record_invalid'; break; }
      let verdict;
      try { verdict = sink(copy); } catch (e) { stopped = 'sink_error'; break; }
      if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) { stopped = 'sink_invalid'; break; }
      if (verdict.ok !== true) { stopped = sanitizeReason(verdict.reason); break; }
      const ack = notifications.markRead(copy.id);
      if (!ack || ack.ok !== true) { stopped = 'ack_failed'; break; }
      delivered += 1;
    }
    return { ok: true, delivered, stopped, remainingPending: pending.length - delivered };
  }

  return { drain, maxBatch: cap };
}

module.exports = { createDeliveryBridge };
