'use strict';

// Handler logic that main.js exposes over IPC, kept here so it can be tested
// without Electron. Every function takes the database (and the current time)
// as arguments: no globals, no clock, no network.

const { buildBrief } = require('./brief');
const { cleanLine } = require('./settings');
const { validIsoDate } = require('./extraction-core');

// The daily brief for `todayIso`, built from whatever is in the database.
function getBrief(db, todayIso) {
  return buildBrief(db.listBriefRows(), todayIso);
}

function learningEnabled(db) {
  return db.getSetting('learn_from_activity', 'true') === 'true';
}

// Mark an assignment done or pending. When activity learning is on, finishing
// an item is logged (local only) so patterns can be computed later; un-marking
// withdraws that log entry.
function setDone(db, payload, nowIso) {
  const id = payload && payload.id;
  const done = payload && payload.done;
  if (!Number.isInteger(id) || typeof done !== 'boolean') return { ok: false, error: 'bad_request' };

  const updated = db.setAssignmentStatus(id, done ? 'done' : 'pending');
  if (!updated) return { ok: false, error: 'not_found' };

  if (done && learningEnabled(db)) {
    db.addEvent({
      kind: 'assignment_done',
      assignment_id: id,
      course_id: updated.course_id,
      due_date: updated.due_date,
      at: nowIso,
    });
  } else if (!done) {
    db.removeEvents('assignment_done', id);
  }
  return { ok: true, assignment: updated };
}

// Edit a deadline the user added by hand. Same rules as adding one (a real
// date, not in the past, no duplicate), applied to the row being changed:
// the duplicate check excludes the row itself so saving an unchanged
// deadline is not refused. Only manual rows qualify; a syllabus owns the
// rest, and re-importing is how those change.
function editDeadline(db, payload, todayIso) {
  if (!payload || !Number.isInteger(payload.id)) return { ok: false, error: 'bad_request' };
  if (typeof payload.title !== 'string' || typeof payload.date !== 'string') return { ok: false, error: 'bad_request' };
  if (payload.isExam !== undefined && typeof payload.isExam !== 'boolean') return { ok: false, error: 'bad_request' };
  const title = cleanLine(payload.title, 120);
  if (!title) return { ok: false, error: 'empty_title' };
  if (!validIsoDate(payload.date)) return { ok: false, error: 'invalid_date' };
  if (payload.date < todayIso) return { ok: false, error: 'date_in_past' };

  const existing = db.getAssignment(payload.id);
  if (!existing) return { ok: false, error: 'not_found' };
  if (existing.date_confidence !== 'manual') return { ok: false, error: 'not_manual' };

  const same = db.all(
    "SELECT id FROM assignments WHERE date_confidence = 'manual' AND due_date = ? AND lower(title) = lower(?) AND id != ?",
    [payload.date, title, payload.id]
  );
  if (same.length) return { ok: false, error: 'duplicate' };

  const updated = db.updateManualAssignment(payload.id, {
    title,
    due_date: payload.date,
    category: payload.isExam ? 'Exam' : null,
  });
  if (!updated) return { ok: false, error: 'not_found' };
  return { ok: true, assignment: updated };
}

// ---- course management --------------------------------------------------
// Add, rename and remove courses by hand. Importing a syllabus creates
// courses too; this is for everything else (a course without a syllabus, a
// code typo, a course you dropped). The removal deletes everything that
// belongs to the course, so the UI confirms before calling it.

function validCreditHours(v) {
  return v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100);
}

function normalizeCourseInput({ name, code, credit_hours, term }) {
  return {
    name: cleanLine(name, 120),
    code: code ? cleanLine(code, 40) : null,
    credit_hours: credit_hours === undefined || credit_hours === null ? null : Number(credit_hours),
    term: term ? cleanLine(term, 60) : null,
  };
}

function addCourse(db, payload) {
  if (!payload) return { ok: false, error: 'bad_request' };
  if (payload.credit_hours !== undefined && payload.credit_hours !== null) {
    const n = Number(payload.credit_hours);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return { ok: false, error: 'invalid_credit_hours' };
  }
  const c = normalizeCourseInput(payload);
  if (!c.name) return { ok: false, error: 'course_name_empty' };
  if (!validCreditHours(c.credit_hours)) return { ok: false, error: 'invalid_credit_hours' };
  const dup = db.all(
    "SELECT id FROM courses WHERE name = ? AND IFNULL(code, '') = IFNULL(?, '')",
    [c.name, c.code]
  );
  if (dup.length) return { ok: false, error: 'duplicate' };
  return { ok: true, id: db.upsertCourse(c) };
}

function renameCourse(db, payload) {
  if (!payload || !Number.isInteger(payload.id)) return { ok: false, error: 'bad_request' };
  if (payload.credit_hours !== undefined && payload.credit_hours !== null) {
    const n = Number(payload.credit_hours);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return { ok: false, error: 'invalid_credit_hours' };
  }
  const c = normalizeCourseInput(payload);
  if (!c.name) return { ok: false, error: 'course_name_empty' };
  if (!validCreditHours(c.credit_hours)) return { ok: false, error: 'invalid_credit_hours' };
  if (!db.all('SELECT id FROM courses WHERE id = ?', [payload.id]).length) return { ok: false, error: 'not_found' };
  const dup = db.all(
    "SELECT id FROM courses WHERE name = ? AND IFNULL(code, '') = IFNULL(?, '') AND id != ?",
    [c.name, c.code, payload.id]
  );
  if (dup.length) return { ok: false, error: 'duplicate' };
  const updated = db.updateCourse(payload.id, c);
  if (!updated) return { ok: false, error: 'not_found' };
  return { ok: true, course: updated };
}

function removeCourse(db, payload) {
  if (!payload || !Number.isInteger(payload.id)) return { ok: false, error: 'bad_request' };
  const removed = db.removeCourse(payload.id);
  if (!removed) return { ok: false, error: 'not_found' };
  return { ok: true, removed };
}

// ---- grade category fix -------------------------------------------------
// An assignment the syllabus parser put in no category (or in one the
// syllabus never defined) earns a score that never counts: the gradebook
// only counts categories the syllabus weights. This maps a row onto one of
// its course's real grading categories, or clears it back to uncounted.

function sameCategory(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function reclassifyAssignment(db, payload) {
  if (!payload || !Number.isInteger(payload.id)) return { ok: false, error: 'bad_request' };
  const a = db.getAssignment(payload.id);
  if (!a) return { ok: false, error: 'not_found' };
  let category = null;
  if (payload.category !== undefined && payload.category !== null && String(payload.category).trim() !== '') {
    const weights = db.listGradeWeights(a.course_id);
    const match = weights.find((w) => sameCategory(w.category, payload.category));
    if (!match) return { ok: false, error: 'category_unknown' };
    category = match.category;
  }
  const updated = db.setAssignmentCategory(payload.id, category);
  if (!updated) return { ok: false, error: 'not_found' };
  return { ok: true, assignment: { id: updated.id, title: updated.title, category: updated.category } };
}

module.exports = { getBrief, setDone, learningEnabled, editDeadline, addCourse, renameCourse, removeCourse, reclassifyAssignment };
