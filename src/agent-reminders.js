'use strict';

// Gate 2 slice 4: the first harmless tools. reminders: a pure, bounded,
// in-memory book of reminder RECORDS with due timestamps. This module
// creates, lists and cancels records only. It never wakes anything, never
// fires, never notifies, and holds no timers: a due reminder is data a
// caller can read. Scheduling/waking is the wiring layer's job and is a
// separate, explicitly-reviewed gate. Registry capability class:
// reversible_write (a reminder can be cancelled), never sensitive.
//
// Fail-closed validation: typed fields, length caps, an integer epoch-ms
// dueAt that must lie in the future, and a bounded book that refuses to
// grow past its cap rather than silently evicting records.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentReminders = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_TITLE = 120;
  const MAX_NOTES = 500;
  const MAX_BOOK = 100;
  const MAX_ID = 16;

  function createReminderBook({ clock } = {}) {
    const now = clock || (() => Date.now());
    const book = new Map(); // id -> record
    let seq = 0;

    return {
      // Create one reminder record. Nothing is scheduled or fired here.
      create({ title, dueAt, notes } = {}) {
        if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE) return { ok: false, reason: 'title_invalid' };
        if (!Number.isInteger(dueAt)) return { ok: false, reason: 'due_at_invalid' };
        if (dueAt <= now()) return { ok: false, reason: 'due_at_past' };
        if (book.size >= MAX_BOOK) return { ok: false, reason: 'book_full' };
        if (notes !== undefined && (typeof notes !== 'string' || notes.length > MAX_NOTES)) return { ok: false, reason: 'notes_invalid' };
        seq += 1;
        const rec = {
          id: 'rem-' + String(seq).padStart(6, '0'),
          title,
          dueAt,
          notes: notes || null,
          createdAt: now(),
          cancelled: false,
        };
        book.set(rec.id, rec);
        return { ok: true, reminder: { ...rec } };
      },

      // A copy of the book sorted by due time, soonest first. Cancelled
      // reminders are included with cancelled: true until they are removed.
      list() {
        return [...book.values()]
          .sort((a, b) => a.dueAt - b.dueAt)
          .map((r) => ({ ...r }));
      },

      // Reminders whose time has come (dueAt <= at) and that are not
      // cancelled or already acknowledged. Pure read: nothing fires here.
      due(at) {
        const atMs = Number.isInteger(at) ? at : now();
        return [...book.values()]
          .filter((r) => !r.cancelled && !r.acknowledged && r.dueAt <= atMs)
          .sort((a, b) => a.dueAt - b.dueAt)
          .map((r) => ({ ...r }));
      },

      cancel(id) {
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) return { ok: false, reason: 'id_invalid' };
        const rec = book.get(id);
        if (!rec) return { ok: false, reason: 'reminder_unknown' };
        rec.cancelled = true;
        return { ok: true, reminder: { ...rec } };
      },

      remove(id) {
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) return { ok: false, reason: 'id_invalid' };
        if (!book.has(id)) return { ok: false, reason: 'reminder_unknown' };
        const removed = book.get(id);
        book.delete(id);
        return { ok: true, removed: { ...removed } };
      },

      acknowledge(id) {
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) return { ok: false, reason: 'id_invalid' };
        const rec = book.get(id);
        if (!rec) return { ok: false, reason: 'reminder_unknown' };
        rec.acknowledged = true;
        return { ok: true, reminder: { ...rec } };
      },

      count() {
        return book.size;
      },
    };
  }

  return { createReminderBook, MAX_BOOK };
});
