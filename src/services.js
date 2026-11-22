'use strict';

// Handler logic that main.js exposes over IPC, kept here so it can be tested
// without Electron. Every function takes the database (and the current time)
// as arguments: no globals, no clock, no network.

const { buildBrief } = require('./brief');

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

module.exports = { getBrief, setDone, learningEnabled };
