'use strict';

const test = require('node:test');
const assert = require('node:assert');
const LocalDb = require('../src/db');
const G = require('../src/gradebook');

async function seeded() {
  const db = await LocalDb.open();
  const c = db.upsertCourse({ name: 'Quantum Computing', code: 'CS402' });
  db.setGradeWeights(c, [
    { category: 'Problem Sets', weight_pct: 20 },
    { category: 'Midterm', weight_pct: 30 },
    { category: 'Final', weight_pct: 50 },
  ]);
  const ps1 = db.addAssignment(c, { title: 'PS1', due_date: '2026-11-03', category: 'Problem Sets' });
  const ps2 = db.addAssignment(c, { title: 'PS2', due_date: '2026-11-10', category: 'Problem Sets' });
  const mid = db.addAssignment(c, { title: 'Midterm exam', due_date: '2026-11-05', category: 'Midterm' });
  return { db, c, ps1, ps2, mid };
}

test('scores are validated, stored, replaced and cleared', async () => {
  const { db, ps1 } = await seeded();
  assert.deepEqual(G.setScore(db, { id: ps1, score: 82.456 }, 'now'), { ok: true });
  assert.equal(db.scoresForCourse(1)[ps1], 82.46);
  assert.equal(G.setScore(db, { id: ps1, score: 90 }, 'now').ok, true);
  assert.equal(db.scoresForCourse(1)[ps1], 90);
  assert.deepEqual(G.setScore(db, { id: ps1, score: null }, 'now'), { ok: true });
  assert.deepEqual(db.scoresForCourse(1), {});
  for (const bad of [-1, 101, NaN, '90', undefined]) {
    assert.equal(G.setScore(db, { id: ps1, score: bad }, 'now').error, 'invalid_score', String(bad));
  }
  assert.equal(G.setScore(db, { id: 99999, score: 50 }, 'now').error, 'not_found');
  assert.equal(G.setScore(db, { id: 'x', score: 50 }, 'now').error, 'bad_request');
  assert.equal(G.setScore(db, null, 'now').error, 'bad_request');
});

test('standing and the needed score come out of stored data, per course', async () => {
  const { db, c, ps1, mid } = await seeded();
  G.setScore(db, { id: mid, score: 60 }, 'now');
  G.setScore(db, { id: ps1, score: 100 }, 'now');
  assert.deepEqual(G.setTarget(db, { courseId: c, target: 80 }), { ok: true });

  const course = G.getGrades(db).courses[0];
  assert.equal(course.standing.gradedWeight, 40); // midterm 30 + one of two problem sets (10)
  assert.equal(course.standing.earnedPoints, 28); // 18 + 10
  assert.equal(course.standing.currentPct, 70);
  assert.equal(course.target, 80);
  assert.deepEqual(course.projection, { status: 'needed', needed: 86.67, reachable: true });
  assert.equal(course.assignments.find((a) => a.id === mid).score, 60);
  assert.equal(course.assignments.find((a) => a.title === 'PS2').score, null);
});

test('targets are validated and can be cleared; no target means no projection', async () => {
  const { db, c } = await seeded();
  assert.equal(G.getGrades(db).courses[0].projection, null);
  assert.equal(G.setTarget(db, { courseId: c, target: 120 }).error, 'invalid_score');
  assert.equal(G.setTarget(db, { courseId: 999, target: 80 }).error, 'not_found');
  assert.equal(G.setTarget(db, { courseId: 'a', target: 80 }).error, 'bad_request');
  G.setTarget(db, { courseId: c, target: 85 });
  assert.equal(G.getGrades(db).courses[0].target, 85);
  G.setTarget(db, { courseId: c, target: null });
  assert.equal(G.getGrades(db).courses[0].target, null);
});

test('a course whose weights do not add up refuses to project', async () => {
  const db = await LocalDb.open();
  const c = db.upsertCourse({ name: 'Algorithms' });
  db.setGradeWeights(c, [{ category: 'Exams', weight_pct: 60 }]);
  const e = db.addAssignment(c, { title: 'E1', due_date: '2026-11-05', category: 'Exams' });
  G.setScore(db, { id: e, score: 90 }, 'now');
  G.setTarget(db, { courseId: c, target: 85 });
  const course = G.getGrades(db).courses[0];
  assert.equal(course.standing.weightsComplete, false);
  assert.deepEqual(course.projection, { status: 'cannot_project', reason: 'weights_incomplete' });
});

test('re-importing a syllabus clears that course scores instead of orphaning them', async () => {
  const { db, c, ps1 } = await seeded();
  G.setScore(db, { id: ps1, score: 90 }, 'now');
  db.clearAssignments(c);
  assert.equal(db.all('SELECT * FROM scores').length, 0);
});
