'use strict';

// M6 slice 3: OS-native speech output (text-to-speech) groundwork.
// Decision-independent by Ninad's order of 24 Nov 2026: the only engine
// used is the OS's own voice stack reached through the browser's standard
// speechSynthesis interface (on macOS Chromium that is the operating
// system's voice). No bundled model or asset, no download, no external
// service, no paid dependency, no third-party TTS engine.
//
// Boundaries (all fail closed):
//   - Voice OUTPUT is a separate setting, `voice_output_enabled`, and it
//     defaults to false. The machine refuses to start while it is off.
//   - Nothing ever speaks on its own: nothing speaks at creation, at
//     startup, or when an answer merely arrives. `start` refuses any call
//     that is not `userInitiated: true`, i.e. not a click of the overlay's
//     Read aloud button. There is no autoplay path anywhere in this file.
//   - One utterance at a time. A second start while speaking is refused.
//   - Cancellation is explicit: `stop` calls the engine's cancel and marks
//     the session cancelled; engine callbacks after a stop are ignored.
//   - Failure reasons are an allowlist. The engine's raw error name is
//     mapped through ERROR_MAP (unknown names fail closed to
//     `synthesis_failed`) and the raw event is never stored.
//   - No audio or text retention: the API keeps no reference to the text
//     it was given and exposes none in its state. The text exists only in
//     the synthesizer call; nothing is recorded, stored, or uploaded.
//   - No microphone capture, no wake word, no model download, and no
//     claim that speech was verified on real devices: the OS-native path
//     needs Ninad's physical test before any such claim.
//   - The engine owns audio focus and output: this code sets no voice,
//     rate, pitch, or volume and never intercepts or overrides the OS's
//     audio routing, level, or interruption behavior.
//   - Capability detection is honest: `detectSpeech` reports what the
//     current runtime actually exposes. Where speechSynthesis is missing,
//     the machine refuses with `no_synthesis_api` and the UI says so.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionSpeechOutput = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_TEXT = 4000;

  // Web Speech error names -> allowlisted failure codes. Unknown names
  // never reach the state verbatim: they fail closed to synthesis_failed.
  const ERROR_MAP = {
    'canceled': 'cancelled',
    'interrupted': 'speech_interrupted',
    'synthesis-failed': 'synthesis_failed',
    'synthesis-unavailable': 'synthesis_unavailable',
    'audio-busy': 'audio_busy',
    'audio-hardware': 'audio_hardware',
    'not-allowed': 'synthesis_not_allowed',
    'language-unavailable': 'voice_unavailable',
    'voice-unavailable': 'voice_unavailable',
    'text-too-long': 'text_too_long',
    'invalid-argument': 'bad_request',
    'network': 'synthesis_unavailable',
  };

  // What the current runtime exposes. `voices` is a runtime state, not a
  // capability: many engines populate the voice list asynchronously, so a
  // missing list is reported but does not fail the capability check.
  function detectSpeech(globalObj) {
    const g = globalObj || (typeof window !== 'undefined' ? window : null);
    const hasSynth = !!(g && g.speechSynthesis &&
      typeof g.speechSynthesis.speak === 'function' &&
      typeof g.speechSynthesis.cancel === 'function');
    const hasUtterance = !!(g && typeof g.SpeechSynthesisUtterance === 'function');
    if (hasSynth && hasUtterance) return { available: true, voicesKnown: null };
    return { available: false, reason: 'no_synthesis_api', voicesKnown: false };
  }

  // Adapter over the OS's own synthesizer. It deliberately sets no voice,
  // rate, pitch, or volume: the OS defaults own output routing, level, and
  // interruption, exactly as ordered. onEnd/onError are the machine's only
  // windows into the engine.
  function webSpeechEngine(globalObj) {
    const g = globalObj;
    return {
      kind: 'web_speech',
      speak(text, handlers) {
        const u = new g.SpeechSynthesisUtterance(text);
        u.onend = () => { if (handlers.onEnd) handlers.onEnd(); };
        u.onerror = (e) => { if (handlers.onError) handlers.onError(e && e.error ? e.error : 'synthesis-failed'); };
        g.speechSynthesis.speak(u);
        return u;
      },
      cancel() { g.speechSynthesis.cancel(); },
    };
  }

  // `onSettled(state)` is optional and fires exactly once when an utterance
// reaches a terminal phase (done, cancelled, failed) so a caller can reset
// its visible playback state without polling. Stop's own settle fires from
// stop(); late engine callbacks are already ignored and never re-fire it.
function createSpeechOutput({ engine, enabled, now, maxText, onSettled } = {}) {
    if (typeof enabled !== 'function') throw new TypeError('enabled getter required');
    const t = typeof now === 'function' ? now : () => 0;
    const cap = Number.isInteger(maxText) && maxText > 0 && maxText <= MAX_TEXT ? maxText : MAX_TEXT;
    let phase = 'idle';
    let startedAt = null;
    let endedAt = null;
    let failure = null;
    const engineReady = !!(engine && typeof engine.speak === 'function' && typeof engine.cancel === 'function');
    const settled = typeof onSettled === 'function' ? onSettled : null;

    function state() {
      return Object.freeze({
        phase,
        speaking: phase === 'speaking',
        startedAt,
        elapsedMs: startedAt === null ? 0 : Math.max(0, (endedAt === null ? t() : endedAt) - startedAt),
        failure,
        // No text field, no utterance reference: nothing the engine was
        // given is retained here.
      });
    }

    function mapError(raw) {
      return ERROR_MAP[raw] || 'synthesis_failed';
    }

    function start(text, { userInitiated } = {}) {
      if (!enabled()) return { ok: false, reason: 'voice_output_disabled' };
      if (!userInitiated) return { ok: false, reason: 'user_action_required' };
      if (phase === 'speaking') return { ok: false, reason: 'already_speaking' };
      if (!engineReady) return { ok: false, reason: 'no_synthesis_api' };
      if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, reason: 'empty_text' };
      if (text.length > cap) return { ok: false, reason: 'text_too_long' };
      failure = null;
      startedAt = t();
      endedAt = null;
      phase = 'speaking';
      engine.speak(text, {
        onEnd: () => { if (phase === 'speaking') { phase = 'done'; endedAt = t(); if (settled) settled(state()); } },
        onError: (raw) => { if (phase === 'speaking') { phase = 'failed'; failure = mapError(raw); endedAt = t(); if (settled) settled(state()); } },
      });
      return { ok: true, state: state() };
    }

    function stop() {
      if (phase !== 'speaking') return { ok: false, reason: 'nothing_speaking' };
      phase = 'cancelled';
      endedAt = t();
      engine.cancel(); // the machine's phase is already terminal, so the engine's cancel callbacks cannot resurrect it
      if (settled) settled(state());
      return { ok: true, state: state() };
    }

    return { start, stop, state, isSpeaking: () => phase === 'speaking', mapError };
  }

  return { detectSpeech, webSpeechEngine, createSpeechOutput, ERROR_MAP, MAX_TEXT };
});
