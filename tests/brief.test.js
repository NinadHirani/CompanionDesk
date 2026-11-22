'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const LocalDb = require('../src/db');
const { buildBrief, classify } = require('../src/brief');

// 2026-11-02 is a Monday.
const TODAY = '2026-11-02';

let nextId = 0;
function row(title, due_date, extra = {}) {
  nextId += 1;
  return {
    id: nextId,
    title,
    due_date,
    category: null,
    date_confidence: 'extracted',
    course_name: 'CS402',
    status: 'pending',
    ...extra,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// ---- exam vs deliverable ----------------------------------------------------

test('classify separates exams from deliverables', () => {
  const exams = [
    ['Midterm exam', null],
    ['Final Exam', 'Final'],
    ['Midterm 1', null],
    ['Final', null],
    ['Test 2', null],
    ['Lab practical exam', null],
    ['Unit 1-3 assessment', 'Midterm'],
  ];
  for (const [title, category] of exams) {
    assert.equal(classify({ title, category }), 'exam', `${title} should be an exam`);
  }

  const deliverables = [
    ['Problem set 4', 'Problem Sets'],
    ['Quiz 3', 'Quizzes'],
    ['Write unit tests', null],
    ['Hackathon contest entry', null],
    ['Midterm project', 'Midterm'],
    ['Final project presentation', 'Final'],
    ['Final report', 'Final'],
    ['Practice exam', null],
    ['Exam review session', 'Exams'],
    ['Midterm review', null],
  ];
  for (const [title, category] of deliverables) {
    assert.equal(classify({ title, category }), 'deliverable', `${title} should be a deliverable`);
  }
});

// ---- crunch detector --------------------------------------------------------

test('synthetic crunch week: three deliverables in seven days trips the warning', () => {
  const rows = [
    row('Problem set 4', '2026-11-03'),
    row('Lab 5', '2026-11-05'),
    row('Essay draft', '2026-11-06'),
  ];
  const brief = buildBrief(rows, TODAY);
  assert.equal(brief.crunch.length, 1);
  const c = brief.crunch[0];
  assert.equal(c.start, '2026-11-03');
  assert.equal(c.end, '2026-11-06');
  assert.equal(c.deliverables, 3);
  assert.equal(c.exams, 0);
  assert.deepEqual(c.triggers, ['deliverables']);
  assert.equal(c.items.length, 3);
});

test('two exams in seven days trips the warning; one exam does not', () => {
  const two = buildBrief([row('Physics midterm exam', '2026-11-05'), row('Chem exam', '2026-11-06')], TODAY);
  assert.equal(two.crunch.length, 1);
  assert.deepEqual(two.crunch[0].triggers, ['exams']);
  assert.equal(two.crunch[0].exams, 2);

  const one = buildBrief([row('Physics midterm exam', '2026-11-05')], TODAY);
  assert.deepEqual(one.crunch, []);
});

test('near misses do not trip the warning', () => {
  // Two deliverables plus one exam: neither threshold is met on its own.
  const mixed = buildBrief(
    [row('Problem set 4', '2026-11-03'), row('Lab 5', '2026-11-04'), row('Physics exam', '2026-11-05')],
    TODAY
  );
  assert.deepEqual(mixed.crunch, []);

  // Three deliverables, but spread so no seven-day window holds all three.
  const spread = buildBrief(
    [row('Problem set 4', '2026-11-03'), row('Lab 5', '2026-11-06'), row('Essay', '2026-11-11')],
    TODAY
  );
  assert.deepEqual(spread.crunch, []);
});

test('window boundary: dates 6 days apart share a window, 7 days apart do not', () => {
  // A window is 7 consecutive calendar days, so Nov 5 through Nov 11 fits.
  const inside = buildBrief([row('Exam A', '2026-11-05'), row('Exam B', '2026-11-11')], TODAY);
  assert.equal(inside.crunch.length, 1);

  const outside = buildBrief([row('Exam A', '2026-11-05'), row('Exam B', '2026-11-12')], TODAY);
  assert.deepEqual(outside.crunch, []);
});

test('both triggers can fire together', () => {
  const rows = [
    row('Problem set 4', '2026-11-03'),
    row('Lab 5', '2026-11-04'),
    row('Essay draft', '2026-11-05'),
    row('Physics midterm exam', '2026-11-05'),
    row('Chem exam', '2026-11-06'),
  ];
  const brief = buildBrief(rows, TODAY);
  assert.equal(brief.crunch.length, 1);
  assert.deepEqual(brief.crunch[0].triggers, ['deliverables', 'exams']);
  assert.equal(brief.crunch[0].deliverables, 3);
  assert.equal(brief.crunch[0].exams, 2);
});

test('overlapping windows merge into one stretch; distant ones stay separate', () => {
  const merged = buildBrief(
    [
      row('A1', '2026-11-03'), row('A2', '2026-11-04'), row('A3', '2026-11-05'),
      row('B1', '2026-11-09'), row('B2', '2026-11-10'), row('B3', '2026-11-11'),
    ],
    TODAY
  );
  assert.equal(merged.crunch.length, 1);
  assert.equal(merged.crunch[0].start, '2026-11-03');
  assert.equal(merged.crunch[0].end, '2026-11-11');
  assert.equal(merged.crunch[0].deliverables, 6);

  const separate = buildBrief(
    [
      row('A1', '2026-11-03'), row('A2', '2026-11-04'), row('A3', '2026-11-05'),
      row('C1', '2026-11-24'), row('C2', '2026-11-25'), row('C3', '2026-11-26'),
    ],
    TODAY
  );
  assert.equal(separate.crunch.length, 2);
  assert.equal(separate.crunch[0].start, '2026-11-03');
  assert.equal(separate.crunch[1].start, '2026-11-24');
});

test('crunch lookahead is bounded, and configurable', () => {
  const far = [row('F1', '2026-12-14'), row('F2', '2026-12-15'), row('F3', '2026-12-16')];
  assert.deepEqual(buildBrief(far, TODAY).crunch, []);
  assert.equal(buildBrief(far, TODAY, { crunchHorizonDays: 60 }).crunch.length, 1);
  // The top list is not limited by the crunch horizon.
  assert.equal(buildBrief(far, TODAY).top.length, 3);
});

// ---- top deadlines ----------------------------------------------------------

test('top deadlines: soonest first, deterministic ties, daysUntil, forward-looking only', () => {
  const rows = [
    row('Later item', '2026-11-10'),
    row('Zeta', '2026-11-04', { course_name: 'A' }),
    row('Alpha', '2026-11-04', { course_name: 'B' }),
    row('Yankee', '2026-11-04', { course_name: 'A' }),
    row('Due today', '2026-11-02'),
    row('Already past', '2026-11-01'),
    row('Finished', '2026-11-03', { status: 'done' }),
  ];
  const brief = buildBrief(rows, TODAY);
  assert.deepEqual(
    brief.top.map((t) => t.title),
    ['Due today', 'Yankee', 'Zeta']
  );
  assert.equal(brief.top[0].daysUntil, 0);
  assert.equal(brief.top[1].daysUntil, 2);
  assert.equal(buildBrief(rows, TODAY, { topN: 5 }).top.length, 5);
  assert.ok(!buildBrief(rows, TODAY, { topN: 10 }).top.some((t) => t.title === 'Already past' || t.title === 'Finished'));
});

// ---- unconfirmed dates (never invent a deadline) ----------------------------

test('unconfirmed items are reported but never used in top or crunch', () => {
  const rows = [
    row('No date', null, { date_confidence: 'missing' }),
    row('Empty date', '', { date_confidence: 'missing' }),
    row('Garbage date', '2026-13-45', { date_confidence: 'ambiguous' }),
    row('Flagged but dated', '2026-11-04', { date_confidence: 'ambiguous' }),
    row('Column not selected', '2026-11-04', { date_confidence: undefined }),
    row('Confirmed', '2026-11-09'),
  ];
  const brief = buildBrief(rows, TODAY);
  assert.deepEqual(brief.top.map((t) => t.title), ['Confirmed']);

  const byTitle = Object.fromEntries(brief.unconfirmed.map((u) => [u.title, u]));
  assert.equal(byTitle['No date'].reason, 'no-date');
  assert.equal(byTitle['Empty date'].reason, 'no-date');
  assert.equal(byTitle['Garbage date'].reason, 'invalid-date');
  assert.equal(byTitle['Flagged but dated'].reason, 'flagged');
  assert.equal(byTitle['Flagged but dated'].raw_date, '2026-11-04');
  assert.equal(byTitle['Column not selected'].reason, 'flagged');
  assert.equal(brief.unconfirmed.length, 5);
});

test('a flagged date does not complete a crunch week', () => {
  const rows = [
    row('Problem set 4', '2026-11-03'),
    row('Lab 5', '2026-11-04'),
    row('Maybe due', '2026-11-05', { date_confidence: 'ambiguous' }),
  ];
  const brief = buildBrief(rows, TODAY);
  assert.deepEqual(brief.crunch, []);
  assert.equal(brief.unconfirmed.length, 1);
});

// ---- purity -----------------------------------------------------------------

test('does not mutate its input and returns the same result for the same input', () => {
  const rows = deepFreeze([
    row('Problem set 4', '2026-11-03'),
    row('Lab 5', '2026-11-05'),
    row('Essay draft', '2026-11-06'),
    row('No date', null, { date_confidence: 'missing' }),
  ]);
  const first = buildBrief(rows, TODAY);
  const second = buildBrief(rows, TODAY);
  assert.deepEqual(first, second);
});

test('zero network: the brief path never touches fetch, http, https or net', () => {
  const http = require('node:http');
  const https = require('node:https');
  const net = require('node:net');
  const saved = {
    fetch: globalThis.fetch,
    httpRequest: http.request, httpGet: http.get,
    httpsRequest: https.request, httpsGet: https.get,
    connect: net.connect, createConnection: net.createConnection,
  };
  const trip = () => { throw new Error('network call attempted'); };
  globalThis.fetch = trip;
  http.request = trip; http.get = trip;
  https.request = trip; https.get = trip;
  net.connect = trip; net.createConnection = trip;
  try {
    const brief = buildBrief(
      [row('Problem set 4', '2026-11-03'), row('Lab 5', '2026-11-05'), row('Essay draft', '2026-11-06')],
      TODAY
    );
    assert.equal(brief.crunch.length, 1);
  } finally {
    globalThis.fetch = saved.fetch;
    http.request = saved.httpRequest; http.get = saved.httpGet;
    https.request = saved.httpsRequest; https.get = saved.httpsGet;
    net.connect = saved.connect; net.createConnection = saved.createConnection;
  }

  // The module may only depend on extraction-core, which is itself pure.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'brief.js'), 'utf8');
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['./extraction-core']);
});

test('rejects bad input loudly instead of guessing', () => {
  assert.throws(() => buildBrief('nope', TODAY), TypeError);
  assert.throws(() => buildBrief([], '2026-13-45'), TypeError);
  assert.throws(() => buildBrief([], undefined), TypeError);
  assert.throws(() => buildBrief([null], TODAY), TypeError);
  assert.throws(() => buildBrief([], TODAY, { topN: 0 }), RangeError);
  assert.throws(() => buildBrief([], TODAY, { windowDays: 'seven' }), RangeError);
});

// ---- real database rows -----------------------------------------------------

test('works on real rows from the database, including the course join', async () => {
  const db = await LocalDb.open();
  const qc = db.upsertCourse({ name: 'Quantum Computing', code: 'CS402', term: 'Fall 2026' });
  const algo = db.upsertCourse({ name: 'Algorithms', code: 'CS301', term: 'Fall 2026' });
  db.addAssignment(qc, { title: 'Problem set 4', due_date: '2026-11-04', category: 'Problem Sets' });
  db.addAssignment(qc, { title: 'Midterm exam', due_date: '2026-11-05', category: 'Midterm' });
  db.addAssignment(qc, { title: 'Problem set 5', due_date: null, category: 'Problem Sets', date_confidence: 'ambiguous' });
  db.addAssignment(algo, { title: 'Midterm 1', due_date: '2026-11-06', category: 'Midterm' });
  db.addAssignment(algo, { title: 'Lab 3', due_date: '2026-11-10', category: 'Labs' });

  const rows = db.all(
    `SELECT a.id, a.title, a.due_date, a.date_confidence, a.category, a.status, c.name AS course_name
     FROM assignments a JOIN courses c ON c.id = a.course_id`
  );
  const brief = buildBrief(rows, TODAY);

  assert.deepEqual(
    brief.top.map((t) => `${t.due_date} ${t.title} (${t.course})`),
    [
      '2026-11-04 Problem set 4 (Quantum Computing)',
      '2026-11-05 Midterm exam (Quantum Computing)',
      '2026-11-06 Midterm 1 (Algorithms)',
    ]
  );
  assert.equal(brief.crunch.length, 1);
  assert.deepEqual(brief.crunch[0].triggers, ['exams']);
  assert.deepEqual(brief.unconfirmed.map((u) => [u.title, u.reason]), [['Problem set 5', 'no-date']]);
});

test('upcoming lists every confirmed future item in order, and top is its prefix', () => {
  const rows = [
    row('C', '2026-11-20'), row('A', '2026-11-03'), row('B', '2026-11-09'), row('D', '2026-12-30'),
    row('Past', '2026-10-01'), row('Undated', null, { date_confidence: 'missing' }),
  ];
  const brief = buildBrief(rows, TODAY);
  assert.deepEqual(brief.upcoming.map((u) => u.title), ['A', 'B', 'C', 'D']);
  assert.deepEqual(brief.top, brief.upcoming.slice(0, 3));
});

test('a date the user typed in themselves is as trusted as one read from a syllabus', () => {
  const rows = [
    row('Grad school application', '2026-11-20', { date_confidence: 'manual', course_name: 'Personal' }),
    row('Problem set 4', '2026-11-03'),
  ];
  const brief = buildBrief(rows, TODAY);
  assert.deepEqual(brief.top.map((t) => t.title), ['Problem set 4', 'Grad school application']);
  assert.deepEqual(brief.unconfirmed, []);
});

test('items say whether the user added them by hand', () => {
  const brief = buildBrief([row('Application', '2026-11-20', { date_confidence: 'manual' }), row('Problem set', '2026-11-03')], TODAY);
  assert.deepEqual(brief.upcoming.map((u) => [u.title, u.manual]), [['Problem set', false], ['Application', true]]);
});

test('a typed-in item marked as an exam is an exam; the same category from a syllabus is judged by its title', () => {
  assert.equal(classify({ title: 'Practice exam', category: 'Exam', date_confidence: 'manual' }), 'exam');
  assert.equal(classify({ title: 'Practice exam', category: 'Exam', date_confidence: 'extracted' }), 'deliverable');
  assert.equal(classify({ title: 'Poster', category: null, date_confidence: 'manual' }), 'deliverable');
});

test('weight passes through only when it is a number', () => {
  const brief = buildBrief([row('A', '2026-11-03', { weight_pct: 30 }), row('B', '2026-11-04', { weight_pct: '30' }), row('C', '2026-11-05')], TODAY);
  assert.deepEqual(brief.upcoming.map((u) => u.weight_pct), [30, null, null]);
});
