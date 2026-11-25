'use strict';
// Onboarding's only two channels (answer, complete) are awaited with no
// try/catch anywhere: a bridge or transport crash throws an unhandled
// rejection, shows nothing, and strands the interview on the same question
// with zero feedback. Every other ask path in the app reports the failure
// in place and keeps state consistent; onboarding must do the same.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const s = fs.readFileSync('renderer/onboarding.js', 'utf8');

test('a failed answer call is reported in place and the interview stays put', () => {
  const i = s.indexOf('async function submit(');
  assert.ok(i > 0, 'submit exists');
  const chunk = s.slice(i, i + 700);
  assert.ok(chunk.includes('try {'), 'the answer call runs inside a try');
  assert.ok(chunk.includes('catch'), 'a thrown bridge error is caught, not an unhandled rejection');
});

test('a failed complete call is reported and never strands the view half-finished', () => {
  const i = s.indexOf('async function finish(');
  assert.ok(i > 0, 'finish exists');
  const chunk = s.slice(i, i + 900);
  assert.ok(chunk.includes('try {'), 'the complete call runs inside a try');
  assert.ok(chunk.includes('catch'), 'a thrown bridge error is caught');
  // The view only moves once completing actually succeeded.
  const showAt = chunk.indexOf("UI.show('ask')");
  const catchAt = chunk.indexOf('catch');
  assert.ok(showAt > catchAt, "UI.show('ask') is reachable only past the guard");
});

test('a retry after a failed completion re-runs the completion, not a phantom answer', () => {
  const i = s.indexOf('async function submit(');
  const chunk = s.slice(i, i + 900);
  const guardAt = chunk.indexOf('if (!q)');
  const answerAt = chunk.indexOf('onboarding_answer');
  assert.ok(guardAt > -1, 'submit guards the past-the-end case');
  assert.ok(guardAt < answerAt, 'the guard runs before any answer call');
  const finishAt = chunk.indexOf('await finish()', guardAt);
  assert.ok(finishAt > guardAt && finishAt < answerAt, 'the past-the-end retry finishes instead');
});
