'use strict';

// Gate 2 run-driver Stage B (blueprint 3j.10): the calendar_upcoming tool.
// Approved by Ninad on 26 Nov 2026: D-B1 is implemented here; D-B2 option
// (a) means the production registry stays EMPTY and main.js registers
// nothing. The registration/enable step is a separate, later review.
//
// The tool is a read-only projection of the local calendars the user
// imported themselves. It NEVER requires the calendar or ics modules: the
// calendar service arrives by DEPENDENCY INJECTION, exactly like the
// scheduling gate's book, so this module stays pure and the closed
// generator files stay untouched.
//
// Security shape (mirrors the scheduling gate):
//   - capability 'read_only': a standing grant suffices; no per-call
//     approval is ever required.
//   - The tool does NOT return the raw service shape. It returns a trimmed
//     projection built HERE, before anything is persisted or observed:
//     uid and location are dropped ALWAYS, titles are capped at 200
//     characters, rows are capped at 100 in the service's own sort order
//     (the tool never re-sorts), and the serialized envelope is capped at
//     32768 bytes by dropping trailing rows.
//   - Range enforcement stays with the service (days is an integer 1..60,
//     default 7). A service refusal or throw surfaces as a failed step,
//     never as an escape.
//   - The step executor is ONE closure: it trims and caps the output
//     BEFORE anything returns to the orchestrator and writes nothing of
//     its own.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentToolCalendar = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_ROWS = 100;
  const MAX_BYTES = 32768;
  const MAX_TITLE = 200;

  const CALENDAR_UPCOMING_DEF = {
    name: 'calendar_upcoming',
    description: 'Read a bounded projection of upcoming events from the local calendars the user imported (read-only)',
    capability: 'read_only',
    schema: {
      properties: {
        days: { type: 'integer', description: 'Window length in days, 1 to 60; default 7' },
      },
    },
  };

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  function byteLength(s) {
    return typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : s.length;
  }

  function trimRow(o) {
    const title = typeof o.title === 'string' ? (o.title.length > MAX_TITLE ? o.title.slice(0, MAX_TITLE) : o.title) : '';
    return {
      title,
      date: typeof o.date === 'string' ? o.date : null,
      time: typeof o.time === 'string' ? o.time : null,
      allDay: o.allDay === true,
    };
  }

  // The one tool function. Inside a plan, args are already registry-
  // validated; a direct caller gets the service's own range check instead.
  function calendarUpcomingProjection({ service, db, args, todayIso }) {
    if (!service || typeof service.upcoming !== 'function') return { ok: false, summary: 'calendar_service_missing' };
    if (args !== undefined && !isPlainObject(args)) return { ok: false, summary: 'bad_request' };
    let r;
    try {
      r = service.upcoming(db, args || {}, todayIso);
    } catch (err) {
      return { ok: false, summary: 'calendar_service_error' };
    }
    if (!r || r.ok !== true) {
      const reason = r && typeof r.error === 'string' && r.error.length > 0 && r.error.length <= 64
        ? r.error
        : 'calendar_service_error';
      return { ok: false, summary: reason };
    }
    const occurrences = Array.isArray(r.occurrences) ? r.occurrences : [];
    const rowCap = Math.min(MAX_ROWS, occurrences.length);
    const rows = [];
    for (let i = 0; i < rowCap; i++) {
      const o = occurrences[i];
      rows.push(isPlainObject(o) ? trimRow(o) : { title: '', date: null, time: null, allDay: false });
    }
    let truncated = occurrences.length > rows.length;
    const unsupportedCount = typeof r.unsupportedCount === 'number' && Number.isFinite(r.unsupportedCount) ? r.unsupportedCount : 0;
    const calendars = Array.isArray(r.calendars) ? r.calendars.filter((c) => typeof c === 'string') : [];
    const envelope = { ok: true, rows, count: rows.length, truncated, unsupportedCount, calendars };
    while (byteLength(JSON.stringify(envelope), 'utf8') > MAX_BYTES && envelope.rows.length > 0) {
      envelope.rows.pop();
      envelope.count = envelope.rows.length;
      envelope.truncated = true;
    }
    return envelope;
  }

  // The step executor closure: the single call site of the tool function
  // inside a plan step, mirroring the driver's single-caller rule.
  function calendarUpcomingRun({ service, db, todayIso }) {
    if (!service || typeof service.upcoming !== 'function') {
      throw new TypeError('calendar_upcoming needs a calendar service');
    }
    if (typeof todayIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(todayIso)) {
      throw new TypeError('calendar_upcoming needs an ISO today date');
    }
    return function run(args) {
      return calendarUpcomingProjection({ service, db, args, todayIso });
    };
  }

  return { CALENDAR_UPCOMING_DEF, calendarUpcomingProjection, calendarUpcomingRun, MAX_ROWS, MAX_BYTES, MAX_TITLE };
});
