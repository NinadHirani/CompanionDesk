'use strict';

// Gate 2 slice 4: ics tool tests. Pure text generation; no file, calendar
// app or network surface exists to test because none exists in the module.

const test = require('node:test');
const assert = require('node:assert');
const { createIcsGenerator, FOLD_OCTETS } = require('../src/agent-ics.js');

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
