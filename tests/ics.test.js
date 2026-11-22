'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseIcs, expandEvents, zonedToUtcMs } = require('../src/ics');

const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

// A viewer in India (UTC+5:30), fixed so tests do not depend on the machine.
const IST = (ms) => {
  const d = new Date(ms + 5.5 * 3600000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
};
const UTC = IST.bind(null);
const utcParts = (ms) => ({ date: new Date(ms).toISOString().slice(0, 10), time: new Date(ms).toISOString().slice(11, 16) });

test('basic event: folded lines, escaped text, floating time', () => {
  const text = cal(ev('UID:a1', 'SUMMARY:Quantum lecture\\, room 4', 'LOCATION:Hall\\; North', 'DTSTART:20261104T093000', 'DTEND:20261104T104500',
    'DESCRIPTION:a very long line that is', ' folded onto the next one'));
  const { events } = parseIcs(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Quantum lecture, room 4');
  assert.equal(events[0].location, 'Hall; North');
  const { occurrences } = expandEvents(events, '2026-11-01', '2026-11-30');
  assert.deepEqual(occurrences.map((o) => [o.date, o.time, o.endTime]), [['2026-11-04', '09:30', '10:45']]);
});

test('all-day events, including multi-day spans (end date is exclusive)', () => {
  const { events } = parseIcs(cal(
    ev('UID:b1', 'SUMMARY:Fest', 'DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261108'),
    ev('UID:b2', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261120')
  ));
  const { occurrences } = expandEvents(events, '2026-11-01', '2026-11-30');
  assert.deepEqual(occurrences.map((o) => [o.date, o.title, o.allDay, o.time]), [
    ['2026-11-05', 'Fest', true, null], ['2026-11-06', 'Fest', true, null], ['2026-11-07', 'Fest', true, null], ['2026-11-20', 'Holiday', true, null],
  ]);
});

test('UTC times are shown on the viewer local day, even across midnight', () => {
  const { events } = parseIcs(cal(ev('UID:c1', 'SUMMARY:Late call', 'DTSTART:20261103T203000Z', 'DTEND:20261103T213000Z')));
  const { occurrences } = expandEvents(events, '2026-11-01', '2026-11-30', { localParts: IST });
  // 20:30 UTC is 02:00 the next morning in India.
  assert.deepEqual(occurrences.map((o) => [o.date, o.time, o.endTime]), [['2026-11-04', '02:00', '03:00']]);
});

test('TZID times convert correctly, including either side of a DST change', () => {
  // New York leaves daylight time on 2026-11-01.
  assert.equal(zonedToUtcMs({ y: 2026, m: 10, d: 30, hh: 9, mm: 0, ss: 0 }, 'America/New_York'), Date.UTC(2026, 9, 30, 13, 0, 0)); // EDT, UTC-4
  assert.equal(zonedToUtcMs({ y: 2026, m: 11, d: 4, hh: 9, mm: 0, ss: 0 }, 'America/New_York'), Date.UTC(2026, 10, 4, 14, 0, 0)); // EST, UTC-5
  assert.equal(zonedToUtcMs({ y: 2026, m: 11, d: 4, hh: 9, mm: 0, ss: 0 }, 'Not/AZone'), null);
});

test('a weekly series keeps its wall-clock time across a DST change', () => {
  const { events } = parseIcs(cal(ev('UID:d1', 'SUMMARY:Seminar', 'DTSTART;TZID=America/New_York:20261026T090000', 'RRULE:FREQ=WEEKLY;COUNT=3')));
  const { occurrences } = expandEvents(events, '2026-10-01', '2026-11-30', { localParts: utcParts });
  // Oct 26 is EDT (13:00 UTC); Nov 2 and Nov 9 are EST (14:00 UTC). 9am in New York every time.
  assert.deepEqual(occurrences.map((o) => [o.date, o.time]), [['2026-10-26', '13:00'], ['2026-11-02', '14:00'], ['2026-11-09', '14:00']]);
});

test('weekly BYDAY, INTERVAL, COUNT, UNTIL and EXDATE', () => {
  const byday = parseIcs(cal(ev('UID:e1', 'SUMMARY:Lecture', 'DTSTART:20261102T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5')));
  assert.deepEqual(expandEvents(byday.events, '2026-11-01', '2026-12-31').occurrences.map((o) => o.date),
    ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16']);

  const biweekly = parseIcs(cal(ev('UID:e2', 'SUMMARY:Lab', 'DTSTART:20261102T100000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261130T000000Z')));
  assert.deepEqual(expandEvents(biweekly.events, '2026-11-01', '2026-12-31').occurrences.map((o) => o.date), ['2026-11-02', '2026-11-16', '2026-11-30']);

  const skip = parseIcs(cal(ev('UID:e3', 'SUMMARY:Lecture', 'DTSTART:20261102T100000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE:20261109T100000')));
  assert.deepEqual(expandEvents(skip.events, '2026-11-01', '2026-12-31').occurrences.map((o) => o.date), ['2026-11-02', '2026-11-16', '2026-11-23']);
});

test('series that started before the window still expand into it; COUNT counts from the start', () => {
  const { events } = parseIcs(cal(ev('UID:f1', 'SUMMARY:Daily', 'DTSTART:20261020T080000', 'RRULE:FREQ=DAILY;COUNT=10')));
  // Oct 20..29 only; a window starting Oct 27 sees 27, 28, 29 and nothing after.
  assert.deepEqual(expandEvents(events, '2026-10-27', '2026-11-30').occurrences.map((o) => o.date), ['2026-10-27', '2026-10-28', '2026-10-29']);
});

test('monthly and yearly repeats', () => {
  const m = parseIcs(cal(ev('UID:g1', 'SUMMARY:Rent', 'DTSTART;VALUE=DATE:20261031', 'RRULE:FREQ=MONTHLY;COUNT=4')));
  // The 31st does not exist in November or February. RFC 5545 skips those months and they do not count toward COUNT.
  assert.deepEqual(expandEvents(m.events, '2026-10-01', '2027-03-31').occurrences.map((o) => o.date), ['2026-10-31', '2026-12-31', '2027-01-31', '2027-03-31']);
  const y = parseIcs(cal(ev('UID:g2', 'SUMMARY:Birthday', 'DTSTART;VALUE=DATE:20200229', 'RRULE:FREQ=YEARLY')));
  assert.deepEqual(expandEvents(y.events, '2026-01-01', '2028-12-31').occurrences.map((o) => o.date), ['2028-02-29']);
});

test('rules that cannot be expanded safely show once and are flagged, never silently dropped', () => {
  const { events } = parseIcs(cal(ev('UID:h1', 'SUMMARY:Second Tuesday', 'DTSTART:20261110T100000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU')));
  const r = expandEvents(events, '2026-11-01', '2027-02-28');
  assert.equal(r.unsupportedCount, 1);
  assert.deepEqual(r.occurrences.map((o) => o.date), ['2026-11-10']);
});

test('cancelled events are skipped and a moved occurrence replaces its slot', () => {
  const { events, skipped } = parseIcs(cal(
    ev('UID:i1', 'SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20261104T090000'),
    ev('UID:i2', 'SUMMARY:Lecture', 'DTSTART:20261102T100000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
    ev('UID:i2', 'SUMMARY:Lecture (moved)', 'RECURRENCE-ID:20261109T100000', 'DTSTART:20261110T150000')
  ));
  assert.equal(skipped, 1);
  const days = expandEvents(events, '2026-11-01', '2026-11-30').occurrences.map((o) => `${o.date} ${o.time} ${o.title}`);
  assert.deepEqual(days, ['2026-11-02 10:00 Lecture', '2026-11-10 15:00 Lecture (moved)', '2026-11-16 10:00 Lecture']);
});

test('alarms inside an event are ignored, and the window filters results', () => {
  const { events } = parseIcs(cal(ev('UID:j1', 'SUMMARY:Exam', 'DTSTART:20261105T090000', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM')));
  assert.equal(events[0].title, 'Exam');
  assert.equal(expandEvents(events, '2026-11-06', '2026-11-30').occurrences.length, 0);
  assert.equal(expandEvents(events, '2026-11-05', '2026-11-05').occurrences.length, 1);
});

test('garbage, empty input and invalid dates never throw', () => {
  for (const bad of ['', 'not a calendar', 'BEGIN:VEVENT\r\nEND:VEVENT', null, undefined]) {
    assert.deepEqual(parseIcs(bad).events, []);
  }
  const { events } = parseIcs(cal(ev('UID:k1', 'SUMMARY:Bad', 'DTSTART:20261345T090000'), ev('UID:k2', 'SUMMARY:No start')));
  assert.equal(events.length, 0);
  assert.deepEqual(expandEvents([], 'nope', 'nope'), { occurrences: [], unsupportedCount: 0 });
});

test('output is sorted by date, then time', () => {
  const { events } = parseIcs(cal(
    ev('UID:l1', 'SUMMARY:B', 'DTSTART:20261104T150000'), ev('UID:l2', 'SUMMARY:A', 'DTSTART:20261104T090000'), ev('UID:l3', 'SUMMARY:C', 'DTSTART:20261103T200000')
  ));
  assert.deepEqual(expandEvents(events, '2026-11-01', '2026-11-30').occurrences.map((o) => o.title), ['C', 'A', 'B']);
});

test('BYDAY lands on the right weekdays (2026-11-02 is a Monday)', () => {
  const { events } = parseIcs(cal(ev('UID:m1', 'SUMMARY:Gym', 'DTSTART:20261102T070000', 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH,SA;COUNT=4')));
  assert.deepEqual(expandEvents(events, '2026-11-01', '2026-11-30').occurrences.map((o) => o.date), ['2026-11-03', '2026-11-05', '2026-11-07', '2026-11-10']);
  const sun = parseIcs(cal(ev('UID:m2', 'SUMMARY:Call', 'DTSTART:20261101T180000', 'RRULE:FREQ=WEEKLY;COUNT=2')));
  assert.deepEqual(expandEvents(sun.events, '2026-11-01', '2026-11-30').occurrences.map((o) => o.date), ['2026-11-01', '2026-11-08']);
});
