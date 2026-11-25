'use strict';

// Course management by hand: add a course you have no syllabus for, fix a
// name or code, or remove one you dropped. The removal deletes everything
// that belongs to the course, so the handler reports exactly what went and
// the UI asks before calling it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const LocalDb = require('../src/db');
const { addCourse, renameCourse, removeCourse } = require('../src/services');

async function seeded() {
  const db = await LocalDb.open();
  const id = addCourse(db, { name: 'Quantum Computing', code: 'CS402', credit_hours: 4, term: 'Fall 2026' }).id;
  db.setGradeWeights(id, [{ category: 'Exam', weight_pct: 100 }]);
  const a1 = db.addAssignment(id, { title: 'PS1', due_date: '2026-12-01' });
  const a2 = db.addAssignment(id, { title: 'PS2', due_date: '2026-12-15' });
  db.setScore(a1, 80, '2026-12-02T00:00:00Z');
  db.setSetting('target_' + id, '90');
  db.addEvent({ kind: 'assignment_done', assignment_id: a1, course_id: id, due_date: '2026-12-01', at: '2026-12-01T00:00:00Z' });
  return { db, id, a1, a2 };
}

test('a course can be added by hand with code, credits and term', async () => {
  const db = await LocalDb.open();
  const res = addCourse(db, { name: 'Linear Algebra', code: 'MA201', credit_hours: 3, term: 'Winter 2027' });
  assert.equal(res.ok, true);
  const c = db.listCourses().find((x) => x.id === res.id);
  assert.equal(c.name, 'Linear Algebra');
  assert.equal(c.code, 'MA201');
  assert.equal(c.credit_hours, 3);
  assert.equal(c.term, 'Winter 2027');
});

test('adding refuses a duplicate name+code, an empty name and bad credits', async () => {
  const db = await LocalDb.open();
  addCourse(db, { name: 'Networks', code: 'CS350' });
  assert.equal(addCourse(db, { name: 'Networks', code: 'CS350' }).error, 'duplicate');
  assert.equal(addCourse(db, { name: 'Networks' }).ok, true, 'same name without a code is a different course');
  assert.equal(addCourse(db, { name: '   ' }).error, 'course_name_empty');
  assert.equal(addCourse(db, { name: 'X', credit_hours: 0 }).error, 'invalid_credit_hours');
  assert.equal(addCourse(db, { name: 'X', credit_hours: 'four' }).error, 'invalid_credit_hours');
  assert.equal(addCourse(db).error, 'bad_request');
});

test('a course can be renamed and re-coded', async () => {
  const { db, id } = await seeded();
  const res = renameCourse(db, { id, name: 'Quantum Computing II', code: 'CS502', term: 'Spring 2027' });
  assert.equal(res.ok, true);
  assert.equal(res.course.name, 'Quantum Computing II');
  assert.equal(res.course.code, 'CS502');
  assert.equal(res.course.term, 'Spring 2027');
  assert.equal(db.listCourses().find((c) => c.id === id).name, 'Quantum Computing II');
});

test('renaming refuses duplicates, an empty name and unknown ids', async () => {
  const db = await LocalDb.open();
  addCourse(db, { name: 'A' });
  const other = addCourse(db, { name: 'B' }).id;
  assert.equal(renameCourse(db, { id: other, name: 'A' }).error, 'duplicate');
  assert.equal(renameCourse(db, { id: other, name: 'B' }).ok, true, 'renaming to the same name is fine');
  assert.equal(renameCourse(db, { id: other, name: '  ' }).error, 'course_name_empty');
  assert.equal(renameCourse(db, { id: other, name: 'B2', credit_hours: -1 }).error, 'invalid_credit_hours');
  assert.equal(renameCourse(db, { id: 99999, name: 'X' }).error, 'not_found');
  assert.equal(renameCourse(db, { name: 'X' }).error, 'bad_request');
});

test('removing a course deletes everything that belongs to it and reports counts', async () => {
  const { db, id, a1, a2 } = await seeded();
  const res = removeCourse(db, { id });
  assert.equal(res.ok, true);
  assert.equal(res.removed.assignments, 2);
  assert.equal(db.listCourses().some((c) => c.id === id), false);
  assert.equal(db.getAssignment(a1), null);
  assert.equal(db.getAssignment(a2), null);
  assert.equal(db.scoresForCourse(id)[a1], undefined);
  assert.equal(db.listGradeWeights(id).length, 0);
  assert.equal(db.listEvents().length, 0, 'activity events for the course go too');
  assert.equal(db.getSetting('target_' + id), null, 'the saved grade target goes too');
});

test('removing leaves other courses untouched', async () => {
  const db = await LocalDb.open();
  const keep = addCourse(db, { name: 'Kept' }).id;
  const drop = addCourse(db, { name: 'Dropped' }).id;
  db.addAssignment(keep, { title: 'K1', due_date: '2026-12-01' });
  db.addAssignment(drop, { title: 'D1', due_date: '2026-12-02' });
  const res = removeCourse(db, { id: drop });
  assert.equal(res.ok, true);
  assert.equal(res.removed.assignments, 1);
  assert.equal(db.listAssignments(keep).length, 1);
  assert.equal(db.listCourses().find((c) => c.id === keep).name, 'Kept');
  assert.equal(removeCourse(db, { id: drop }).error, 'not_found', 'removing twice refuses cleanly');
  assert.equal(removeCourse(db).error, 'bad_request');
});

test('both surfaces wire course management to one shared handler set', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const app = read('renderer/app.js');
  assert.match(app, /api\.course_add\(/, 'the Courses card can add a course');
  assert.match(app, /api\.course_rename\(/, 'a course row can be edited inline');
  assert.match(app, /api\.course_remove\(/, 'a course row can be removed');
  assert.match(app, /This cannot be undone\./, 'the removal asks before it deletes');
  for (const f of ['renderer/index.html', 'web/index.html']) {
    assert.match(read(f), /id="course-add-btn"/, f + ' has the add-course form');
  }
  const bridge = read('src/web/bridge.js');
  assert.match(bridge, /CompanionServices\.addCourse\(/, 'the web/mobile build reuses the desktop handlers');
  assert.match(bridge, /course_add, course_rename, course_remove,/, 'the bridge exposes them');
  const errs = read('renderer/errors.js');
  assert.match(errs, /course_name_empty:/, 'the refusals have plain wording');
  assert.match(errs, /invalid_credit_hours:/);
  const channels = require('../src/ipc-channels');
  assert.ok(channels.IPC_CHANNELS.includes('course:add'));
  assert.ok(channels.IPC_CHANNELS.includes('course:rename'));
  assert.ok(channels.IPC_CHANNELS.includes('course:remove'));
});
