'use strict';

// M6 slice 1: the voice session state machine. One explicit push-to-talk
// session at a time, driven only by explicit user actions (begin from a
// button press, stop, cancel). Nothing here listens, captures, requests a
// permission, or wakes anything on its own; the renderer page holds the
// actual recording, and this module never receives audio at all.
//
// Phases and transitions (all fail closed):
//   idle --begin--> recording --stop--> processing --complete--> done
//                                  \             \--fail--> error
//                recording|processing --cancel--> cancelled
//   begin is refused while recording or processing (one session at a time).
//
// Boundaries:
//   - MAX_SESSION_MS caps a recording; autoStopDue() tells the caller when
//     to stop, and the session itself never sets a timer (clock injected).
//   - micInUse is true only in the recording phase: that is the privacy
//     indicator contract the UI renders, and it is the only phase in which
//     a microphone may be open.
//   - Failure reasons are an allowlist matching src/voice.js and
//     renderer/errors.js; anything else is refused, never stored.
//   - No audio retention: no buffer, reference or length of a recording is
//     ever accepted or stored here; the API takes no audio argument.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionVoiceSession = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_SESSION_MS = 30000; // matches src/voice.js MAX_SECONDS
  const MAX_TEXT = 500;
  const ERRORS = ['mic_blocked', 'mic_missing', 'voice_disabled', 'voice_unavailable', 'no_speech', 'too_long', 'bad_request', 'transcribe_failed', 'cancelled'];

  function createVoiceSession({ now, maxMs } = {}) {
    const t = typeof now === 'function' ? now : () => 0;
    const cap = Number.isInteger(maxMs) && maxMs > 0 && maxMs <= MAX_SESSION_MS ? maxMs : MAX_SESSION_MS;
    let phase = 'idle';
    let startedAt = null;
    let endedAt = null;
    let failure = null;

    function state() {
      return Object.freeze({
        phase,
        micInUse: phase === 'recording',
        startedAt,
        elapsedMs: startedAt === null ? 0 : Math.max(0, (endedAt === null ? t() : endedAt) - startedAt),
        failure,
      });
    }
    function isRecording() { return phase === 'recording'; }
    function isProcessing() { return phase === 'processing'; }
    function autoStopDue() { return phase === 'recording' && t() - startedAt >= cap; }

    function begin() {
      if (phase === 'recording' || phase === 'processing') return { ok: false, reason: 'already_active' };
      phase = 'recording';
      startedAt = t(); endedAt = null; failure = null;
      return { ok: true, state: state() };
    }
    function stop() {
      if (phase !== 'recording') return { ok: false, reason: 'not_recording' };
      endedAt = t(); phase = 'processing';
      return { ok: true, state: state() };
    }
    function cancel() {
      if (phase !== 'recording' && phase !== 'processing') return { ok: false, reason: 'nothing_to_cancel' };
      endedAt = t(); phase = 'cancelled';
      return { ok: true, state: state() };
    }
    function complete(text) {
      if (phase !== 'processing') return { ok: false, reason: 'not_processing' };
      if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) return { ok: false, reason: 'bad_text' };
      endedAt = t(); phase = 'done';
      return { ok: true, state: state() };
    }
    function fail(reason) {
      if (phase !== 'recording' && phase !== 'processing') return { ok: false, reason: 'not_active' };
      if (!ERRORS.includes(reason)) return { ok: false, reason: 'bad_reason' };
      endedAt = t(); phase = 'error'; failure = reason;
      return { ok: true, state: state() };
    }
    return Object.freeze({ begin, stop, cancel, complete, fail, state, isRecording, isProcessing, autoStopDue });
  }

  return { createVoiceSession, MAX_SESSION_MS, MAX_TEXT, ERRORS };
});
