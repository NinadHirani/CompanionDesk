'use strict';

// M7 slice 2: the screen-observation mode policy, per Ninad's decision.
// Three user-selectable modes, nothing enabled until the user selects and
// explicitly starts it:
//   A 'manual'     - one look only when the user explicitly asks (DEFAULT)
//   B 'session'    - a visible session the user explicitly starts and stops
//   C 'background' - continuous assist, LAPTOP/DESKTOP ONLY, never mobile,
//                    behind a separate explicit consent
// This slice is policy and config only: it captures nothing, reads no
// pixels, requests no real permission and starts no timers. The capture
// engine does not exist yet; when it does, it must come through here.
//
// Fail-closed rules (all pinned by tests):
//  1. The default mode is 'manual' and the policy is inactive until a
//     user action starts an observation. Nothing runs at startup: a start
//     sourced from anything but an explicit user action is refused.
//  2. Background mode exists only on laptop/desktop platforms. On a
//     mobile platform it is refused at selection and again at start.
//  3. Background needs a separate explicit consent record. Selecting
//     background without that consent is refused; consent is remembered
//     but never implies activity.
//  4. Background cadence is conservative: its interval floor is 30 s (the
//     session floor stays 5 s), and at least one app exclusion must be
//     configured before a background observation may start.
//  5. Stop and pause are always one call away while anything is active.
//  6. A screen permission may be requested only as part of an explicit
//     user action, never automatically and never at startup.
//  7. Processing is local-only and nothing is retained by default; these
//     are constants this module exports and nothing here can flip.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionScreenMode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MODES = ['manual', 'session', 'background'];
  const DEFAULT_MODE = 'manual';
  // Electron process.platform values for laptops/desktops. Mobile is
  // everything else ('android', 'ios', ...).
  const DESKTOP_PLATFORMS = ['darwin', 'win32', 'linux'];
  const SESSION_MIN_INTERVAL_MS = 5000;   // matches src/screen-observation.js
  const BACKGROUND_MIN_INTERVAL_MS = 30000; // conservative cadence for C
  const MAX_INTERVAL_MS = 600000;
  // Exclusion bounds mirror src/screen-observation.js so both surfaces
  // accept exactly the same exclusion lists.
  const MAX_EXCLUSIONS = 50;
  const MAX_EXCLUSION_LEN = 120;
  const LOCAL_ONLY = true;
  const RETAIN_BY_DEFAULT = false;

  function isDesktop(platform) {
    return DESKTOP_PLATFORMS.includes(String(platform || ''));
  }

  // Selecting a mode is a settings change, never an activity change.
  // -> { ok, mode } | { ok: false, reason }
  function validateSelection({ mode, platform, backgroundConsent } = {}) {
    if (!MODES.includes(mode)) return { ok: false, reason: 'bad_mode' };
    if (mode === 'background' && !isDesktop(platform)) return { ok: false, reason: 'background_desktop_only' };
    if (mode === 'background' && backgroundConsent !== true) return { ok: false, reason: 'background_consent_required' };
    return { ok: true, mode };
  }

  function createScreenModePolicy({ clock, platform, mode = DEFAULT_MODE, backgroundConsent = false } = {}) {
    const t = typeof clock === 'function' ? clock : () => Date.now();
    if (!MODES.includes(mode)) throw new TypeError('bad mode');
    const desktop = isDesktop(platform);
    let active = null; // null | { kind: 'session'|'background', paused: bool, startedAt }
    let pausedAt = null;

    function consented() { return backgroundConsent === true && desktop; }

    function state() {
      return Object.freeze({
        mode,
        platform: String(platform || ''),
        desktop,
        backgroundConsent: consented(),
        activeKind: active ? active.kind : null,
        paused: active ? active.paused : false,
        startedAt: active ? active.startedAt : null,
      });
    }

    // The ONLY way an observation begins. source must be 'user_action';
    // any other source (startup, a timer, an automated flow) is refused,
    // so capture never begins on its own.
    function startObservation(source) {
      if (source !== 'user_action') return { ok: false, reason: 'capture_never_autostarts' };
      if (mode === 'manual') return { ok: false, reason: 'mode_manual' };
      if (active) return { ok: false, reason: 'already_active' };
      if (mode === 'background' && !desktop) return { ok: false, reason: 'background_desktop_only' };
      if (mode === 'background' && !consented()) return { ok: false, reason: 'background_consent_required' };
      active = { kind: mode, paused: false, startedAt: t() };
      return { ok: true, state: state() };
    }

    // Stop and pause are always available while anything is active.
    function stop() {
      if (!active) return { ok: false, reason: 'not_active' };
      active = null; pausedAt = null;
      return { ok: true, state: state() };
    }
    function pause() {
      if (!active || active.paused) return { ok: false, reason: 'not_capturing' };
      active.paused = true; pausedAt = t();
      return { ok: true, state: state() };
    }
    function resume() {
      if (!active || !active.paused) return { ok: false, reason: 'not_paused' };
      active.paused = false; pausedAt = null;
      return { ok: true, state: state() };
    }

    // Background cadence and exclusions, checked before a background
    // observation may run. Session cadence stays at the looser floor.
    // -> { ok, config } | { ok: false, reason }
    function backgroundConfig({ intervalMs, exclusions } = {}) {
      // Defined for background mode only: the 30 s floor and the
      // exclusion requirement are background cadence rules.
      if (mode !== 'background') return { ok: false, reason: 'not_background_mode' };
      if (!Number.isInteger(intervalMs) || intervalMs < BACKGROUND_MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
        return { ok: false, reason: 'bad_interval' };
      }
      if (!Array.isArray(exclusions) || exclusions.length === 0) return { ok: false, reason: 'exclusions_required' };
      if (exclusions.length > MAX_EXCLUSIONS) return { ok: false, reason: 'bad_exclusions' };
      const clean = [];
      for (const e of exclusions) {
        if (typeof e !== 'string') return { ok: false, reason: 'bad_exclusions' };
        const v = e.trim().toLowerCase();
        if (!v || v.length > MAX_EXCLUSION_LEN) return { ok: false, reason: 'bad_exclusions' };
        clean.push(v);
      }
      return { ok: true, config: Object.freeze({ intervalMs, exclusions: Object.freeze(clean) }) };
    }

    // A screen permission may be requested only as part of an explicit
    // user action. This is the gate; the real permission call belongs to
    // the engine slice and must come through here.
    function requestPermission({ userInitiated } = {}) {
      if (userInitiated !== true) return { ok: false, reason: 'permission_requires_user_action' };
      if (mode === 'manual') return { ok: false, reason: 'mode_manual' };
      return { ok: true };
    }

    // The indicator contract: anything active is visibly announced, a
    // paused one is announced as paused, and background's indicator is
    // persistent for as long as the mode runs.
    function indicator() {
      if (!active) return Object.freeze({ visible: false, label: null, persistent: false });
      if (active.paused) return Object.freeze({ visible: true, label: 'Screen observation paused', persistent: false });
      if (active.kind === 'background') return Object.freeze({ visible: true, label: 'Screen assist is on', persistent: true });
      return Object.freeze({ visible: true, label: 'Screen is being observed', persistent: false });
    }

    function elapsedMs() {
      if (!active) return 0;
      const end = active.paused ? pausedAt : t();
      return Math.max(0, end - active.startedAt);
    }

    return Object.freeze({
      state, startObservation, stop, pause, resume,
      backgroundConfig, requestPermission, indicator, elapsedMs,
      isActive: () => !!active,
    });
  }

  return {
    MODES, DEFAULT_MODE, DESKTOP_PLATFORMS, isDesktop, validateSelection,
    SESSION_MIN_INTERVAL_MS, BACKGROUND_MIN_INTERVAL_MS, MAX_INTERVAL_MS,
    MAX_EXCLUSIONS, MAX_EXCLUSION_LEN,
    LOCAL_ONLY, RETAIN_BY_DEFAULT,
    createScreenModePolicy,
  };
});
