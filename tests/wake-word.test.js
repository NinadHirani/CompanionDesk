'use strict';

// M6 slice 4 tests: the wake-word subsystem policy and session machine.
// Fully deterministic: a fake clock, no engine, no audio anywhere in the
// API. No test asserts that a device hears anything; real-mic behavior is
// a physical-device question and stays unclaimed.
const test = require('node:test');
const assert = require('node:assert');
const {
  resolveWakePhrase, createWakeSession, clampThreshold,
  MIN_THRESHOLD, MAX_THRESHOLD, DEFAULT_THRESHOLD, MAX_NAME,
} = require('../src/wake-word');

test('the phrase is exactly "Hey " plus the configured companion name', () => {
  assert.deepStrictEqual(resolveWakePhrase({ assistantName: 'Nova' }),
    { ok: true, phrase: 'Hey Nova', name: 'Nova', modelId: 'hey-nova' });
  assert.deepStrictEqual(resolveWakePhrase({ assistantName: 'Jarvis' }).phrase, 'Hey Jarvis');
  // case folds and punctuation collapse only in the model id, never in the phrase
  assert.strictEqual(resolveWakePhrase({ assistantName: 'Nova-Alpha' }).modelId, 'hey-nova-alpha');
  // exotic names are refused, not smuggled into a spoken phrase
  assert.strictEqual(resolveWakePhrase({ assistantName: 'N0va!' }).ok, false);
});

test('phrase resolution refuses unsafe companion names', () => {
  assert.strictEqual(resolveWakePhrase({}).ok, false);
  assert.strictEqual(resolveWakePhrase({ assistantName: '' }).reason, 'no_companion_name');
  assert.strictEqual(resolveWakePhrase({ assistantName: '   ' }).reason, 'no_companion_name');
  assert.strictEqual(resolveWakePhrase({ assistantName: 'a'.repeat(MAX_NAME + 1) }).reason, 'name_too_long');
  assert.strictEqual(resolveWakePhrase({ assistantName: 'N0va!' }).reason, 'invalid_name');
  assert.strictEqual(resolveWakePhrase({ assistantName: '<script>' }).reason, 'invalid_name');
  assert.strictEqual(resolveWakePhrase({ assistantName: '   Nova' }).phrase, 'Hey Nova'); // trimmed
});

test('creating the session listens to nothing: no autoplay path exists', () => {
  const s = createWakeSession({ now: () => 0 });
  assert.strictEqual(s.state().phase, 'off');
  assert.strictEqual(s.state().micOpen, false);
  assert.strictEqual(s.isListening(), false);
});

