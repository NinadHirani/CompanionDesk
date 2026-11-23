'use strict';

const test = require('node:test');
const assert = require('node:assert');
const LocalDb = require('../src/db');
const C = require('../src/calendar');
const P = require('../src/personal');
const { renderCalendarBlock, buildPersona, renderContextPack } = require('../src/persona');
const { DEFAULTS } = require('../src/settings');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:1', 'SUMMARY:Quantum lecture', 'LOCATION:Hall 4', 'DTSTART:20261104T093000', 'DTEND:20261104T104500', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

test('import stores parsed events; re-importing the same file replaces, not duplicates', async () => {
  const db = await LocalDb.open();
  assert.deepEqual(C.importCalendar(db, { name: '/home/me/term.ics', text: ICS }, 'now'), { ok: true, name: 'term.ics', events: 1, skipped: 0 });
  C.importCalendar(db, { name: 'term.ics', text: ICS }, 'later');
  assert.equal(db.listCalendars().length, 1);
  assert.equal(db.listCalendars()[0].imported_at, 'later');
});

test('bad imports are refused with a reason', async () => {
  const db = await LocalDb.open();
  assert.equal(C.importCalendar(db, { name: 'x.ics', text: 'not a calendar' }, 'now').error, 'no_events');
  assert.equal(C.importCalendar(db, { name: 'x.ics' }, 'now').error, 'bad_request');
  assert.equal(C.importCalendar(db, null, 'now').error, 'bad_request');
  assert.equal(C.importCalendar(db, { name: 'x.ics', text: 'x'.repeat(C.MAX_BYTES + 1) }, 'now').error, 'file_too_large');
  assert.equal(db.listCalendars().length, 0);
});

test('upcoming expands repeats into the window and reports what it could not expand', async () => {
  const db = await LocalDb.open();
  C.importCalendar(db, { name: 'term.ics', text: ICS }, 'now');
  const r = C.upcoming(db, { days: 14 }, '2026-11-02');
  assert.deepEqual(r.occurrences.map((o) => [o.date, o.time, o.endTime]), [['2026-11-04', '09:30', '10:45'], ['2026-11-11', '09:30', '10:45']]);
  assert.deepEqual(r.calendars, ['term.ics']);
  assert.equal(C.upcoming(db, { days: 0 }, '2026-11-02').error, 'bad_request');
  assert.equal(C.upcoming(db, { days: 61 }, '2026-11-02').error, 'bad_request');
  assert.equal(C.upcoming(db, {}, '2026-11-02').ok, true, 'default is a week');
});

test('removing a calendar removes its events', async () => {
  const db = await LocalDb.open();
  C.importCalendar(db, { name: 'term.ics', text: ICS }, 'now');
  assert.deepEqual(C.removeCalendar(db, { name: 'term.ics' }), { ok: true });
  assert.deepEqual(C.removeCalendar(db, { name: 'term.ics' }), { ok: false, error: 'not_found' });
  assert.deepEqual(C.upcoming(db, {}, '2026-11-02').occurrences, []);
});

test('calendar block: readable lines, capped, empty when nothing is coming', () => {
  assert.equal(renderCalendarBlock([]), '');
  const block = renderCalendarBlock([
    { date: '2026-11-04', time: '09:30', endTime: '10:45', title: 'Quantum lecture', location: 'Hall 4', allDay: false },
    { date: '2026-11-05', time: null, title: 'Fest', location: null, allDay: true },
  ]);
  assert.equal(block, 'Calendar for the next 7 days:\n- 2026-11-04 09:30-10:45 Quantum lecture (Hall 4)\n- 2026-11-05 all day Fest');
  const many = Array.from({ length: 25 }, (_, i) => ({ date: '2026-11-04', time: '09:00', title: `E${i}`, allDay: false }));
  assert.match(renderCalendarBlock(many, { max: 20 }), /- and 5 more$/);
});

test('privacy: the calendar reaches the local prompt, never the cloud prompt', () => {
  const pack = renderContextPack({ today: '2026-11-02', courses: [], due: [] });
  const p = buildPersona({ settings: DEFAULTS, contextPack: pack, calendarBlock: 'Calendar for the next 7 days:\n- 2026-11-04 09:30 Dentist (Clinic)', question: 'What is on?' });
  assert.match(p.prompt, /Dentist/);
  assert.ok(p.cloud);
  assert.ok(!(p.cloud.system + p.cloud.prompt).includes('Dentist'));
  const opted = buildPersona({ settings: { ...DEFAULTS, cloud_personal: true }, contextPack: pack, calendarBlock: 'x', question: 'q' });
  assert.equal(opted.cloud, null);
});

test('ask includes imported calendar events in what the local model sees', async () => {
  const db = await LocalDb.open();
  const meFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-cal-')), 'me.md');
  C.importCalendar(db, { name: 'term.ics', text: ICS }, 'now');
  let seen = null;
  const ai = { completeRouted: async (a) => { seen = a; return 'ok'; } };
  await P.ask({ db, ai, meFile }, { prompt: 'What is on this week?' }, '2026-11-02');
  assert.match(seen.prompt, /2026-11-04 09:30-10:45 Quantum lecture \(Hall 4\)/);
  assert.ok(!(seen.cloudArgs.system + seen.cloudArgs.prompt).includes('Quantum lecture'));
});
