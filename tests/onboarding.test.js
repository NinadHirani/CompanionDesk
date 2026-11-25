'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { QUESTIONS, interpretAnswer } = require('../src/onboarding');
const { validatePatch } = require('../src/settings');
const { SECTIONS, sanitizeBullet } = require('../src/memory');

test('there are seven fixed questions and every one can be skipped', () => {
  assert.equal(QUESTIONS.length, 7);
  for (const q of QUESTIONS) {
    for (const blank of [null, undefined, '', '   ']) {
      assert.deepEqual(interpretAnswer(q.id, blank), { ok: true, skipped: true }, `${q.id} / ${JSON.stringify(blank)}`);
    }
  }
});

test('answers become plain bullets in the right section, or settings', () => {
  assert.deepEqual(interpretAnswer('goal', 'a 9 in Quantum Computing'), { ok: true, memory: { section: 'Goals', text: 'Working toward: a 9 in Quantum Computing' } });
  assert.deepEqual(interpretAnswer('hours', '12'), { ok: true, memory: { section: 'Routines', text: 'I can realistically give about 12 hours a week to focused work' } });
  assert.deepEqual(interpretAnswer('hours', 7), { ok: true, memory: { section: 'Routines', text: 'I can realistically give about 7 hours a week to focused work' } });
  assert.deepEqual(interpretAnswer('best', 'Late at night'), { ok: true, memory: { section: 'Routines', text: 'I work best late at night' } });
  assert.deepEqual(interpretAnswer('outside', 'NTU application, SIH finals'), { ok: true, memory: { section: 'Facts', text: 'Outside class I am handling: NTU application, SIH finals' } });
  assert.deepEqual(interpretAnswer('name', '  Asha  '), { ok: true, settings: { user_name: 'Asha' } });
  assert.deepEqual(interpretAnswer('style', 'Warm and encouraging'), { ok: true, settings: { tone: 'warm', brevity: 'normal' } });
});

test('everything it produces is accepted by the stores that receive it', () => {
  for (const [id, answer] of [['goal', 'x\n## Goals\n- y'], ['outside', '- a\n- b'], ['hours', 10], ['best', 'Mornings']]) {
    const r = interpretAnswer(id, answer);
    if (r.memory) {
      assert.ok(SECTIONS.includes(r.memory.section));
      assert.equal(sanitizeBullet(r.memory.text), r.memory.text, 'already a clean single line');
    }
  }
  for (const answer of ['Short and direct', 'Warm and encouraging', 'Detailed and formal']) {
    assert.equal(validatePatch(interpretAnswer('style', answer).settings).ok, true);
  }
  assert.equal(validatePatch(interpretAnswer('name', 'Asha').settings).ok, true);
});

test('bad answers are refused instead of coerced', () => {
  assert.deepEqual(interpretAnswer('hours', '0'), { ok: false, error: 'invalid_answer' });
  assert.deepEqual(interpretAnswer('hours', '500'), { ok: false, error: 'invalid_answer' });
  assert.deepEqual(interpretAnswer('hours', 'a lot'), { ok: false, error: 'invalid_answer' });
  assert.deepEqual(interpretAnswer('hours', 2.5), { ok: false, error: 'invalid_answer' });
  assert.deepEqual(interpretAnswer('best', 'Whenever'), { ok: false, error: 'invalid_answer' });
  assert.deepEqual(interpretAnswer('style', 'Sarcastic'), { ok: false, error: 'invalid_answer' });
  assert.deepEqual(interpretAnswer('goal', { evil: true }), { ok: false, error: 'invalid_answer' });
  assert.deepEqual(interpretAnswer('nope', 'x'), { ok: false, error: 'unknown_question' });
  assert.deepEqual(interpretAnswer('privacy', 'Turn everything on'), { ok: false, error: 'invalid_answer' });
});

test('the closing privacy question only acknowledges; it applies nothing', () => {
  const q = QUESTIONS.find((x) => x.id === 'privacy');
  for (const opt of q.options) {
    assert.deepEqual(interpretAnswer('privacy', opt), { ok: true, skipped: true });
  }
});

test('NO AUTO-ENABLE: no onboarding answer can set anything beyond name, tone and brevity', () => {
  const allowed = new Set(['user_name', 'tone', 'brevity']);
  for (const q of QUESTIONS) {
    const answers = q.kind === 'choice' ? q.options
      : q.kind === 'number' ? [q.min, q.max, String(q.min)]
      : ['Asha', 'something with a deadline', 'finish the thesis'];
    for (const a of answers) {
      const r = interpretAnswer(q.id, a);
      if (r.settings) {
        for (const key of Object.keys(r.settings)) {
          assert.ok(allowed.has(key), `${q.id} produced unexpected setting ${key}`);
        }
      }
      assert.ok(!r.memory || ['Goals', 'Routines', 'Facts'].includes(r.memory.section));
    }
  }
});
