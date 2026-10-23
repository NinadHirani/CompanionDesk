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
