'use strict';

// A grade the student can never fix is worse than one they can. Syllabus
// extraction sometimes puts an assignment in no category, or in one the
// syllabus never defined; the gradebook counts only categories the syllabus
// weights, so that row earns a score that never counts. This maps the row
// onto one of its course's real grading categories, or clears it back.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const LocalDb = require('../src/db');
const { reclassifyAssignment } = require('../src/services');

async function seeded() {
  const db = await LocalDb.open();
  const id = db.upsertCourse({ name: 'Data Structures', code: 'CS201' });
  db.setGradeWeights(id, [
    { category: 'Exam', weight_pct: 60 },
    { category: 'Lab', weight_pct: 40 },
  ]);
  const exam = db.addAssignment(id, { title: 'Midterm', due_date: '2026-12-01', category: 'Exam' });
  const stray = db.addAssignment(id, { title: 'Quiz 1', due_date: '2026-11-20', category: 'Quiz' });
  const uncategorized = db.addAssignment(id, { title: 'Project', due_date: null, category: null });
  return { db, id, exam, stray, uncategorized };
}

test('a mis-categorized row can be moved onto a real grading category', async () => {
  const { db, stray } = await seeded();
  const res = reclassifyAssignment(db, { id: stray, category: 'Lab' });
  assert.equal(res.ok, true);
  assert.equal(res.assignment.category, 'Lab');
  assert.equal(db.getAssignment(stray).category, 'Lab');
});

test('matching is case-insensitive and stores the syllabus spelling', async () => {
  const { db, stray } = await seeded();
  const res = reclassifyAssignment(db, { id: stray, category: '  exam ' });
  assert.equal(res.ok, true);
  assert.equal(res.assignment.category, 'Exam');
});

test('clearing a row puts it back to not counted', async () => {
  const { db, exam } = await seeded();
  const res = reclassifyAssignment(db, { id: exam, category: null });
  assert.equal(res.ok, true);
  assert.equal(res.assignment.category, null);
});

test('a category the syllabus never defined is refused, not invented', async () => {
  const { db, stray } = await seeded();
  assert.equal(reclassifyAssignment(db, { id: stray, category: 'Participation' }).error, 'category_unknown');
  assert.equal(reclassifyAssignment(db, { id: stray, category: '' }).ok, true, 'an empty value clears instead');
});

test('unknown and malformed ids are refused cleanly', async () => {
  const { db, stray } = await seeded();
  assert.equal(reclassifyAssignment(db, { id: 99999, category: 'Exam' }).error, 'not_found');
  assert.equal(reclassifyAssignment(db, { category: 'Exam' }).error, 'bad_request');
  assert.equal(reclassifyAssignment(db).error, 'bad_request');
});

test('both surfaces wire the category fix to one shared handler', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const grades = read('renderer/grades.js');
  assert.match(grades, /api\.assignment_setCategory\(/, 'the Grades view can fix a category');
  assert.match(grades, /not counted/, 'uncounted rows say so');
  assert.match(grades, /counted\(a\)/, 'counted rows keep their plain category line');
  const bridge = read('src/web/bridge.js');
  assert.match(bridge, /CompanionServices\.reclassifyAssignment\(/, 'the web/mobile build reuses the desktop handler');
  const errs = read('renderer/errors.js');
  assert.match(errs, /category_unknown:/, 'the refusal has plain wording');
  const channels = require('../src/ipc-channels');
  assert.ok(channels.IPC_CHANNELS.includes('assignment:setCategory'));
});
