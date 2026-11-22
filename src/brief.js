'use strict';

// Daily brief math: the next few confirmed deadlines, crunch-week detection,
// and a separate list of items whose dates cannot be trusted.
//
// Pure on purpose: no fs, no Electron, no database, no network, no clock. The
// caller passes rows and today's date, so everything here is deterministic
// and testable. The only dependency is extraction-core, so "what counts as a
// valid date" stays defined in one place.
//
// The hard rule from CLAUDE.md applies here too: never invent a deadline.
// Only a row with a valid ISO date AND a confirmed date_confidence ('extracted'
// from a syllabus, or 'manual' when the user typed it) is ever shown as a
// deadline or counted toward a crunch week. Anything else
// goes into `unconfirmed`, with the reason, and never into the math. A row
// that is missing date_confidence entirely is treated as unconfirmed (fail
// closed), since the column defaults to 'extracted' and a missing value means
// the caller did not select it.
//
// Forward-looking only: confirmed items dated before today are ignored, and
// rows with status 'done' are skipped. Nothing writes status yet.

const { validIsoDate, isConfirmedDate } = require('./extraction-core');

const DEFAULTS = Object.freeze({
  topN: 3,
  windowDays: 7, // a crunch window is this many consecutive calendar days
  minDeliverables: 3, // CLAUDE.md: >=3 deliverables in any 7-day window
  minExams: 2, // CLAUDE.md: >=2 exams in any 7-day window
  crunchHorizonDays: 28, // only look this far ahead for crunch weeks
});

const MS_PER_DAY = 86400000;

function dayNumber(iso) {
  return Math.round(Date.parse(iso + 'T00:00:00Z') / MS_PER_DAY);
}

