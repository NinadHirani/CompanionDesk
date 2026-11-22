'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LocalDb = require('../src/db');
const P = require('../src/personal');
const { getBrief, setDone } = require('../src/services');
const memory = require('../src/memory');

async function ctx() {
  const db = await LocalDb.open();
  const meFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-p-')), 'me.md');
  return { db, meFile };
}

test('settings save atomically and return the typed result', async () => {
  const { db } = await ctx();
  const r = P.saveSettings(db, { tone: 'warm', user_name: 'Asha' });
  assert.equal(r.ok, true);
  assert.equal(r.settings.tone, 'warm');
  assert.equal(P.getSettings(db).user_name, 'Asha');
  const bad = P.saveSettings(db, { tone: 'warm', brevity: 'nonsense' });
  assert.equal(bad.ok, false);
  assert.equal(P.getSettings(db).tone, 'warm', 'a refused patch changes nothing');
});

test('memory list, add and forget go through the about-me file', async () => {
  const c = await ctx();
  assert.equal(P.addMemory(c, { section: 'Goals', text: 'Aim for a 9' }).ok, true);
  assert.equal(P.addMemory(c, { section: 'Goals' }).error, 'bad_request');
  assert.deepEqual(P.listMemory(c).items, [{ section: 'Goals', text: 'Aim for a 9' }]);
  assert.equal(P.forgetMemory(c, { section: 'Goals', text: 'Aim for a 9' }).ok, true);
  assert.deepEqual(P.listMemory(c).items, []);
});

test('suggestions wait for approval; yes writes the line, no discards it', async () => {
  const c = await ctx();
  const MSG = 'I study best late at night and I prefer paper notes over laptops';
  const ai = {
    chat: async () => JSON.stringify([
      { section: 'Routines', text: 'I study best late at night' },
      { section: 'Preferences', text: 'I prefer paper notes over laptops' },
    ]),
  };
  const r = await P.suggest({ ...c, ai }, { message: MSG }, '2026-11-01T10:00:00');
  assert.equal(r.proposals.length, 2);
  assert.deepEqual(P.listMemory(c).items, [], 'nothing is remembered before the user says yes');

  const [first, second] = r.proposals;
  assert.equal(P.decide(c, { id: first.id, approve: true }).ok, true);
  assert.equal(P.decide(c, { id: second.id, approve: false }).ok, true);
  assert.deepEqual(P.listMemory(c).items, [{ section: 'Routines', text: 'I study best late at night' }]);
  assert.equal(P.listMemory(c).proposals.length, 0);
  assert.equal(P.decide(c, { id: first.id, approve: true }).error, 'already_decided');
  assert.equal(P.decide(c, { id: 99999, approve: true }).error, 'not_found');
  assert.equal(P.decide(c, { id: first.id, approve: 'yes' }).error, 'bad_request');
});

test('suggestions can be switched off, and are not repeated once pending', async () => {
  const c = await ctx();
  const MSG = 'I study best late at night and I prefer paper notes over laptops';
  let calls = 0;
  const ai = { chat: async () => { calls += 1; return JSON.stringify([{ section: 'Routines', text: 'I study best late at night' }]); } };
  await P.suggest({ ...c, ai }, { message: MSG }, 'now');
  await P.suggest({ ...c, ai }, { message: MSG }, 'now');
  assert.equal(c.db.listProposals().length, 1, 'same suggestion is not queued twice');

  P.saveSettings(c.db, { suggest_memories: false });
  const before = calls;
  await P.suggest({ ...c, ai }, { message: MSG }, 'now');
  assert.equal(calls, before, 'no model call when suggestions are off');
});

