'use strict';

// Gate 2 slice 4: ics tool tests. Pure text generation; no file, calendar
// app or network surface exists to test because none exists in the module.

const test = require('node:test');
const assert = require('node:assert');
const { createIcsGenerator, FOLD_OCTETS, utf8Octets, parseUtcInstant } = require('../src/agent-ics.js');

function gen() {
  return createIcsGenerator({ clock: () => 1_700_000_000_000 });
}

test('a valid event generates RFC-shaped VCALENDAR text with CRLF lines', () => {
  const r = gen().generateEvent({ summary: 'Team sync', start: '2026-12-01T10:00:00Z', durationMinutes: 90 });
  assert.equal(r.ok, true);
  const lines = r.ics.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines[lines.length - 2], 'END:VCALENDAR');
  assert.ok(r.ics.includes('DTSTART:2026-12-01T10:00:00Z'));
  assert.ok(r.ics.includes('DTEND:2026-12-01T11:30:00Z'), 'duration is converted to a DTEND');
  assert.ok(r.ics.includes('DTSTAMP:2023-11-14T22:13:20Z'));
  assert.ok(/^UID:cd-\d{8}T\d{6}-\d{6}@companiondesk\.local$/m.test(r.ics));
});

test('end or duration is required and validated', () => {
  const g = gen();
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-12-01T10:00:00Z' }).reason, 'end_or_duration_required');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-12-01T10:00:00Z', durationMinutes: 0 }).reason, 'duration_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-12-01T10:00:00Z', durationMinutes: 1441 }).reason, 'duration_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-12-01T10:00:00Z', end: '2026-12-01T09:00:00Z' }).reason, 'end_before_start');
});

test('summary, start, description and location are validated and nothing invalid is generated', () => {
  const g = gen();
  assert.equal(g.generateEvent({}).reason, 'summary_invalid');
  assert.equal(g.generateEvent({ summary: 'x' }).reason, 'start_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-12-01 10:00:00Z' }).reason, 'start_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-12-01T10:00:00Z', durationMinutes: 60, description: 7 }).reason, 'description_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-12-01T10:00:00Z', durationMinutes: 60, location: 'x'.repeat(201) }).reason, 'location_invalid');
});

test('TEXT escaping follows RFC 5545 3.3.11', () => {
  const r = gen().generateEvent({
    summary: 'a\\b;c,d',
    start: '2026-12-01T10:00:00Z',
    durationMinutes: 30,
    description: 'line one\nline two',
  });
  assert.ok(r.ics.includes('SUMMARY:a\\\\b\\;c\\,d'));
  assert.ok(r.ics.includes('DESCRIPTION:line one\\nline two'));
});

test('lines fold at 75 octets with a single leading space on continuations', () => {
  const long = 'x'.repeat(190); // inside the 200-char summary cap, still folds
  const r = gen().generateEvent({ summary: long, start: '2026-12-01T10:00:00Z', durationMinutes: 30 });
  const lines = r.ics.split('\r\n');
  assert.ok(lines.length > 6, 'the summary folded into several lines');
  for (const l of lines) {
    assert.ok(octetsOf(l) <= FOLD_OCTETS, 'no physical line exceeds 75 octets: ' + l.length);
    if (l.startsWith(' ') && !l.startsWith('BEGIN') && !l.startsWith('END')) {
      assert.equal(lines.indexOf(l) > 0, true);
    }
  }
  assert.ok(r.ics.replace(/\r\n /g, '').includes('SUMMARY:' + long), 'unfolding restores the full value');
});

function octetsOf(s) {
  let n = 0;
  for (const ch of s) n += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  return n;
}

