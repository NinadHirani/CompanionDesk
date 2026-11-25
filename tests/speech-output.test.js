'use strict';

// M6 slice 3 tests: the OS-native speech-output groundwork. Everything is
// deterministic: the engine under test is the module's own web_speech
// adapter driven against a fake speechSynthesis global, so no platform,
// audio device, or voice is involved in any test. No test asserts that
// speech was heard; nothing here can validate real audio on a device.
const test = require('node:test');
const assert = require('node:assert');
const {
  detectSpeech, webSpeechEngine, createSpeechOutput, ERROR_MAP, MAX_TEXT,
} = require('../renderer/speech-output');

// A fake browser global: speechSynthesis records every call, and each
// SpeechSynthesisUtterance captures its handlers so a test can fire them.
function fakeGlobal() {
  const calls = { speak: [], cancel: 0 };
  const synth = {
    speak(u) { calls.speak.push(u); },
    cancel() { calls.cancel += 1; },
  };
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; this.onend = null; this.onerror = null; }
  }
  return { calls, global: { speechSynthesis: synth, SpeechSynthesisUtterance } };
}

function machine({ enabled = () => true, now = () => 0, maxText } = {}) {
  const f = fakeGlobal();
  const engine = webSpeechEngine(f.global);
  const sp = createSpeechOutput({ engine, enabled, now, maxText });
  return { sp, ...f };
}

test('detectSpeech reports the runtime honestly', () => {
  assert.deepStrictEqual(detectSpeech(fakeGlobal().global), { available: true, voicesKnown: null });
  assert.strictEqual(detectSpeech({}).available, false);
  assert.strictEqual(detectSpeech({}).reason, 'no_synthesis_api');
  // synthesis API without the utterance constructor is still unsupported
  assert.strictEqual(detectSpeech({ speechSynthesis: { speak() {}, cancel() {} } }).available, false);
  assert.strictEqual(detectSpeech(null).available, false);
});

test('creating the machine never speaks: no autoplay path exists', () => {
  const { sp, calls } = machine();
  assert.strictEqual(calls.speak.length, 0);
  assert.strictEqual(sp.state().phase, 'idle');
  assert.strictEqual(sp.state().speaking, false);
  assert.strictEqual(calls.cancel, 0);
});

test('start refuses without the explicit user action, and never calls the engine', () => {
  const { sp, calls } = machine();
  const r = sp.start('hello', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'user_action_required');
  assert.strictEqual(calls.speak.length, 0);
});

