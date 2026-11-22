'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LocalDb = require('../src/db');

test('schema and CRUD round-trip', async () => {
  const db = await LocalDb.open();
  const id = db.upsertCourse({ name: 'Quantum Computing', code: 'CS402', term: 'Fall 2026' });
  assert.equal(db.counts().courses, 1);

  db.setGradeWeights(id, [
    { category: 'Midterm', weight_pct: 30 },
    { category: 'Final', weight_pct: 40 },
    { category: 'Problem Sets', weight_pct: 30 },
  ]);
  assert.equal(db.listGradeWeights(id).length, 3);

  db.addAssignment(id, { title: 'Midterm exam', due_date: '2026-11-05', category: 'Midterm' });
  db.addAssignment(id, { title: 'Problem set 4', due_date: null, category: 'Problem Sets', date_confidence: 'ambiguous' });

  const due = db.listDue('2026-11-01', '2026-11-08');
  assert.equal(due.length, 1);
  assert.equal(due[0].title, 'Midterm exam');
  assert.equal(due[0].course_name, 'Quantum Computing');

  const undated = db.all("SELECT date_confidence FROM assignments WHERE due_date IS NULL");
  assert.equal(undated.length, 1);
  assert.equal(undated[0].date_confidence, 'ambiguous');

  // Re-importing the same course updates rather than duplicates.
  db.upsertCourse({ name: 'Quantum Computing', code: 'CS402', term: 'Fall 2026' });
  assert.equal(db.counts().courses, 1);
});

test('flush persists to disk and a reopened database sees the data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-test-'));
  const file = path.join(dir, 'data', 'localdesk.db');
  const db = await LocalDb.open({ file });
  db.upsertCourse({ name: 'Operating Systems', code: 'CS301' });
  db.flush();

  const reopened = await LocalDb.open({ file });
  assert.equal(reopened.counts().courses, 1);
  assert.equal(reopened.listCourses()[0].name, 'Operating Systems');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a database saved by an older schema gains new tables on open, data intact', async () => {
  const fs2 = require('node:fs');
  const os2 = require('node:os');
  const path2 = require('node:path');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  // Build a file that only has the original M1 tables, as an existing user would.
  const old = new SQL.Database();
  old.exec(`
    CREATE TABLE courses (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT, credit_hours REAL, term TEXT, source_file TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE grade_weights (id INTEGER PRIMARY KEY, course_id INTEGER, category TEXT NOT NULL, weight_pct REAL NOT NULL);
    CREATE TABLE assignments (id INTEGER PRIMARY KEY, course_id INTEGER, title TEXT NOT NULL, due_date TEXT, date_confidence TEXT DEFAULT 'extracted', category TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, assignment_id INTEGER, course_id INTEGER, title TEXT NOT NULL, due_date TEXT, done INTEGER DEFAULT 0, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO courses (name, code) VALUES ('Legacy Course', 'L100');
  `);
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'companiondesk-migrate-'));
  const file = path2.join(dir, 'old.db');
  fs2.writeFileSync(file, Buffer.from(old.export()));

  const db = await LocalDb.open({ file });
  assert.equal(db.listCourses().length, 1, 'existing data must survive');
  assert.equal(db.listCourses()[0].name, 'Legacy Course');
  // Tables introduced after the original schema must exist and be usable.
  db.setSetting('tone', 'warm');
  assert.equal(db.getSetting('tone'), 'warm');
});

test('mark done hides an item from due lists and the brief rows, and can be undone', async () => {
  const db = await LocalDb.open();
  const c = db.upsertCourse({ name: 'Algorithms' });
  const a = db.addAssignment(c, { title: 'Problem set 1', due_date: '2026-11-04', category: 'Problem Sets' });
  db.addAssignment(c, { title: 'Problem set 2', due_date: null, date_confidence: 'missing' });

  assert.equal(db.listDue('2026-11-01', '2026-11-08').length, 1);
  assert.equal(db.listBriefRows().length, 2);

  const done = db.setAssignmentStatus(a, 'done');
  assert.equal(done.status, 'done');
  assert.equal(db.listDue('2026-11-01', '2026-11-08').length, 0);
  assert.deepEqual(db.listBriefRows().map((r) => r.title), ['Problem set 2']);

  db.setAssignmentStatus(a, 'pending');
  assert.equal(db.listDue('2026-11-01', '2026-11-08').length, 1);

  assert.equal(db.setAssignmentStatus(99999, 'done'), null);
  assert.throws(() => db.setAssignmentStatus(a, 'finished'), /invalid_status/);
});