test('start requires an explicit user action', () => {
  const s = createWakeSession({ now: () => 0 });
  const r = s.start({}, { enabled: true, modelReady: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'user_action_required');
  assert.strictEqual(s.state().phase, 'off');
});

test('start refuses while wake is disabled', () => {
  const s = createWakeSession({ now: () => 0 });
  const r = s.start({ userInitiated: true }, { enabled: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wake_disabled');
  assert.strictEqual(s.state().phase, 'off');
});

test('start refuses without a ready model for the configured phrase', () => {
  const s = createWakeSession({ now: () => 0 });
  let r = s.start({ userInitiated: true }, { enabled: true, modelReady: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wake_model_missing');
  r = s.start({ userInitiated: true }, { enabled: true, modelReady: false, modelReason: 'phrase_mismatch' });
  assert.strictEqual(r.reason, 'phrase_mismatch');
  assert.strictEqual(s.state().phase, 'off');
});

test('an explicit start opens the mic indicator and the score path', () => {
  const clock = { n: 0 };
  const s = createWakeSession({ now: () => clock.n });
  clock.n = 100;
  const r = s.start({ userInitiated: true }, { enabled: true, modelReady: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.state().phase, 'listening');
  assert.strictEqual(s.state().micOpen, true);
  assert.strictEqual(s.state().startedAt, 100);
  // scores below threshold are consumed without a detection
  const low = s.reportScore(0.2);
  assert.strictEqual(low.ok, true);
  assert.strictEqual(low.detected, false);
  assert.strictEqual(s.state().lastScore, 0.2);
  assert.strictEqual(s.state().micOpen, true);
  // a second start is refused
  assert.strictEqual(s.start({ userInitiated: true }, { enabled: true, modelReady: true }).reason, 'already_listening');
});

test('a score at or above threshold suspends listening exactly once', () => {
  const clock = { n: 0 };
  const s = createWakeSession({ now: () => clock.n });
  s.start({ userInitiated: true }, { enabled: true, modelReady: true });
  clock.n = 5000;
  const hit = s.reportScore(0.93);
  assert.strictEqual(hit.detected, true);
  assert.strictEqual(hit.score, 0.93);
  assert.strictEqual(hit.at, 5000);
  assert.strictEqual(s.state().phase, 'suspended');
  assert.strictEqual(s.state().micOpen, false); // the listener itself stops sampling
  assert.strictEqual(s.state().lastDetectionAt, 5000);
  // while suspended, scores are refused, not consumed
  assert.strictEqual(s.reportScore(0.9).reason, 'not_listening');
});

test('queryDone enters a caller-enforced cooldown that resumes only when due', () => {
  const clock = { n: 0 };
  const s = createWakeSession({ now: () => clock.n });
  s.start({ userInitiated: true }, { enabled: true, modelReady: true });
  clock.n = 1000;
  s.reportScore(0.9);
  assert.strictEqual(s.queryDone().ok, true);
  assert.strictEqual(s.state().phase, 'cooldown');
  assert.strictEqual(s.state().micOpen, false);
  clock.n = 2500; // inside the 2000 ms refractory
  assert.strictEqual(s.dueResume(), false);
  assert.strictEqual(s.resumeFromCooldown().reason, 'cooldown_active');
  clock.n = 3001; // past 1000 + 2000
  assert.strictEqual(s.dueResume(), true);
  assert.strictEqual(s.resumeFromCooldown().ok, true);
  assert.strictEqual(s.state().phase, 'listening');
  assert.strictEqual(s.state().micOpen, true);
  assert.strictEqual(s.state().lastScore, null);
});

test('pause and resume close and reopen the mic indicator', () => {
  const s = createWakeSession({ now: () => 0 });
  s.start({ userInitiated: true }, { enabled: true, modelReady: true });
  assert.strictEqual(s.pause().ok, true);
  assert.strictEqual(s.state().phase, 'paused');
  assert.strictEqual(s.state().micOpen, false);
  assert.strictEqual(s.reportScore(0.99).reason, 'not_listening');
  assert.strictEqual(s.resume().ok, true);
  assert.strictEqual(s.state().micOpen, true);
});

test('stop is the revocation and lands on off from every phase', () => {
  for (const setup of ['listening', 'suspended', 'paused', 'cooldown']) {
    const clock = { n: 0 };
    const s = createWakeSession({ now: () => clock.n });
    s.start({ userInitiated: true }, { enabled: true, modelReady: true });
    if (setup === 'suspended') s.reportScore(0.9);
    if (setup === 'paused') s.pause();
    if (setup === 'cooldown') { s.reportScore(0.9); s.queryDone(); }
    assert.strictEqual(s.stop().ok, true);
    assert.strictEqual(s.state().phase, 'off');
    assert.strictEqual(s.state().micOpen, false);
    assert.strictEqual(s.stop().ok, false); // already off
  }
});

test('out-of-range and malformed scores are refused, never clamped or stored', () => {
  const s = createWakeSession({ now: () => 0 });
  s.start({ userInitiated: true }, { enabled: true, modelReady: true });
  for (const bad of [-0.1, 1.01, '0.5', NaN, Infinity, null]) {
    assert.strictEqual(s.reportScore(bad).reason, 'bad_score');
  }
  assert.strictEqual(s.state().lastScore, null);
});

test('the threshold fails closed to the default outside [0.1, 0.9]', () => {
  assert.strictEqual(clampThreshold(0.5), 0.5);
  assert.strictEqual(clampThreshold(0.09), DEFAULT_THRESHOLD);
  assert.strictEqual(clampThreshold(0.91), DEFAULT_THRESHOLD);
  assert.strictEqual(clampThreshold('high'), DEFAULT_THRESHOLD);
  const s = createWakeSession({ now: () => 0, threshold: 0.9 });
  assert.strictEqual(s.state().threshold, 0.9);
  const t = createWakeSession({ now: () => 0, threshold: 99 });
  assert.strictEqual(t.state().threshold, DEFAULT_THRESHOLD);
  assert.ok(MIN_THRESHOLD < DEFAULT_THRESHOLD && DEFAULT_THRESHOLD < MAX_THRESHOLD);
});

test('the machine retains no audio and its state is frozen', () => {
  const s = createWakeSession({ now: () => 0 });
  s.start({ userInitiated: true }, { enabled: true, modelReady: true });
  s.reportScore(0.7);
  const st = s.state();
  assert.deepStrictEqual(Object.keys(st).sort(),
    ['elapsedMs', 'failure', 'lastDetectionAt', 'lastScore', 'listening', 'micOpen', 'phase', 'startedAt', 'threshold']);
  assert.strictEqual(Object.isFrozen(st), true);
  assert.strictEqual(st.audio, undefined);
  assert.strictEqual(st.frames, undefined);
});

test('session.fail records the reason and lands on off', () => {
  const ww = require('../src/wake-word.js');
  const s = ww.createWakeSession({ now: () => 1000 });
  const startGate = s.start({ userInitiated: true }, { enabled: true, phraseOk: true, modelReady: true });
  assert.strictEqual(startGate.ok, true);
  const r = s.fail('wake_listener_test_error');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.phase, 'off');
  assert.strictEqual(r.state.failure, 'wake_listener_test_error');
  // A second fail on an already-off session is refused honestly.
  assert.strictEqual(s.fail('again').ok, false);
});
