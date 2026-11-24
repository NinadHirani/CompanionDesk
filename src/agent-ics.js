'use strict';

// Gate 2 slice 4: the first harmless tools. ics: a pure iCalendar (RFC 5545)
// VEVENT GENERATOR. It builds event text from validated fields and returns a
// string; it never writes a file, never touches a calendar application, and
// never sends anything. Saving the text somewhere real is the wiring layer's
// job and is a separate, explicitly-reviewed gate. Registry capability
// class: read_only (pure generation with no state), never sensitive.
//
// Documented scope: UTC times only (the Z form of RFC 5545 DATE-TIME); no
// recurrence rules, no timezones-by-id, no VALARM. Escaping follows RFC
// 5545 section 3.3.11 (backslash, semicolon, comma, newline); lines fold at
// 75 octets per section 3.1.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentIcs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_SUMMARY = 200;
  const MAX_DESCRIPTION = 500;
  const MAX_LOCATION = 200;
  const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  const FOLD_OCTETS = 75;

  function octets(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    // Fallback without TextEncoder: UTF-8 code units above 0x7F take 2 bytes
    // in the BMP range this module's validated fields can reach.
    let n = 0;
    for (const ch of s) n += ch.codePointAt(0) <= 0x7f ? 1 : 2;
    return n;
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
      const w = octets(ch);
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
        let endValue;
        if (end !== undefined) {
          if (typeof end !== 'string' || !ISO_UTC_RE.test(end)) return { ok: false, reason: 'end_invalid' };
          if (end <= start) return { ok: false, reason: 'end_before_start' };
          endValue = end;
        } else if (durationMinutes !== undefined) {
          if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) return { ok: false, reason: 'duration_invalid' };
          const ms = Date.parse(start) + durationMinutes * 60_000;
          if (Number.isNaN(ms)) return { ok: false, reason: 'start_invalid' };
          endValue = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
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

  return { createIcsGenerator, FOLD_OCTETS };
});