function isoFromDay(day) {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

// ---- exam vs deliverable ----------------------------------------------------
// Category and title are free-form model text, so this is a conservative word
// match, not a taxonomy. Quizzes count as deliverables. Order matters:
//   1. practice / review / prep items are never exams
//   2. an explicit "exam" in the title is an exam
//   3. project/paper/report-style titles are deliverables ("Midterm project")
//   4. midterm in the title, a bare "Final" / "Test 2" title, or an exam-like
//      category is an exam
//   5. everything else is a deliverable
const PRACTICE = /\b(practice|mock|sample|review|prep|preparation|revision)\b/i;
const EXAM_IN_TITLE = /\b(exams?|examination)\b/i;
const DELIVERABLE_HINT = /\b(project|paper|report|presentation|assignment|essay|portfolio|lab|homework|problem sets?|poster|demo)\b/i;
const MIDTERM_IN_TITLE = /\bmid-?terms?\b/i;
const EXAM_TITLE_EXACT = /^\s*(finals?|test(\s*#?\d+)?)\s*$/i;
const EXAM_CATEGORY = /^\s*(exams?|midterms?|mid-?terms?|finals?|final exams?|tests?)\s*$/i;

function classify(row) {
  const title = row && row.title ? String(row.title) : '';
  const category = row && row.category ? String(row.category) : '';
  // Something the user typed in and marked as an exam is an exam, whatever the title says.
  if (row && row.date_confidence === 'manual' && /^exam$/i.test(category)) return 'exam';
  if (PRACTICE.test(title)) return 'deliverable';
  if (EXAM_IN_TITLE.test(title)) return 'exam';
  if (DELIVERABLE_HINT.test(title)) return 'deliverable';
  if (MIDTERM_IN_TITLE.test(title) || EXAM_TITLE_EXACT.test(title) || EXAM_CATEGORY.test(category)) return 'exam';
  return 'deliverable';
}

// ---- crunch detection -------------------------------------------------------

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareItems(a, b) {
  return a.day - b.day || cmpStr(a.course || '', b.course || '') || cmpStr(a.title, b.title) || a.index - b.index;
}

function toPublic(item, todayDay) {
  return {
    id: item.id,
    title: item.title,
    course: item.course,
    due_date: item.due_date,
    daysUntil: item.day - todayDay,
    kind: item.kind,
    manual: item.manual,
    weight_pct: item.weight_pct,
  };
}

// items must be sorted by day. A window is `windowDays` consecutive calendar
// days, so two items fit in one window when their dates differ by at most
// windowDays - 1. Any triggering window can be slid left until it starts on an
// item, so it is enough to try a window starting at each item's day.
function findCrunch(items, todayDay, o) {
  const windows = [];
  const starts = [...new Set(items.map((it) => it.day))];
  for (const start of starts) {
    const end = start + o.windowDays - 1;
    const inside = items.filter((it) => it.day >= start && it.day <= end);
    const deliverables = inside.filter((it) => it.kind === 'deliverable').length;
    const exams = inside.filter((it) => it.kind === 'exam').length;
    const triggers = [];
    if (deliverables >= o.minDeliverables) triggers.push('deliverables');
    if (exams >= o.minExams) triggers.push('exams');
    if (triggers.length) windows.push({ start, end, inside, triggers });
  }

  // Overlapping triggering windows describe one stretch of heavy days, so merge
  // them into a single warning. Windows that merely touch stay separate.
  const clusters = [];
  for (const w of windows) {
    const last = clusters[clusters.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      for (const it of w.inside) last.items.add(it);
      for (const t of w.triggers) last.triggers.add(t);
    } else {
      clusters.push({ end: w.end, items: new Set(w.inside), triggers: new Set(w.triggers) });
    }
  }

  return clusters.map((c) => {
    const members = [...c.items].sort(compareItems);
    return {
      start: members[0].due_date,
      end: members[members.length - 1].due_date,
      deliverables: members.filter((it) => it.kind === 'deliverable').length,
      exams: members.filter((it) => it.kind === 'exam').length,
      triggers: ['deliverables', 'exams'].filter((t) => c.triggers.has(t)),
      items: members.map((it) => toPublic(it, todayDay)),
    };
  });
}

// ---- public API -------------------------------------------------------------

function resolveOptions(opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  for (const key of Object.keys(DEFAULTS)) {
    if (!Number.isInteger(o[key]) || o[key] < 1) {
      throw new RangeError(`brief option ${key} must be a positive integer`);
    }
  }
  return o;
}

// rows: objects shaped like db.listDue() rows plus optional status, i.e.
//   { id, title, due_date, date_confidence, category, course_name, status }
// Returns:
//   today       the date the brief was built for
//   top         the next `topN` confirmed deadlines, soonest first
//   upcoming    every confirmed deadline from today on, soonest first
//   crunch      stretches that trip the crunch rule, soonest first
//   unconfirmed items that were NOT used: no date, invalid date, or flagged
function buildBrief(rows, todayIso, opts) {
  if (!Array.isArray(rows)) throw new TypeError('buildBrief: rows must be an array');
  if (!validIsoDate(todayIso)) throw new TypeError('buildBrief: todayIso must be a valid YYYY-MM-DD date');
  const o = resolveOptions(opts);
  const todayDay = dayNumber(todayIso);
  const horizonDay = todayDay + o.crunchHorizonDays;

  const upcoming = [];
  const unconfirmed = [];

  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') throw new TypeError(`buildBrief: row ${index} is not an object`);
    if (String(row.status || '').toLowerCase() === 'done') return;

    const title = row.title ? String(row.title) : '';
    const course = row.course_name ? String(row.course_name) : null;
    const raw = row.due_date === undefined || row.due_date === '' ? null : row.due_date;

    let reason = null;
    if (raw === null) reason = 'no-date';
    else if (!validIsoDate(raw)) reason = 'invalid-date';
    else if (!isConfirmedDate(row.date_confidence)) reason = 'flagged';

    if (reason) {
      unconfirmed.push({ id: row.id ?? null, title, course, reason, raw_date: raw === null ? null : String(raw) });
      return;
    }

    const day = dayNumber(raw);
    if (day < todayDay) return; // forward-looking only
    upcoming.push({ id: row.id ?? null, title, course, due_date: raw, day, kind: classify(row), manual: row.date_confidence === 'manual', weight_pct: typeof row.weight_pct === 'number' ? row.weight_pct : null, index });
  });

  upcoming.sort(compareItems);
  const publicUpcoming = upcoming.map((it) => toPublic(it, todayDay));

  return {
    today: todayIso,
    top: publicUpcoming.slice(0, o.topN),
    upcoming: publicUpcoming,
    crunch: findCrunch(upcoming.filter((it) => it.day <= horizonDay), todayDay, o),
    unconfirmed,
  };
}

module.exports = { buildBrief, classify, DEFAULTS };
