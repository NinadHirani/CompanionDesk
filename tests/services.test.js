'use strict';

const test = require('node:test');
const assert = require('node:assert');
const LocalDb = require('../src/db');
const { getBrief, setDone } = require('../src/services');

async function seeded() {
  const db = await LocalDb.open();
  const c = db.upsertCourse({ name: 'Quantum Computing', code: 'CS402' });
  const ps = db.addAssignment(c, { title: 'Problem set 4', due_date: '2026-11-04', category: 'Problem Sets' });
  db.addAssignment(c, { title: 'Midterm exam', due_date: '2026-11-05', category: 'Midterm' });
  db.addAssignment(c, { title: 'Project proposal', due_date: null, date_confidence: 'missing' });
  return { db, ps };
}

test('getBrief builds from the database with no network', async () => {
  const { db } = await seeded();
  const brief = getBrief(db, '2026-11-02');
  assert.deepEqual(brief.top.map((t) => t.title), ['Problem set 4', 'Midterm exam']);
  assert.deepEqual(brief.unconfirmed.map((u) => u.title), ['Project proposal']);
});

test('finished items leave the brief and come back when un-marked', async () => {
  const { db, ps } = await seeded();
  assert.equal(setDone(db, { id: ps, done: true }, '2026-11-01T09:00:00Z').ok, true);
  assert.deepEqual(getBrief(db, '2026-11-02').top.map((t) => t.title), ['Midterm exam']);
  assert.equal(setDone(db, { id: ps, done: false }, '2026-11-01T09:01:00Z').ok, true);
  assert.deepEqual(getBrief(db, '2026-11-02').top.map((t) => t.title), ['Problem set 4', 'Midterm exam']);
});

test('finishing an item logs a local event; un-marking withdraws it', async () => {
  const { db, ps } = await seeded();
  setDone(db, { id: ps, done: true }, '2026-11-01T09:00:00Z');
  const events = db.listEvents('assignment_done');
  assert.equal(events.length, 1);
  assert.equal(events[0].due_date, '2026-11-04');
  assert.equal(events[0].at, '2026-11-01T09:00:00Z');
  setDone(db, { id: ps, done: false }, '2026-11-01T09:01:00Z');
  assert.equal(db.listEvents().length, 0);
});

test('with activity learning off, nothing is logged', async () => {
  const { db, ps } = await seeded();
  db.setSetting('learn_from_activity', 'false');
  assert.equal(setDone(db, { id: ps, done: true }, '2026-11-01T09:00:00Z').ok, true);
  assert.equal(db.listEvents().length, 0);
});

test('bad requests are refused, not guessed', async () => {
  const { db } = await seeded();
  for (const payload of [null, {}, { id: '1', done: true }, { id: 1 }, { id: 1.5, done: true }, { id: 1, done: 'yes' }]) {
    assert.deepEqual(setDone(db, payload, '2026-11-01T09:00:00Z'), { ok: false, error: 'bad_request' });
  }
  assert.deepEqual(setDone(db, { id: 99999, done: true }, '2026-11-01T09:00:00Z'), { ok: false, error: 'not_found' });
});