test('start refuses while voice output is disabled, and never calls the engine', () => {
  const { sp, calls } = machine({ enabled: () => false });
  const r = sp.start('hello', { userInitiated: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'voice_output_disabled');
  assert.strictEqual(calls.speak.length, 0);
});

test('start refuses on a platform with no synthesis capability', () => {
  const sp = createSpeechOutput({ engine: null, enabled: () => true });
  const r = sp.start('hello', { userInitiated: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_synthesis_api');
});

test('start validates the text before anything is spoken', () => {
  const { sp, calls } = machine();
  assert.strictEqual(sp.start('   ', { userInitiated: true }).reason, 'empty_text');
  assert.strictEqual(sp.start(42, { userInitiated: true }).reason, 'empty_text');
  assert.strictEqual(sp.start('a'.repeat(MAX_TEXT + 1), { userInitiated: true }).reason, 'text_too_long');
  assert.strictEqual(calls.speak.length, 0);
});

test('an explicit start speaks once and reaches done through onend', () => {
  const clock = { n: 0 };
  const { sp, calls } = machine({ now: () => clock.n });
  clock.n = 100;
  const r = sp.start('good morning', { userInitiated: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sp.state().phase, 'speaking');
  assert.strictEqual(sp.isSpeaking(), true);
  assert.strictEqual(sp.state().elapsedMs, 0);
  assert.strictEqual(calls.speak.length, 1);
  assert.strictEqual(calls.speak[0].text, 'good morning');
  clock.n = 250;
  calls.speak[0].onend();
  assert.strictEqual(sp.state().phase, 'done');
  assert.strictEqual(sp.state().speaking, false);
  assert.strictEqual(sp.state().elapsedMs, 150);
});

test('a second start while speaking is refused and speaks nothing extra', () => {
  const { sp, calls } = machine();
  assert.strictEqual(sp.start('one', { userInitiated: true }).ok, true);
  const again = sp.start('two', { userInitiated: true });
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.reason, 'already_speaking');
  assert.strictEqual(calls.speak.length, 1);
});

test('stop cancels through the engine and ignores late engine callbacks', () => {
  const { sp, calls } = machine();
  sp.start('long answer', { userInitiated: true });
  const r = sp.stop();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.phase, 'cancelled');
  assert.strictEqual(calls.cancel, 1);
  // the engine's cancel-induced callbacks must not resurrect the session
  calls.speak[0].onend();
  calls.speak[0].onerror({ error: 'canceled' });
  assert.strictEqual(sp.state().phase, 'cancelled');
  assert.strictEqual(sp.state().failure, null);
  const again = sp.stop();
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.reason, 'nothing_speaking');
});

test('engine errors map through the allowlist; unknown names fail closed', () => {
  const { sp, calls } = machine();
  sp.start('x', { userInitiated: true });
  calls.speak[0].onerror({ error: 'canceled' });
  assert.strictEqual(sp.state().phase, 'failed');
  assert.strictEqual(sp.state().failure, 'cancelled');

  const b = machine();
  b.sp.start('x', { userInitiated: true });
  b.calls.speak[0].onerror({ error: 'synthesis-failed' });
  assert.strictEqual(b.sp.state().failure, 'synthesis_failed');

  const c = machine();
  c.sp.start('x', { userInitiated: true });
  c.calls.speak[0].onerror({ error: 'some_new_platform_error' });
  assert.strictEqual(c.sp.state().failure, 'synthesis_failed');

  const d = machine();
  d.sp.start('x', { userInitiated: true });
  d.calls.speak[0].onerror({});
  assert.strictEqual(d.sp.state().failure, 'synthesis_failed');
});

test('the machine retains no text or utterance in its state', () => {
  const { sp, calls } = machine();
  sp.start('a private answer nobody stores', { userInitiated: true });
  const s = sp.state();
  assert.deepStrictEqual(Object.keys(s).sort(),
    ['elapsedMs', 'failure', 'phase', 'speaking', 'startedAt']);
  assert.strictEqual(s.text, undefined);
  assert.strictEqual(Object.isFrozen(s), true);
  // and the adapter handed the engine the text only through its call
  assert.strictEqual(calls.speak[0].text, 'a private answer nobody stores');
});

test('the adapter wires exactly onend and onerror and sets no presentation properties', () => {
  const f = fakeGlobal();
  const engine = webSpeechEngine(f.global);
  const seen = [];
  engine.speak('hi', { onEnd: () => seen.push('end'), onError: () => seen.push('error') });
  const u = f.calls.speak[0];
  assert.strictEqual(u.text, 'hi');
  assert.strictEqual(typeof u.onend, 'function');
  assert.strictEqual(typeof u.onerror, 'function');
  // OS defaults own the output: the adapter must not set voice, rate, pitch, or volume
  assert.strictEqual(u.rate, undefined);
  assert.strictEqual(u.pitch, undefined);
  assert.strictEqual(u.volume, undefined);
  assert.strictEqual(u.voice, undefined);
  u.onend(); u.onerror({ error: 'audio-busy' });
  assert.deepStrictEqual(seen, ['end', 'error']);
});

test('the error map stays an allowlist of machine failure codes', () => {
  const allowed = new Set(['cancelled', 'speech_interrupted', 'synthesis_failed',
    'synthesis_unavailable', 'audio_busy', 'audio_hardware', 'synthesis_not_allowed',
    'voice_unavailable', 'text_too_long', 'bad_request']);
  for (const code of Object.values(ERROR_MAP)) assert.ok(allowed.has(code), code);
  assert.strictEqual(Object.keys(ERROR_MAP).length, 12);
});

test('failure leaves the machine ready for a fresh explicit start', () => {
  const { sp, calls } = machine();
  sp.start('x', { userInitiated: true });
  calls.speak[0].onerror({ error: 'audio-hardware' });
  assert.strictEqual(sp.state().phase, 'failed');
  const r = sp.start('try again', { userInitiated: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sp.state().failure, null);
  assert.strictEqual(calls.speak.length, 2);
});

test('onSettled fires exactly once per terminal transition, never on refusal', () => {
  const f = fakeGlobal();
  const engine = webSpeechEngine(f.global);
  const seen = [];
  const sp = createSpeechOutput({ engine, enabled: () => true, onSettled: (st) => seen.push(st.phase) });
  sp.start('x', { userInitiated: true });
  assert.deepStrictEqual(seen, []);
  sp.start('y', { userInitiated: true }); // refused, no settle
  assert.deepStrictEqual(seen, []);
  f.calls.speak[0].onend();
  assert.deepStrictEqual(seen, ['done']);

  const g = fakeGlobal();
  const engine2 = webSpeechEngine(g.global);
  const seen2 = [];
  const sp2 = createSpeechOutput({ engine: engine2, enabled: () => true, onSettled: (st) => seen2.push(st.phase) });
  sp2.start('x', { userInitiated: true });
  sp2.stop();
  g.calls.speak[0].onend(); // late callback must not re-fire the settle
  g.calls.speak[0].onerror({ error: 'canceled' });
  assert.deepStrictEqual(seen2, ['cancelled']);

  const h = fakeGlobal();
  const seen3 = [];
  const sp3 = createSpeechOutput({ engine: webSpeechEngine(h.global), enabled: () => true, onSettled: (st) => seen3.push(st.phase) });
  sp3.start('x', { userInitiated: true });
  h.calls.speak[0].onerror({ error: 'audio-hardware' });
  assert.deepStrictEqual(seen3, ['failed']);
});

// m59 regression: a callback arriving from an ALREADY-STOPPED utterance
// (the engine can deliver it late, after a stop-then-start) must never
// settle the newer session. Guards have to bind to the session that
// started them, not just to "something is speaking".
test('a stale callback from a stopped utterance cannot settle a later session', () => {
  let tick = 0;
  const handlers = [];
  const engine = {
    speak: (t, h) => { handlers.push(h); return {}; },
    cancel: () => {},
  };
  const sp = createSpeechOutput({ engine, enabled: () => true, now: () => ++tick });

  const first = sp.start('first answer', { userInitiated: true });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(sp.stop().ok, true);

  const second = sp.start('second answer', { userInitiated: true });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(sp.isSpeaking(), true);

  // Late callback from the cancelled first utterance.
  handlers[0].onEnd();
  assert.strictEqual(sp.isSpeaking(), true, 'stale onEnd must not settle the newer session');
  assert.strictEqual(sp.state().phase, 'speaking');

  handlers[0].onError('canceled');
  assert.strictEqual(sp.state().failure, null, 'stale onError must not fail the newer session');

  // The second session is still genuinely stoppable.
  assert.strictEqual(sp.stop().ok, true);
  assert.strictEqual(sp.isSpeaking(), false);
});