test('impossible calendar dates are refused even when the shape is right', () => {
  const g = gen();
  // February 31: with a duration and with an explicit end.
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-02-31T10:00:00Z', durationMinutes: 30 }).reason, 'start_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-02-31T10:00:00Z', end: '2026-03-05T10:00:00Z' }).reason, 'start_invalid');
  // April 31, month 13, day 00, February 29 in a non-leap year.
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-04-31T10:00:00Z', durationMinutes: 30 }).reason, 'start_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-13-01T10:00:00Z', durationMinutes: 30 }).reason, 'start_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-01-00T10:00:00Z', durationMinutes: 30 }).reason, 'start_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-02-29T10:00:00Z', durationMinutes: 30 }).reason, 'start_invalid');
  // An impossible END is refused too, not parsed into another day.
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-03-01T10:00:00Z', end: '2026-03-31T23:60:00Z' }).reason, 'end_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-03-01T10:00:00Z', end: '2026-02-30T10:00:00Z' }).reason, 'end_invalid');
});

test('impossible clock components are refused; leap days and deep years are accepted', () => {
  const g = gen();
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-01-01T99:00:00Z', durationMinutes: 30 }).reason, 'start_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-01-01T10:60:00Z', durationMinutes: 30 }).reason, 'start_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-01-01T10:00:60Z', durationMinutes: 30 }).reason, 'start_invalid');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-01-01T24:00:00Z', durationMinutes: 30 }).reason, 'start_invalid');
  // Real calendar facts hold.
  assert.equal(g.generateEvent({ summary: 'x', start: '2028-02-29T10:00:00Z', durationMinutes: 30 }).ok, true, '2028 is a leap year');
  assert.equal(g.generateEvent({ summary: 'x', start: '2000-02-29T10:00:00Z', durationMinutes: 30 }).ok, true, '2000 is a leap year (divisible by 400)');
  assert.equal(g.generateEvent({ summary: 'x', start: '1900-02-29T10:00:00Z', durationMinutes: 30 }).reason, 'start_invalid', '1900 is NOT a leap year');
  assert.equal(parseUtcInstant('0001-01-01T00:00:00Z'), -62135596800000, 'year 0001 is a real instant, not 1901');
});

test('end must be a real instant strictly after start', () => {
  const g = gen();
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:00:00Z' }).reason, 'end_before_start');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-01-01T10:00:00Z', end: '2026-01-01T09:59:59Z' }).reason, 'end_before_start');
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:00:01Z' }).ok, true);
  // Cross-month arithmetic goes through instants, not string shapes.
  assert.equal(g.generateEvent({ summary: 'x', start: '2026-01-31T23:30:00Z', durationMinutes: 60 }).ok, true, 'a duration crossing midnight into February is fine');
});

test('utf8Octets counts code points exactly, including supplementary characters', () => {
  assert.equal(utf8Octets('a'), 1);
  assert.equal(utf8Octets('é'), 2);
  assert.equal(utf8Octets('€'), 3);
  assert.equal(utf8Octets('😀'), 4, 'a supplementary code point is 4 UTF-8 bytes, never 2');
  assert.equal(utf8Octets('a😀é€'), 1 + 4 + 2 + 3, 'mixed content sums exactly');
  assert.equal(utf8Octets('😀'.repeat(10)), 40);
  // The manual count agrees with the platform's own encoder where present.
  if (typeof TextEncoder !== 'undefined') {
    const enc = new TextEncoder();
    for (const sample of ['a😀é€', '🇮🇳 flag', 'nullbyte', '🎉'.repeat(20)]) {
      assert.equal(utf8Octets(sample), enc.encode(sample).length, JSON.stringify(sample));
    }
  }
});

test('emoji-heavy summaries fold at exact UTF-8 octets and unfold intact', () => {
  const emojis = '🎉'.repeat(60); // 240 UTF-8 bytes, inside the 200-char cap? 60 chars, fine
  const r = gen().generateEvent({ summary: emojis, start: '2026-12-01T10:00:00Z', durationMinutes: 30 });
  assert.equal(r.ok, true);
  const lines = r.ics.split('\r\n');
  for (const l of lines) {
    assert.ok(utf8Octets(l) <= FOLD_OCTETS, 'no physical line exceeds 75 UTF-8 bytes');
  }
  const unfolded = r.ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('SUMMARY:' + emojis), 'no emoji lost or split at a fold boundary');
});
