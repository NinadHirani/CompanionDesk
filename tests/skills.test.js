'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LocalDb = require('../src/db');
const S = require('../src/skills');
const P = require('../src/personal');
const { DEFAULTS, normalizeSettings, validatePatch } = require('../src/settings');
const { rules, renderContextPack, buildPersona } = require('../src/persona');

const meFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-sk-')), 'me.md');

test('a fresh install has no active skills', async () => {
  const db = await LocalDb.open();
  const s = normalizeSettings(db.allSettings());
  assert.equal(s.student_module, 'auto');
  assert.equal(S.hasCourseData(db), false);
  assert.deepEqual(S.activeSkills(db, s), []);
});

test('hand-added deadlines do not switch the student skill on', async () => {
  const db = await LocalDb.open();
  P.addDeadline({ db }, { title: 'Grad application', date: '2026-11-20' }, '2026-11-02');
  assert.equal(db.listCourses().length, 1, 'a Personal course exists');
  assert.equal(S.hasCourseData(db), false);
  assert.deepEqual(S.activeSkills(db, normalizeSettings({})), []);
});

test('importing a course activates it, and the off switch overrides that', async () => {
  const db = await LocalDb.open();
  db.upsertCourse({ name: 'Quantum Computing' });
  assert.deepEqual(S.activeSkills(db, normalizeSettings({})), ['student']);
  const off = normalizeSettings({ student_module: 'off' });
  assert.equal(S.studentEnabled(off), false);
  assert.deepEqual(S.activeSkills(db, off), []);
});

test('student_module accepts only auto or off', () => {
  assert.equal(validatePatch({ student_module: 'off' }).ok, true);
  assert.equal(validatePatch({ student_module: 'auto' }).ok, true);
  assert.equal(validatePatch({ student_module: 'on' }).ok, false);
  assert.equal(normalizeSettings({ student_module: 'banana' }).student_module, 'auto');
});

test('general prompt: no student framing anywhere; student prompt keeps it', () => {
  const general = rules('Pal');
  assert.match(general, /personal assistant/);
  assert.ok(!/student|study|grade weight/i.test(general), general);
  assert.match(general, /Never make up a deadline, a date or a fact/);

  const student = rules('Pal', { student: true });
  assert.match(student, /study assistant/);
  assert.match(student, /About the student/);
  assert.match(student, /a grade weight/);
});

test('dates are written in full, with weekday and year', () => {
  for (const r of [rules('Pal'), rules('Pal', { student: true })]) {
    assert.match(r, /weekday and the year, like Wed Nov 4, 2026/);
  }
});

test('the context pack drops the Courses line when the student skill is off', () => {
  const args = { today: '2026-11-02', courses: [], due: [{ due_date: '2026-11-20', title: 'Application', course_name: 'Personal', date_confidence: 'manual' }] };
  assert.ok(!renderContextPack({ ...args, student: false }).includes('Courses:'));
  assert.match(renderContextPack({ ...args, student: false }), /- 2026-11-20 Application \(Personal\)/, 'deadlines are general and stay');
  assert.match(renderContextPack(args), /Courses: none imported yet\./, 'default is unchanged');
});

test('buildPersona labels the notes block to match the skill', () => {
  const pack = renderContextPack({ today: '2026-11-02', courses: [], due: [], student: false });
  const mem = [{ section: 'Goals', text: 'Run a half marathon' }];
  const g = buildPersona({ settings: DEFAULTS, memories: mem, contextPack: pack, question: 'plan my week' });
  assert.match(g.prompt, /About the user:/);
  assert.ok(!g.prompt.includes('About the student'));
  const s = buildPersona({ settings: DEFAULTS, memories: mem, contextPack: pack, skills: ['student'], question: 'plan my week' });
  assert.match(s.prompt, /About the student:/);
  assert.match(s.system, /study assistant/);
  assert.match(g.cloud.system, /personal assistant/);
  assert.ok(!g.cloud.prompt.includes('half marathon'));
});

test('ask on a fresh install gives the model a general assistant, not a student one', async () => {
  const db = await LocalDb.open();
  let seen = null;
  const ai = { complete: async (a) => { seen = a; return 'ok'; } };
  await P.ask({ db, ai, meFile: meFile() }, { prompt: 'Help me plan a trip to Pune' }, '2026-11-02');
  assert.ok(!/student|study/i.test(seen.system + seen.prompt), 'no student framing on a fresh install');
  assert.ok(!seen.prompt.includes('Courses:'));
  assert.match(seen.system, /personal assistant/);
});

test('ask turns the student framing on after an import, and off again with the switch', async () => {
  const db = await LocalDb.open();
  db.upsertCourse({ name: 'Quantum Computing', code: 'CS402' });
  const calls = [];
  const ai = { complete: async (a) => { calls.push(a); return 'ok'; } };
  const f = meFile();
  await P.ask({ db, ai, meFile: f }, { prompt: 'What is due?' }, '2026-11-02');
  assert.match(calls[0].system, /study assistant/);
  assert.match(calls[0].prompt, /Courses: Quantum Computing \(CS402\)/);
  P.saveSettings(db, { student_module: 'off' });
  await P.ask({ db, ai, meFile: f }, { prompt: 'What is due?' }, '2026-11-02');
  assert.ok(!/study assistant|Courses:/.test(calls[1].system + calls[1].prompt));
});
