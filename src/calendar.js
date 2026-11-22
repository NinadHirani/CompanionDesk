'use strict';

// Calendar service: import a local .ics file, list what is coming up.
// No account, no network. Takes the database as an argument.

const path = require('path');
const { parseIcs, expandEvents } = require('./ics');
const { cleanLine } = require('./settings');
const { addDaysIso } = require('./dates');

const MAX_BYTES = 5 * 1024 * 1024;

// payload: { name: file name, text: file contents }
function importCalendar(db, payload, nowIso) {
  if (!payload || typeof payload.name !== 'string' || typeof payload.text !== 'string') return { ok: false, error: 'bad_request' };
  if (Buffer.byteLength(payload.text, 'utf8') > MAX_BYTES) return { ok: false, error: 'file_too_large' };
  const name = cleanLine(path.basename(payload.name), 80);
  if (!name) return { ok: false, error: 'bad_request' };
  const { events, skipped } = parseIcs(payload.text);
  if (!events.length) return { ok: false, error: 'no_events' };
  db.saveCalendar(name, nowIso, events);
  return { ok: true, name, events: events.length, skipped };
}

// payload: { days?: 1..60 } -> occurrences from today for that many days.
function upcoming(db, payload, todayIso) {
  const days = payload && payload.days !== undefined ? payload.days : 7;
  if (!Number.isInteger(days) || days < 1 || days > 60) return { ok: false, error: 'bad_request' };
  const calendars = db.listCalendars();
  const all = [];
  let unsupportedCount = 0;
  for (const c of calendars) {
    const r = expandEvents(c.events, todayIso, addDaysIso(todayIso, days - 1));
    all.push(...r.occurrences);
    unsupportedCount += r.unsupportedCount;
  }
  all.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title));
  return { ok: true, occurrences: all, unsupportedCount, calendars: calendars.map((c) => c.name) };
}

function removeCalendar(db, payload) {
  if (!payload || typeof payload.name !== 'string') return { ok: false, error: 'bad_request' };
  return db.removeCalendar(payload.name) ? { ok: true } : { ok: false, error: 'not_found' };
}

module.exports = { importCalendar, upcoming, removeCalendar, MAX_BYTES };
