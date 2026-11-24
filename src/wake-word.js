'use strict';

// M6 slice 4: wake-word subsystem policy and session state machine.
//
// Ninad's decisions of 24 Nov 2026: the wake phrase is exactly
// "Hey + <companion name configured in Settings>" (the existing
// `assistant_name` setting), and the engine route is local self-training:
// our own model, trained on fully synthetic speech, with every asset's
// license verified from primary sources before use. Nothing non-commercial
// or proprietary ships; nothing is silently substituted.
//
// Standing boundaries (all fail closed, per docs/M6_VOICE_DECISIONS.md):
//   - Wake listening has its own setting, `wake_enabled`, default false,
//     separate from push-to-talk `voice_enabled`. The machine refuses to
//     start while it is off.
//   - Nothing listens on its own: creation and startup listen to nothing,
//     and `start` refuses any call that is not an explicit user action.
//     The OS microphone permission is requested only on that first explicit
//     activation, never at app startup.
//   - The model gate is honest: wake detection needs a trained model file
//     for the EXACT phrase the user currently has configured. A missing
//     model reports `wake_model_missing`; a companion name that no longer
//     matches the trained phrase reports `phrase_mismatch` until the model
//     is retrained (scripts/wake). No model is ever bundled silently.
//   - One listener at a time; the micOpen indicator is true only while the
//     listener is actively sampling. Pause and stop close the microphone
//     immediately; stop is revocation.
//   - A detection suspends listening while the query runs, then a cooldown
//     (refractory, caller-enforced via dueResume(), no timers of its own)
//     prevents retrigger loops before listening resumes.
//   - The false-trigger threshold is adjustable within [0.1, 0.9];
//     anything else fails closed to the default.
//   - No audio retention: the API accepts no audio at all. The engine
//     reports only bounded detection scores; no frame, buffer, or
//     transcript is ever accepted or stored here, and detection is
//     local-only by construction (the engine never receives a network
//     route).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionWakeWord = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_NAME = 40; // matches the assistant_name limit in src/settings.js
  // Conservative companion-name charset: letters, spaces, apostrophes and
  // hyphens only. A wake phrase is spoken aloud, so anything exotic is
  // refused rather than smuggled into a model id or a spoken phrase.
  const NAME_RE = /^[A-Za-z][A-Za-z ' -]*[A-Za-z.]$|^[A-Za-z]$/;
  const MIN_THRESHOLD = 0.1;
  const MAX_THRESHOLD = 0.9;
  const DEFAULT_THRESHOLD = 0.5;
  const COOLDOWN_MS = 2000;

  // Build the wake phrase from the configured companion name.
  // Returns { ok, phrase, name, modelId } or { ok: false, reason }.
  // modelId is the stable, filesystem-safe id the trained model file is
  // stored and looked up under ("hey-nova" for the companion name "Nova").
  function resolveWakePhrase({ assistantName } = {}) {
    const name = String(assistantName == null ? '' : assistantName).trim();
    if (!name) return { ok: false, reason: 'no_companion_name' };
    if (name.length > MAX_NAME) return { ok: false, reason: 'name_too_long' };
    if (!NAME_RE.test(name)) return { ok: false, reason: 'invalid_name' };
    const modelId = 'hey-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!modelId || modelId === 'hey-') return { ok: false, reason: 'invalid_name' };
    return { ok: true, phrase: 'Hey ' + name, name, modelId };
  }

  function clampThreshold(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < MIN_THRESHOLD || n > MAX_THRESHOLD) return DEFAULT_THRESHOLD;
    return n;
  }

  // Phases: off -> listening -> suspended (a detection fired and the query
  // is running) -> cooldown -> listening; pause() and stop() from any
  // active phase; stop is the revocation and lands on 'off'. micOpen is
  // true only in 'listening': that is the privacy indicator contract the
  // UI renders for the always-listening listener itself (the overlay's own
  // query capture carries its own indicator while suspended).
  function createWakeSession({ now, threshold, cooldownMs } = {}) {
    const t = typeof now === 'function' ? now : () => 0;
    const thr = clampThreshold(threshold);
    const cooldown = Number.isInteger(cooldownMs) && cooldownMs > 0 && cooldownMs <= 10000 ? cooldownMs : COOLDOWN_MS;
    let phase = 'off';
    let startedAt = null;
    let suspendedAt = null;
    let cooldownEndsAt = null;
    let lastScore = null;
    let lastDetectionAt = null;
    let failure = null;

    function state() {
      return Object.freeze({
        phase,
        listening: phase === 'listening',
        micOpen: phase === 'listening',
        threshold: thr,
        lastScore,
        lastDetectionAt,
        startedAt,
        elapsedMs: startedAt === null ? 0 : Math.max(0, t() - startedAt),
        failure,
        // No audio field, no frames, no scores history: nothing the engine
        // produced beyond the single latest score is retained here.
      });
    }

    function start({ userInitiated } = {}, gates = {}) {
      if (!userInitiated) return { ok: false, reason: 'user_action_required' };
      if (gates.enabled === false) return { ok: false, reason: 'wake_disabled' };
      if (gates.phraseOk === false) return { ok: false, reason: 'no_companion_name' };
      if (gates.modelReady === false) return { ok: false, reason: gates.modelReason || 'wake_model_missing' };
      if (phase === 'listening' || phase === 'suspended') return { ok: false, reason: 'already_listening' };
      failure = null;
      phase = 'listening';
      startedAt = t();
      suspendedAt = null;
      cooldownEndsAt = null;
      lastScore = null;
      return { ok: true, state: state() };
    }

    // The engine reports one bounded score per evaluation. Scores outside
    // [0, 1] are refused, never clamped or stored.
    function reportScore(score) {
      if (phase !== 'listening') return { ok: false, reason: 'not_listening' };
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
        return { ok: false, reason: 'bad_score' };
      }
      lastScore = score;
      if (score < thr) return { ok: true, detected: false, state: state() };
      phase = 'suspended';
      suspendedAt = t();
      lastDetectionAt = suspendedAt;
      return { ok: true, detected: true, score, at: suspendedAt, state: state() };
    }

    // Called by the shell when the wake-triggered query has fully ended
    // (transcription delivered or cancelled). Enters the refractory period.
    function queryDone() {
      if (phase !== 'suspended') return { ok: false, reason: 'not_suspended' };
      phase = 'cooldown';
      cooldownEndsAt = t() + cooldown;
      return { ok: true, state: state() };
    }

    function dueResume() {
      return phase === 'cooldown' && cooldownEndsAt !== null && t() >= cooldownEndsAt;
    }

    function resumeFromCooldown() {
      if (!dueResume()) return { ok: false, reason: 'cooldown_active' };
      phase = 'listening';
      cooldownEndsAt = null;
      lastScore = null;
      return { ok: true, state: state() };
    }

    function pause() {
      if (phase !== 'listening') return { ok: false, reason: 'not_listening' };
      phase = 'paused';
      return { ok: true, state: state() };
    }

    function resume() {
      if (phase !== 'paused') return { ok: false, reason: 'not_paused' };
      phase = 'listening';
      return { ok: true, state: state() };
    }

    function stop() {
      if (phase === 'off') return { ok: false, reason: 'not_listening' };
      phase = 'off';
      startedAt = null;
      suspendedAt = null;
      cooldownEndsAt = null;
      lastScore = null;
      return { ok: true, state: state() };
    }

    return {
      start, reportScore, queryDone, dueResume, resumeFromCooldown,
      pause, resume, stop, state,
      isListening: () => phase === 'listening',
      phase: () => phase,
    };
  }

  return {
    resolveWakePhrase, createWakeSession, clampThreshold,
    MIN_THRESHOLD, MAX_THRESHOLD, DEFAULT_THRESHOLD, COOLDOWN_MS, MAX_NAME,
  };
});
