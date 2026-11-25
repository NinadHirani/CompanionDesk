'use strict';

const test = require('node:test');
const assert = require('node:assert');
const LocalDb = require('../src/db');
const G = require('../src/gradebook');

const SYLLABUS = [
  { title: 'Problem Set 1', due_date: '2026-11-03', category: 'Problem Sets', date_confidence: 'extracted' },
  { title: 'Problem Set 2', due_date: '2026-11-10', category: 'Problem Sets', date_confidence: 'extracted' },
  { title: 'Midterm exam', due_date: '2026-11-05', category: 'Midterm', date_confidence: 'extracted' },
];

async function seeded() {
  const db = await LocalDb.open();
  const c = db.upsertCourse({ name: 'Quantum Computing', code: 'CS402' });
  return { db, c };
}

const rows = (db, c) => db.all('SELECT * FROM assignments WHERE course_id = ? ORDER BY id', [c]);

test('a first import adds every assignment and reports the counts', async () => {
  const { db, c } = await seeded();
  const r = db.refreshCourseAssignments(c, SYLLABUS);
  assert.deepEqual(r, { added: 3, updated: 0, removed: 0 });
  assert.equal(rows(db, c).length, 3);
});

test('re-import updates matching titles in place and keeps their scores', async () => {
  const { db, c } = await seeded();
  db.refreshCourseAssignments(c, SYLLABUS);
  const mid = rows(db, c).find((r) => r.title === 'Midterm exam');
  G.setScore(db, { id: mid.id, score: 88 }, 'now');
  const r = db.refreshCourseAssignments(c, [
    { title: 'Problem Set 1', due_date: '2026-11-04', category: 'Problem Sets', date_confidence: 'extracted' },
    { title: 'Problem Set 2', due_date: '2026-11-10', category: 'Problem Sets', date_confidence: 'extracted' },
    { title: 'Midterm exam', due_date: '2026-11-12', category: 'Midterm', date_confidence: 'extracted' },
  ]);
  assert.deepEqual(r, { added: 0, updated: 3, removed: 0 });
  const after = rows(db, c);
  assert.equal(after.length, 3);
  assert.equal(after.find((r) => r.title === 'Midterm exam').id, mid.id, 'row id survives so the score survives');
  assert.equal(after.find((r) => r.title === 'Midterm exam').due_date, '2026-11-12');
  assert.equal(db.scoresForCourse(c)[mid.id], 88);
});

test('a deadline the user added by hand survives a re-import untouched', async () => {
  const { db, c } = await seeded();
  db.refreshCourseAssignments(c, SYLLABUS);
  const manualId = db.addAssignment(c, { title: 'Project viva', due_date: '2026-12-01', date_confidence: 'manual' });
  G.setScore(db, { id: manualId, score: 95 }, 'now');
  const r = db.refreshCourseAssignments(c, SYLLABUS.map((a) => ({ ...a, due_date: '2026-11-20' })));
  assert.deepEqual(r, { added: 0, updated: 3, removed: 0 });
  const manual = rows(db, c).find((r) => r.id === manualId);
  assert.ok(manual, 'manual row still there');
  assert.equal(manual.due_date, '2026-12-01', 'manual date not overwritten');
  assert.equal(db.scoresForCourse(c)[manualId], 95);
});

test('assignments the new syllabus drops are removed, hand-added ones stay', async () => {
  const { db, c } = await seeded();
  db.refreshCourseAssignments(c, SYLLABUS);
  const manualId = db.addAssignment(c, { title: 'Project viva', due_date: '2026-12-01', date_confidence: 'manual' });
  const r = db.refreshCourseAssignments(c, [
    { title: 'Problem Set 1', due_date: '2026-11-03', category: 'Problem Sets', date_confidence: 'extracted' },
    { title: 'Final exam', due_date: '2026-12-15', category: 'Final', date_confidence: 'extracted' },
  ]);
  assert.deepEqual(r, { added: 1, updated: 1, removed: 2 });
  const titles = rows(db, c).map((r) => r.title);
  assert.ok(titles.includes('Project viva'), 'hand-added deadline survives');
  assert.ok(!titles.includes('Midterm exam') && !titles.includes('Problem Set 2'), 'dropped syllabus rows are gone');
});

test('title matching ignores case and extra spaces', async () => {
  const { db, c } = await seeded();
  db.refreshCourseAssignments(c, SYLLABUS);
  const mid = rows(db, c).find((r) => r.title === 'Midterm exam');
  const r = db.refreshCourseAssignments(c, [
    { title: '  MIDTERM   exam ', due_date: '2026-11-06', category: 'Midterm', date_confidence: 'extracted' },
  ]);
  assert.deepEqual(r, { added: 0, updated: 1, removed: 2 });
  const after = rows(db, c);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, mid.id, 'same row matched across casing and spacing');
});
