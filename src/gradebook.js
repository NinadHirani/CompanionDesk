'use strict';

// Service layer for grades: enter a score, set a target, read standings.
// Takes the database and the clock as arguments, so it runs under test with
// no Electron.

const { courseStanding, neededForTarget } = require('./grades');

const targetKey = (courseId) => `target_${courseId}`;

function validScore(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}

// payload: { id, score } with score a number 0..100, or null to clear it.
function setScore(db, payload, nowIso) {
  if (!payload || !Number.isInteger(payload.id)) return { ok: false, error: 'bad_request' };
  if (!db.getAssignment(payload.id)) return { ok: false, error: 'not_found' };
  if (payload.score === null) {
    db.clearScore(payload.id);
    return { ok: true };
  }
  if (!validScore(payload.score)) return { ok: false, error: 'invalid_score' };
  db.setScore(payload.id, Math.round(payload.score * 100) / 100, nowIso);
  return { ok: true };
}

// payload: { courseId, target } with target 0..100, or null to clear it.
function setTarget(db, payload) {
  if (!payload || !Number.isInteger(payload.courseId)) return { ok: false, error: 'bad_request' };
  if (!db.listCourses().some((c) => c.id === payload.courseId)) return { ok: false, error: 'not_found' };
  if (payload.target === null) {
    db.run('DELETE FROM settings WHERE key = ?', [targetKey(payload.courseId)]);
    db.persist();
    return { ok: true };
  }
  if (!validScore(payload.target)) return { ok: false, error: 'invalid_score' };
  db.setSetting(targetKey(payload.courseId), String(payload.target));
  return { ok: true };
}

function getGrades(db) {
  const courses = db.listCourses().map((c) => {
    const weights = db.listGradeWeights(c.id);
    const assignments = db.listAssignments(c.id).map((a) => ({
      id: a.id, title: a.title, category: a.category, due_date: a.due_date, status: a.status,
    }));
    const scores = db.scoresForCourse(c.id);
    const standing = courseStanding({ weights, assignments, scores });
    const raw = db.getSetting(targetKey(c.id));
    const target = raw === null ? null : Number(raw);
    return {
      id: c.id,
      name: c.name,
      code: c.code,
      weights,
      assignments: assignments.map((a) => ({ ...a, score: scores[a.id] ?? null })),
      standing,
      target,
      projection: target === null ? null : neededForTarget(standing, target),
    };
  });
  return { ok: true, courses };
}

module.exports = { setScore, setTarget, getGrades };