test('onboarding answers land in memory and settings; skipping and finishing work', async () => {
  const c = await ctx();
  assert.equal(P.getOnboarding(c.db).done, false);
  assert.equal(P.getOnboarding(c.db).questions.length, 6);
  assert.deepEqual(P.answerOnboarding(c, { id: 'name', answer: 'Asha' }), { ok: true, applied: 'settings' });
  assert.deepEqual(P.answerOnboarding(c, { id: 'goal', answer: 'a 9 in Quantum Computing' }), { ok: true, applied: 'memory' });
  assert.deepEqual(P.answerOnboarding(c, { id: 'hours', answer: '' }), { ok: true, applied: 'skipped' });
  assert.deepEqual(P.answerOnboarding(c, { id: 'style', answer: 'Warm and encouraging' }), { ok: true, applied: 'settings' });
  assert.equal(P.answerOnboarding(c, { id: 'hours', answer: 'a lot' }).error, 'invalid_answer');
  assert.equal(P.answerOnboarding(c, null).error, 'bad_request');
  assert.equal(P.getSettings(c.db).user_name, 'Asha');
  assert.equal(P.getSettings(c.db).tone, 'warm');
  assert.deepEqual(P.listMemory(c).items, [{ section: 'Goals', text: 'Working toward: a 9 in Quantum Computing' }]);
  // Answering the same question twice does not duplicate the line.
  assert.equal(P.answerOnboarding(c, { id: 'goal', answer: 'a 9 in Quantum Computing' }).ok, true);
  assert.equal(P.listMemory(c).items.length, 1);
  P.completeOnboarding(c.db);
  assert.equal(P.getOnboarding(c.db).done, true);
});

test('hand-added deadlines: validated, trusted, and removable', async () => {
  const { db } = await ctx();
  const today = '2026-11-02';
  assert.equal(P.addDeadline({ db }, { title: 'x' }, today).error, 'bad_request');
  assert.equal(P.addDeadline({ db }, { title: '   ', date: '2026-11-20' }, today).error, 'empty_title');
  assert.equal(P.addDeadline({ db }, { title: 'App', date: '2026-02-30' }, today).error, 'invalid_date');
  assert.equal(P.addDeadline({ db }, { title: 'App', date: '2026-10-01' }, today).error, 'date_in_past');

  const r = P.addDeadline({ db }, { title: 'Grad school application', date: '2026-11-20' }, today);
  assert.equal(r.ok, true);
  assert.equal(db.getAssignment(r.id).date_confidence, 'manual');
  assert.equal(db.getAssignment(r.id).course_name, 'Personal');
  assert.deepEqual(getBrief(db, today).top.map((t) => t.title), ['Grad school application']);

  assert.equal(P.removeDeadline({ db }, { id: r.id }).ok, true);
  assert.equal(P.removeDeadline({ db }, { id: r.id }).error, 'not_found');
  assert.equal(P.removeDeadline({ db }, { id: 'a' }).error, 'bad_request');
});

test('patterns come only from finished items, and clearing activity forgets them', async () => {
  const { db } = await ctx();
  const c = db.upsertCourse({ name: 'Algorithms' });
  for (let i = 0; i < 3; i++) {
    const id = db.addAssignment(c, { title: `PS ${i}`, due_date: '2026-11-10' });
    setDone(db, { id, done: true }, '2026-11-05T20:00:00');
  }
  const p = P.getPatterns(db);
  assert.equal(p.samples, 3);
  assert.equal(p.style, 'early');
  assert.equal(p.learning, true);
  assert.equal(p.summary, 'Usually finishes work about 5 days before it is due (from 3 items marked done).');
  P.clearActivity(db);
  assert.equal(P.getPatterns(db).summary, null);
  assert.equal(P.getPatterns(db).samples, 0);
});

test('ask: the local model gets the personal prompt, the cloud gets the minimal one', async () => {
  const c = await ctx();
  const course = c.db.upsertCourse({ name: 'Quantum Computing', code: 'CS402' });
  c.db.addAssignment(course, { title: 'Problem set 4', due_date: '2026-11-04' });
  P.saveSettings(c.db, { user_name: 'Asha', tone: 'warm' });
  P.addMemory(c, { section: 'Constraints', text: 'No studying on Sundays' });

  let seen = null;
  const ai = { complete: async (args) => { seen = args; return 'Problem set 4 is due Wed Nov 4.'; } };
  const r = await P.ask({ ...c, ai }, { prompt: 'What is due?' }, '2026-11-02');
  assert.deepEqual(r, { ok: true, answer: 'Problem set 4 is due Wed Nov 4.' });
  assert.match(seen.system, /friendly and encouraging/);
  assert.match(seen.prompt, /Name: Asha/);
  assert.match(seen.prompt, /No studying on Sundays/);
  assert.match(seen.prompt, /2026-11-04 Problem set 4 \(Quantum Computing\)/);
  assert.ok(seen.cloudArgs);
  assert.ok(!(seen.cloudArgs.system + seen.cloudArgs.prompt).includes('Asha'));
  assert.ok(!(seen.cloudArgs.system + seen.cloudArgs.prompt).includes('Sundays'));

  P.saveSettings(c.db, { cloud_personal: true });
  await P.ask({ ...c, ai }, { prompt: 'What is due?' }, '2026-11-02');
  assert.equal(seen.cloudArgs, undefined, 'explicit opt-in sends the same prompt');
});

