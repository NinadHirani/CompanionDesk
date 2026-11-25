'use strict';

// Editing a deadline you added by hand. The db boundary (manual-only) and the
// handler rules (a real date, not in the past, no duplicate) are the parts
// worth pinning: a syllabus owns extracted rows, and re-importing is the only
// way those change.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const LocalDb = require('../src/db');
const { editDeadline } = require('../src/services');

const TODAY = '2026-11-25';

function manual(db, title, date, isExam) {
  const course = db.upsertCourse({ name: 'Personal' });
  return db.addAssignment(course, {
    title, due_date: date, category: isExam ? 'Exam' : null, date_confidence: 'manual',
  });
}

function extracted(db, title, date) {
  const course = db.upsertCourse({ name: 'Quantum Computing' });
  return db.addAssignment(course, { title, due_date: date, date_confidence: 'extracted' });
}

test('a hand-added deadline can be edited in place', async () => {
  const db = await LocalDb.open();
  const id = manual(db, 'PS1 draft', '2026-12-01');
  const res = editDeadline(db, { id, title: 'PS1 final', date: '2026-12-04', isExam: true }, TODAY);
  assert.equal(res.ok, true);
  assert.equal(res.assignment.title, 'PS1 final');
  assert.equal(res.assignment.due_date, '2026-12-04');
  assert.equal(res.assignment.category, 'Exam');
  // Saved, not just returned: re-read from the store.
  assert.equal(db.getAssignment(id).title, 'PS1 final');
});

test('clearing the exam flag removes the category', async () => {
  const db = await LocalDb.open();
  const id = manual(db, 'Viva', '2026-12-02', true);
  const res = editDeadline(db, { id, title: 'Viva', date: '2026-12-02', isExam: false }, TODAY);
  assert.equal(res.ok, true);
  assert.equal(res.assignment.category, null);
});

test('an edit that changes nothing is not a duplicate of itself', async () => {
  const db = await LocalDb.open();
  const id = manual(db, 'Report', '2026-12-05');
  const res = editDeadline(db, { id, title: 'Report', date: '2026-12-05' }, TODAY);
  assert.equal(res.ok, true);
});

test('a real duplicate on the same date is refused', async () => {
  const db = await LocalDb.open();
  const a = manual(db, 'Essay', '2026-12-06');
  manual(db, 'Essay', '2026-12-06');
  const res = editDeadline(db, { id: a, title: 'Essay', date: '2026-12-06' }, TODAY);
  // The second row shares title and date, so saving the first collides.
  assert.equal(res.ok, false);
  assert.equal(res.error, 'duplicate');
});

test('validation matches adding a deadline', async () => {
  const db = await LocalDb.open();
  const id = manual(db, 'Lab', '2026-12-07');
  assert.equal(editDeadline(db, { id, title: '  ', date: '2026-12-08' }, TODAY).error, 'empty_title');
  assert.equal(editDeadline(db, { id, title: 'Lab', date: '2026-13-40' }, TODAY).error, 'invalid_date');
  assert.equal(editDeadline(db, { id, title: 'Lab', date: '2026-11-01' }, TODAY).error, 'date_in_past');
  assert.equal(editDeadline(db, { id, title: 'Lab', date: '2026-12-08', isExam: 'yes' }, TODAY).error, 'bad_request');
  assert.equal(editDeadline(db, { title: 'Lab', date: '2026-12-08' }, TODAY).error, 'bad_request');
  assert.equal(editDeadline(db, { id: 99999, title: 'Lab', date: '2026-12-08' }, TODAY).error, 'not_found');
});

test('a deadline extracted from a syllabus is never edited this way', async () => {
  const db = await LocalDb.open();
  const id = extracted(db, 'Assignment 1', '2026-12-09');
  const res = editDeadline(db, { id, title: 'Renamed', date: '2026-12-10' }, TODAY);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_manual');
  assert.equal(db.getAssignment(id).title, 'Assignment 1', 'the extracted row is untouched');
});

test('the database itself refuses to update a non-manual row', async () => {
  const db = await LocalDb.open();
  const id = extracted(db, 'Assignment 2', '2026-12-11');
  assert.equal(db.updateManualAssignment(id, { title: 'X', due_date: '2026-12-12', category: null }), null);
  assert.equal(db.getAssignment(id).title, 'Assignment 2');
});

test('both surfaces wire the edit path and share one handler', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const app = read('renderer/app.js');
  assert.match(app, /api\.deadline_edit\(/, 'the Today list can call the edit path');
  assert.match(app, /function editRow\(/, 'the row has an inline edit form');
  assert.match(app, /el\('button', 'Edit'\)/, 'hand-added rows offer Edit');
  const bridge = read('src/web/bridge.js');
  assert.match(bridge, /function deadline_edit\(/, 'the web/mobile build implements the edit path');
  assert.match(bridge, /CompanionServices\.editDeadline\(/, 'and reuses the desktop handler rather than a copy');
  assert.match(bridge, /deadline_add, deadline_remove, deadline_edit,/, 'the bridge exposes it');
  assert.match(read('renderer/errors.js'), /not_manual:/, 'the refusal has plain wording');
});