test('brief rows carry the course join and sort undated items last', async () => {
  const db = await LocalDb.open();
  const c = db.upsertCourse({ name: 'Quantum Computing' });
  db.addAssignment(c, { title: 'Undated', due_date: null, date_confidence: 'missing' });
  db.addAssignment(c, { title: 'Dated', due_date: '2026-11-04' });
  const rows = db.listBriefRows();
  assert.deepEqual(rows.map((r) => r.title), ['Dated', 'Undated']);
  assert.equal(rows[0].course_name, 'Quantum Computing');
  assert.equal(rows[0].date_confidence, 'extracted');
});

test('settings, activity events and memory proposals round-trip', async () => {
  const db = await LocalDb.open();
  assert.equal(db.getSetting('tone'), null);
  assert.equal(db.getSetting('tone', 'direct'), 'direct');
  db.setSetting('tone', 'warm');
  db.setSetting('tone', 'formal'); // overwrite, not duplicate
  db.setSetting('brevity', 'short');
  assert.deepEqual(db.allSettings(), { tone: 'formal', brevity: 'short' });

  db.addEvent({ kind: 'assignment_done', assignment_id: 1, course_id: 1, due_date: '2026-11-04', at: '2026-11-01T10:00:00Z' });
  db.addEvent({ kind: 'assignment_undone', assignment_id: 1, at: '2026-11-01T10:05:00Z' });
  assert.equal(db.listEvents().length, 2);
  assert.equal(db.listEvents('assignment_done').length, 1);
  db.clearEvents();
  assert.equal(db.listEvents().length, 0);

  const p = db.addProposal({ section: 'Goals', text: 'Aim for a 9+ in every course', created_at: '2026-11-01T10:00:00Z' });
  assert.equal(db.listProposals().length, 1);
  assert.equal(db.decideProposal(p, 'approved').status, 'approved');
  assert.equal(db.listProposals().length, 0);
  assert.equal(db.listProposals('approved').length, 1);
  // A decision is final: deciding again does not flip it.
  assert.equal(db.decideProposal(p, 'rejected').status, 'approved');
  assert.throws(() => db.decideProposal(p, 'maybe'), /invalid_status/);
});

test('only hand-added deadlines can be removed through removeManualAssignment', async () => {
  const db = await LocalDb.open();
  const c = db.upsertCourse({ name: 'Personal' });
  const manual = db.addAssignment(c, { title: 'Application', due_date: '2026-11-20', date_confidence: 'manual' });
  const extracted = db.addAssignment(c, { title: 'From a syllabus', due_date: '2026-11-21' });
  assert.equal(db.removeManualAssignment(extracted), false);
  assert.equal(db.getAssignment(extracted).title, 'From a syllabus');
  assert.equal(db.removeManualAssignment(manual), true);
  assert.equal(db.getAssignment(manual), null);
  assert.equal(db.removeManualAssignment(99999), false);
});

test('brief rows carry a grade weight only on an exact category match', async () => {
  const db = await LocalDb.open();
  const c = db.upsertCourse({ name: 'Quantum Computing' });
  const other = db.upsertCourse({ name: 'Algorithms' });
  db.setGradeWeights(c, [{ category: 'Midterm', weight_pct: 30 }, { category: 'Problem Sets', weight_pct: 20 }]);
  db.setGradeWeights(other, [{ category: 'Labs', weight_pct: 40 }]);
  db.addAssignment(c, { title: 'Midterm exam', due_date: '2026-11-05', category: 'midterm ' });
  db.addAssignment(c, { title: 'Quiz 1', due_date: '2026-11-06', category: 'Quizzes' });
  db.addAssignment(c, { title: 'No category', due_date: '2026-11-07' });
  db.addAssignment(c, { title: 'Wrong course weight', due_date: '2026-11-08', category: 'Labs' });
  const w = Object.fromEntries(db.listBriefRows().map((r) => [r.title, r.weight_pct]));
  assert.equal(w['Midterm exam'], 30, 'case and spacing are ignored');
  assert.equal(w['Quiz 1'], null, 'no matching category means no weight, not a guess');
  assert.equal(w['No category'], null);
  assert.equal(w['Wrong course weight'], null, "another course's weights are never used");
});
