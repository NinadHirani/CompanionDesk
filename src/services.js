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

module.exports = { getBrief, setDone, learningEnabled, editDeadline };
