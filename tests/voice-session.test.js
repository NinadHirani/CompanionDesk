'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createVoiceSession, MAX_SESSION_MS, ERRORS } = require('../src/voice-session');

function clock() {
  let t = 1000;
  return { tick: (n) => { t += n; }, now: () => t };
}

test('session: begins only from an inactive phase, one session at a time', () => {
  const c = clock();
  const s = createVoiceSession({ now: c.now });
  assert.equal(s.state().phase, 'idle');
  assert.equal(s.begin().ok, true);
  assert.equal(s.begin().ok, false, 'begin while recording');
  s.stop();
  assert.equal(s.begin().ok, false, 'begin while processing');
  s.cancel();
  assert.equal(s.begin().ok, true, 'a fresh session after cancel');
  assert.equal(s.state().phase, 'recording');
});

test('session: micInUse is true only while recording (privacy indicator contract)', () => {
  const c = clock();
  const s = createVoiceSession({ now: c.now });
  assert.equal(s.state().micInUse, false);
  s.begin();
  assert.equal(s.state().micInUse, true);
  s.stop();
  assert.equal(s.state().micInUse, false, 'not while processing');
  s.complete('hello');
  assert.equal(s.state().micInUse, false);
});

test('session: stop and complete move through processing; bad text is refused', () => {
  const c = clock();
  const s = createVoiceSession({ now: c.now });
  assert.equal(s.stop().reason, 'not_recording');
  s.begin();
  s.stop();
  assert.equal(s.state().phase, 'processing');
  assert.equal(s.complete(42).ok, false, 'non-string');
  assert.equal(s.complete('').ok, false, 'empty');
  assert.equal(s.complete('x'.repeat(501)).ok, false, 'over cap');
  assert.equal(s.complete('hello').ok, true);
  assert.equal(s.state().phase, 'done');
  assert.equal(s.complete('again').ok, false, 'nothing left to complete');
});

test('session: cancel works from recording and processing, nowhere else', () => {
  const c = clock();
  const s = createVoiceSession({ now: c.now });
  assert.equal(s.cancel().reason, 'nothing_to_cancel');
  s.begin();
  assert.equal(s.cancel().ok, true);
  assert.equal(s.state().phase, 'cancelled');
  const s2 = createVoiceSession({ now: c.now });
  s2.begin(); s2.stop();
  assert.equal(s2.cancel().ok, true);
  assert.equal(s2.state().phase, 'cancelled');
});

test('session: failure reasons are allowlisted and stored; unknown ones refused', () => {
  const c = clock();
  const s = createVoiceSession({ now: c.now });
  assert.equal(s.fail('voice_disabled').reason, 'not_active');
  s.begin(); s.stop();
  assert.equal(s.fail('made_up').reason, 'bad_reason');
  assert.equal(s.fail('mic_blocked').ok, true);
  assert.equal(s.state().phase, 'error');
  assert.equal(s.state().failure, 'mic_blocked');
  for (const e of ERRORS) {
    const s2 = createVoiceSession({ now: c.now });
    s2.begin(); s2.stop();
    assert.equal(s2.fail(e).ok, true, `allowlisted: ${e}`);
  }
});

test('session: the cap auto-stops through the caller; no timers of its own', () => {
  const c = clock();
  const s = createVoiceSession({ now: c.now, maxMs: 5000 });
  s.begin();
  assert.equal(s.autoStopDue(), false);
  c.tick(4999);
  assert.equal(s.autoStopDue(), false);
  c.tick(1);
  assert.equal(s.autoStopDue(), true);
  assert.equal(s.state().elapsedMs, 5000);
  assert.equal(s.state().phase, 'recording', 'the session only reports; the caller stops');
});

test('session: the default cap is 30 s and custom caps above it are ignored', () => {
  assert.equal(MAX_SESSION_MS, 30000);
  const c = clock();
  const s = createVoiceSession({ now: c.now, maxMs: 999999 });
  s.begin();
  c.tick(29999);
  assert.equal(s.autoStopDue(), false);
  c.tick(1);
  assert.equal(s.autoStopDue(), true, 'the over-cap maxMs fell back to the default');
});

test('session: state is a frozen copy; the module holds no audio', () => {
  const c = clock();
  const s = createVoiceSession({ now: c.now });
  s.begin();
  const st = s.state();
  assert.equal(Object.isFrozen(st), true);
  assert.throws(() => { st.phase = 'hacked'; }, TypeError, 'the copy is frozen');
  assert.equal(s.state().phase, 'recording');
  assert.equal(typeof s.state().startedAt, 'number');
  assert.deepEqual(Object.keys(s.state()).sort(), ['elapsedMs', 'failure', 'micInUse', 'phase', 'startedAt']);
  // begin() takes no argument: a recording can never be attached to a session
  assert.equal(s.begin('audio-bytes').ok, false, 'already recording');
  assert.equal(s.isRecording(), true);
  assert.equal(s.isProcessing(), false);
});
