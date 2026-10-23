'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LocalDb = require('../src/db');
const vault = require('../src/vault');
const { parseDocument, validateExtraction, extractSyllabus, ingestSyllabus } = require('../src/ingest');

const FIXTURE = path.join(__dirname, 'fixtures', 'syllabus-sample.pdf');

// The fixture is a small hand-built PDF with no binary surprises, so it is
// regenerated from source on demand instead of being committed as a blob:
// `python3 scripts/make_fixture_pdf.py` is dependency-free.
function ensureFixture() {
  if (fs.existsSync(FIXTURE)) return;
  const { execFileSync } = require('node:child_process');
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  execFileSync('python3', [path.join(__dirname, '..', 'scripts', 'make_fixture_pdf.py')], { stdio: 'inherit' });
  if (!fs.existsSync(FIXTURE)) throw new Error('fixture regeneration failed: scripts/make_fixture_pdf.py did not produce ' + FIXTURE);
}
ensureFixture();

// A scripted provider: the extraction model is mocked, so tests run with no
// network and no Ollama. The fixture PDF is real, so the PDF path is live.
function mockAi(rawJson) {
  return { complete: async () => rawJson };
}

const CANNED = JSON.stringify({
  course: { name: 'Quantum Computing', code: 'CS402', credit_hours: 3, term: 'Fall 2026' },
  grade_weights: [
    { category: 'Midterm', weight_pct: 30 },
    { category: 'Final', weight_pct: 40 },
    { category: 'Problem Sets', weight_pct: 30 },
  ],
  assignments: [
    { title: 'Problem Set 1', due_date: '2026-08-12', category: 'Problem Sets' },
    { title: 'Problem Set 2', due_date: '2026-09-09', category: 'Problem Sets' },
    { title: 'Midterm exam', due_date: '2026-10-07', category: 'Midterm' },
    { title: 'Final project presentation', due_date: '2026-11-11', category: 'Final' },
    { title: 'Final exam', due_date: '2026-12-02', category: 'Final' },
    { title: 'Guest lecture on quantum networking', due_date: null, category: null },
  ],
});

test('the fixture PDF parses and the real text is readable', async () => {
  const { text } = await parseDocument(FIXTURE);
  assert.match(text, /Midterm exam/);
  assert.match(text, /Problem Set 1/);
  assert.match(text, /Fall 2026/);
});

test('validateExtraction flags ambiguity instead of guessing', () => {
  const result = validateExtraction({
    course: { name: 'X' },
    grade_weights: [{ category: 'Exams', weight_pct: 100 }],
    assignments: [
      { title: 'Quiz 1', due_date: '2026-13-45' },          // malformed -> flagged
      { title: 'Guest lecture', due_date: null },            // TBA -> missing
      { title: 'Homework 2', due_date: '2026-09-01' },       // clean
      { no_title: true },                                    // dropped
    ],
  }, { fallbackCourseName: 'fallback' });
  assert.equal(result.assignments.length, 3);
  assert.equal(result.assignments[0].due_date, null);
  assert.equal(result.assignments[0].date_confidence, 'ambiguous');
  assert.equal(result.assignments[1].date_confidence, 'missing');
  assert.equal(result.assignments[2].date_confidence, 'extracted');
  assert.equal(result.warnings.length, 3);
});

test('extractSyllabus strips code fences and tolerates surrounding prose', async () => {
  const ai = { complete: async () => 'Sure, here is the JSON:\n```json\n' + CANNED + '\n```\nLet me know!' };
  const out = await extractSyllabus({ text: 'syllabus text', ai, fallbackCourseName: 'x' });
  assert.equal(out.course.name, 'Quantum Computing');
  assert.equal(out.assignments.length, 6);
});

test('unparseable model output fails loudly, never silently invents', async () => {
  const ai = { complete: async () => 'I could not find any deadlines in this document.' };
  await assert.rejects(() => extractSyllabus({ text: 'x', ai }), /extraction_unparseable/);
});

test('ingestSyllabus end-to-end: pdf -> db -> markdown vault', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-ingest-'));
  try {
    const db = await LocalDb.open();
    const vaultDir = path.join(dir, 'vault');
    const summary = await ingestSyllabus({ file: FIXTURE, ai: mockAi(CANNED), db, vaultDir });

    assert.equal(summary.course, 'Quantum Computing');
    assert.equal(summary.assignments, 6);
    assert.equal(summary.flagged, 1); // the TBA guest lecture
    assert.ok(fs.existsSync(summary.classFile));
    assert.ok(fs.existsSync(summary.overviewFile));

    const classMd = fs.readFileSync(summary.classFile, 'utf8');
    assert.match(classMd, /# Quantum Computing/);
    assert.match(classMd, /Midterm exam/);
    assert.match(classMd, /flagged \(missing/);
    assert.match(classMd, /## Flags/);

    const overview = fs.readFileSync(summary.overviewFile, 'utf8');
    assert.match(overview, /Quantum Computing/);

    const dbCourse = db.listCourses()[0];
    assert.equal(dbCourse.name, 'Quantum Computing');
    const rows = db.listAssignments(dbCourse.id);
    assert.equal(rows.length, 6);
    assert.equal(rows.filter((r) => r.due_date).length, 5);
    const tba = rows.find((r) => r.title.includes('Guest lecture'));
    assert.equal(tba.due_date, null);

    // Deadlines land in the due window.
    const due = db.listDue('2026-10-01', '2026-10-31');
    assert.equal(due.length, 1);
    assert.equal(due[0].title, 'Midterm exam');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
