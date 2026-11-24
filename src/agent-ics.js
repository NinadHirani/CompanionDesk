'use strict';

// Gate 2 slice 4: the first harmless tools. ics: a pure iCalendar (RFC 5545)
// VEVENT GENERATOR. It builds event text from validated fields and returns a
// string; it never writes a file, never touches a calendar application, and
// never sends anything. Saving the text somewhere real is the wiring layer's
// job and is a separate, explicitly-reviewed gate. Registry capability
// class: read_only (pure generation with no state), never sensitive.
//
// Documented scope: UTC times only (the Z form of RFC 5545 DATE-TIME); no
// recurrence rules, no timezones-by-id, no VALARM, and no leap seconds
// (seconds run 00-59). Date and time components are validated strictly:
// shape alone is never enough, because an impossible date (February 31,
// hour 99) must not parse into a different real instant. Escaping follows
// RFC 5545 section 3.3.11 (backslash, semicolon, comma, newline); lines
// fold at 75 octets per section 3.1, counted as exact UTF-8 bytes.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentIcs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_SUMMARY = 200;
  const MAX_DESCRIPTION = 500;
  const MAX_LOCATION = 200;
  const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
  const FOLD_OCTETS = 75;

  // Exact UTF-8 byte length, computed per code point: 1 byte below U+0080,
  // 2 below U+0800, 3 below U+10000, 4 for supplementary code points (emoji
  // and astral characters). No engine-specific fallback: the same exact
  // counting runs everywhere.
  function utf8Octets(s) {
    let n = 0;
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    return n;
  }

  // Strict UTC DATE-TIME validation. The regex checks shape only; every
  // calendar and clock component is then range-checked against the real
  // calendar (month length, leap years), so an impossible date is refused
  // instead of silently parsing into a different day. Returns the epoch
  // milliseconds of the instant, or null.
  function parseUtcInstant(value) {
    if (typeof value !== 'string') return null;
    const m = ISO_UTC_RE.exec(value);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);
    if (month < 1 || month > 12) return null;
    const dim = month === 2
      ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28)
      : (month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31);
    if (day < 1 || day > dim) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    // Date.UTC treats years 0-99 as 1900+year, so pin the year explicitly.
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const d = new Date(ms);
    d.setUTCFullYear(year);
    return d.getTime();
  }

  // RFC 5545 3.3.11 TEXT escaping, then 3.1 line folding at 75 octets with
  // a single leading space on continuation lines.
  function textLine(name, value) {
    const escaped = String(value)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
    return fold(name + ':' + escaped);
  }

  function fold(line) {
    const out = [];
    let cur = '';
    let curBytes = 0;
    for (const ch of line) {
      const w = utf8Octets(ch);
      if (curBytes + w > FOLD_OCTETS) {
        out.push(cur);
        cur = ' ' + ch;
        curBytes = 1 + w;
      } else {
        cur += ch;
        curBytes += w;
      }
    }
    out.push(cur);
    return out.join('\r\n');
  }

  function createIcsGenerator({ clock } = {}) {
    const now = clock || (() => Date.now());
    let seq = 0;

    return {
      // Generate one VCALENDAR holding exactly one VEVENT. Deterministic:
      // same inputs give the same text apart from DTSTAMP and UID.
      generateEvent({ summary, start, durationMinutes, end, description, location } = {}) {
        if (typeof summary !== 'string' || summary.length === 0 || summary.length > MAX_SUMMARY) return { ok: false, reason: 'summary_invalid' };
        if (typeof start !== 'string' || !ISO_UTC_RE.test(start)) return { ok: false, reason: 'start_invalid' };
        const startMs = parseUtcInstant(start);
        if (startMs === null) return { ok: false, reason: 'start_invalid' };
        let endValue;
        let endMs;
        if (end !== undefined) {
          endMs = parseUtcInstant(end);
          if (endMs === null) return { ok: false, reason: 'end_invalid' };
          if (endMs <= startMs) return { ok: false, reason: 'end_before_start' };
          endValue = end;
        } else if (durationMinutes !== undefined) {
          if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) return { ok: false, reason: 'duration_invalid' };
          endMs = startMs + durationMinutes * 60_000;
          endValue = new Date(endMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
        } else {
          return { ok: false, reason: 'end_or_duration_required' };
        }
        if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESCRIPTION)) return { ok: false, reason: 'description_invalid' };
        if (location !== undefined && (typeof location !== 'string' || location.length > MAX_LOCATION)) return { ok: false, reason: 'location_invalid' };

        seq += 1;
        const stamp = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const uid = 'cd-' + stamp.replace(/[-:]/g, '').replace('Z', '') + '-' + String(seq).padStart(6, '0') + '@companiondesk.local';
        const lines = [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//CompanionDesk//Gate2 1.0//EN',
          'CALSCALE:GREGORIAN',
          'BEGIN:VEVENT',
          'UID:' + uid,
          'DTSTAMP:' + stamp,
          'DTSTART:' + start,
          'DTEND:' + endValue,
        ];
        lines.push(...textLine('SUMMARY', summary).split('\r\n'));
        if (description !== undefined) lines.push(...textLine('DESCRIPTION', description).split('\r\n'));
        if (location !== undefined) lines.push(...textLine('LOCATION', location).split('\r\n'));
        lines.push('END:VEVENT', 'END:VCALENDAR');
        return { ok: true, ics: lines.join('\r\n') + '\r\n' };
      },
    };
  }

  return { createIcsGenerator, FOLD_OCTETS, utf8Octets, parseUtcInstant };
});