test('ask: empty questions and model failures come back as errors, not exceptions', async () => {
  const c = await ctx();
  const ai = { complete: async () => { throw new Error('ollama_http_500'); } };
  assert.deepEqual(await P.ask({ ...c, ai }, { prompt: '   ' }, '2026-11-02'), { ok: false, error: 'empty_prompt' });
  assert.deepEqual(await P.ask({ ...c, ai }, {}, '2026-11-02'), { ok: false, error: 'empty_prompt' });
  assert.deepEqual(await P.ask({ ...c, ai }, { prompt: 'hi' }, '2026-11-02'), { ok: false, error: 'ollama_http_500' });
});

test('each person gets their own version: same schedule, different files, different prompts', async () => {
  const a = await ctx();
  const b = await ctx();
  for (const x of [a, b]) {
    const course = x.db.upsertCourse({ name: 'Algorithms' });
    x.db.addAssignment(course, { title: 'Lab 3', due_date: '2026-11-04' });
  }
  P.saveSettings(a.db, { user_name: 'Asha', brevity: 'short' });
  P.addMemory(a, { section: 'Goals', text: 'Get into a research lab' });
  P.saveSettings(b.db, { user_name: 'Ravi', language: 'Hindi' });
  P.addMemory(b, { section: 'Constraints', text: 'No studying on Sundays' });

  const seen = {};
  const spy = (key) => ({ complete: async (args) => { seen[key] = args; return 'ok'; } });
  await P.ask({ ...a, ai: spy('a') }, { prompt: 'What is due?' }, '2026-11-02');
  await P.ask({ ...b, ai: spy('b') }, { prompt: 'What is due?' }, '2026-11-02');
  assert.match(seen.a.prompt, /Asha/);
  assert.match(seen.a.prompt, /research lab/);
  assert.ok(!seen.a.prompt.includes('Ravi') && !seen.a.prompt.includes('Sundays'));
  assert.match(seen.b.system, /Reply in Hindi/);
  assert.match(seen.b.prompt, /Sundays/);
  assert.ok(!seen.b.prompt.includes('Asha') && !seen.b.prompt.includes('research lab'));
  assert.notEqual(seen.a.system, seen.b.system);
  assert.ok(memory.listMemories(a.meFile).length === 1 && memory.listMemories(b.meFile).length === 1);
});

test('hand-added deadlines: exact duplicates are refused, and "this is an exam" overrides the title guess', async () => {
  const { db } = await ctx();
  const today = '2026-11-02';
  assert.equal(P.addDeadline({ db }, { title: 'Poster for lab fair', date: '2026-11-08' }, today).ok, true);
  assert.equal(P.addDeadline({ db }, { title: '  poster FOR lab fair ', date: '2026-11-08' }, today).error, 'duplicate');
  assert.equal(P.addDeadline({ db }, { title: 'Poster for lab fair', date: '2026-11-09' }, today).ok, true, 'same title, different day is fine');
  assert.equal(P.addDeadline({ db }, { title: 'x', date: '2026-11-08', isExam: 'yes' }, today).error, 'bad_request');

  // "mock" would normally read as practice; the user says it is an exam.
  assert.equal(P.addDeadline({ db }, { title: 'GATE mock test', date: '2026-11-05', isExam: true }, today).ok, true);
  assert.equal(P.addDeadline({ db }, { title: 'Registered exam: GATE', date: '2026-11-06', isExam: true }, today).ok, true);
  const brief = getBrief(db, today);
  const byTitle = Object.fromEntries(brief.upcoming.map((u) => [u.title, u.kind]));
  assert.equal(byTitle['GATE mock test'], 'exam');
  assert.equal(byTitle['Registered exam: GATE'], 'exam');
  assert.equal(byTitle['Poster for lab fair'], 'deliverable');
  assert.equal(brief.crunch.length, 1);
  assert.deepEqual(brief.crunch[0].triggers, ['exams']);
});
