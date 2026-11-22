'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { QUESTIONS, interpretAnswer } = require('../src/onboarding');
const { validatePatch } = require('../src/settings');
const { SECTIONS, sanitizeBullet } = require('../src/memory');

test('there are six fixed questions and every one can be skipped', () => {
  assert.equal(QUESTIONS.length, 6);
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
});
