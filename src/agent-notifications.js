'use strict';

// Gate 2 slice 4: the first harmless tools. notifications: a pure, bounded,
// in-memory queue of notification RECORDS. This module creates and manages
// records only. It never sends, delivers, displays or schedules anything:
// no OS notification APIs, no network, no timers. Delivery is the wiring
// layer's job and is a separate, explicitly-reviewed gate. Registry
// capability class for these operations: reversible_write (a record can be
// removed), never sensitive, so the policy engine requires only a standing
// grant, never a per-call approval.
//
// Fail-closed validation: every field is typed, length-capped and
// allowlisted; the queue is bounded and refuses to grow past its cap rather
// than silently evicting records.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentNotifications = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_TITLE = 120;
  const MAX_BODY = 500;
  const PRIORITIES = ['low', 'normal', 'high'];
  const MAX_QUEUE = 100;
  const MAX_ID = 16;

  function createNotificationDesk({ clock } = {}) {
    const now = clock || (() => Date.now());
    const queue = []; // oldest first
    let seq = 0;

    function validText(v, max) {
      return typeof v === 'string' && v.length > 0 && v.length <= max;
    }

    return {
      // Create one notification record. Nothing is delivered here.
      create({ title, body, priority } = {}) {
        if (!validText(title, MAX_TITLE)) return { ok: false, reason: 'title_invalid' };
        if (!validText(body, MAX_BODY)) return { ok: false, reason: 'body_invalid' };
        if (queue.length >= MAX_QUEUE) return { ok: false, reason: 'queue_full' };
        const p = priority === undefined ? 'normal' : priority;
        if (!PRIORITIES.includes(p)) return { ok: false, reason: 'priority_invalid' };
        seq += 1;
        const rec = {
          id: 'ntf-' + String(seq).padStart(6, '0'),
          title,
          body,
          priority: p,
          createdAt: now(),
          read: false,
        };
        queue.push(rec);
        return { ok: true, notification: { ...rec } };
      },

      // A copy of the queue, oldest first. Callers cannot reach the records.
      list() {
        return queue.map((r) => ({ ...r }));
      },

      pending() {
        return queue.filter((r) => !r.read).map((r) => ({ ...r }));
      },

      // Bounded export for persistence: plain copies, oldest first. The
      // records are the desk's own shape; nothing is added here.
      exportAll() {
        return queue.map((r) => ({ ...r }));
      },

      // Restore persisted records. Strict and all-or-nothing: every record
      // must match the exact shape create() produces (same caps), ids must
      // be unique, and an overflow is refused whole, never truncated.
      // Unknown fields are dropped: the desk's records carry no such fields,
      // so anything extra is not this desk's data and must not come back in.
      hydrate(records) {
        const list = Array.isArray(records) ? records : [];
        if (list.length > MAX_QUEUE) return { ok: false, reason: 'queue_overflow' };
        const restored = [];
        for (const r of list) {
          if (!r || typeof r !== 'object') return { ok: false, reason: 'invalid_record' };
          if (typeof r.id !== 'string' || !/^ntf-\d{6}$/.test(r.id)) return { ok: false, reason: 'invalid_record' };
          if (!validText(r.title, MAX_TITLE) || !validText(r.body, MAX_BODY)) return { ok: false, reason: 'invalid_record' };
          if (!PRIORITIES.includes(r.priority)) return { ok: false, reason: 'invalid_record' };
          if (!Number.isFinite(r.createdAt)) return { ok: false, reason: 'invalid_record' };
          if (typeof r.read !== 'boolean') return { ok: false, reason: 'invalid_record' };
          restored.push({ id: r.id, title: r.title, body: r.body, priority: r.priority, createdAt: r.createdAt, read: r.read });
        }
        const ids = new Set();
        let maxSeq = 0;
        for (const r of restored) {
          if (ids.has(r.id)) return { ok: false, reason: 'duplicate_id' };
          ids.add(r.id);
          const s = parseInt(r.id.slice(4), 10);
          if (s > maxSeq) maxSeq = s;
        }
        queue.length = 0;
        for (const r of restored) queue.push(r);
        seq = maxSeq;
        return { ok: true, restored: restored.length };
      },

      markRead(id) {
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) return { ok: false, reason: 'id_invalid' };
        const rec = queue.find((r) => r.id === id);
        if (!rec) return { ok: false, reason: 'notification_unknown' };
        rec.read = true;
        return { ok: true, notification: { ...rec } };
      },

      remove(id) {
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) return { ok: false, reason: 'id_invalid' };
        const i = queue.findIndex((r) => r.id === id);
        if (i === -1) return { ok: false, reason: 'notification_unknown' };
        const [removed] = queue.splice(i, 1);
        return { ok: true, removed: { ...removed } };
      },

      count() {
        return queue.length;
      },
    };
  }

  return { createNotificationDesk, MAX_QUEUE, PRIORITIES };
});
