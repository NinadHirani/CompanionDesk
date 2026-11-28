'use strict';

// Reliability pin for the speech-output machine: engine.speak can throw
// synchronously (the OS synthesizer can refuse an utterance outright).
// start() flips the phase to speaking before calling the engine, so an
// unguarded throw wedged the machine: isSpeaking() stayed true, no settle
// ever fired, and every later start was refused as already_speaking. The
// machine must fail closed instead, the same allowlisted way an engine
// error callback does, and a later start must work again.

const test = require('node:test');
const assert = require('node:assert');
const { createSpeechOutput } = require('../renderer/speech-output');

function boomEngine() {
  return { speak() { throw new Error('engine refused synchronously'); }, cancel() {} };
}

test('a synchronous engine failure fails closed instead of wedging speaking', () => {
  const settledCalls = [];
  const m = createSpeechOutput({
    engine: boomEngine(), enabled: () => true, now: () => 0,
    onSettled: (s) => settledCalls.push(s),
  });
  let res;
  assert.doesNotThrow(() => { res = m.start('hello', { userInitiated: true }); }, 'start must not throw');
  assert.equal(res.ok, false, 'start must fail closed');
  assert.equal(res.reason, 'synthesis_failed', 'the refusal must use the allowlisted failure code');
  assert.equal(m.isSpeaking(), false, 'the machine must not stay in the speaking phase');
  assert.equal(m.state().phase, 'failed');
  assert.equal(m.state().failure, 'synthesis_failed');
  assert.equal(settledCalls.length, 1, 'onSettled fires exactly once');
});

test('a start after a synchronous engine failure works again', () => {
  let throwing = true;
  const engine = { speak(t, h) { if (throwing) throw new Error('boom'); }, cancel() {} };
  const m = createSpeechOutput({ engine, enabled: () => true, now: () => 0 });
  m.start('first', { userInitiated: true });
  throwing = false;
  const res = m.start('second', { userInitiated: true });
  assert.equal(res.ok, true, 'a retry must not be refused as already_speaking');
  assert.equal(m.isSpeaking(), true);
});
