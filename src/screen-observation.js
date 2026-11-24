'use strict';

// M7 slice 1: the screen-observation session state machine. Session-scoped
// live observation, per the M7 roadmap line: opt-in, visibly indicated,
// pausable, app exclusions, configurable interval, local processing only.
// This slice is the interface only: nothing here captures, reads the screen,
// requests a permission, runs on a timer, or touches the network. The engine
// that would drive it does not exist yet; this module defines the contract
// it must satisfy, and the tests pin it.
//
// Phases: idle --start--> capturing <--pause/resume--> paused
//         capturing|paused --stop--> done, --cancel--> cancelled
//
// Boundaries (fail closed, all pinned by tests):
//   - start() is the only way in, and only from an idle or finished phase:
//     observation never begins on its own, and one session runs at a time.
//   - The interval is per session and bounded (5 s to 10 min); the module
//     never sets a timer (clock injected); dueTick() only reports, the
//     caller acts, and markTicked() resets the window.
//   - admits(title) combines the user's exclusions with the built-in rules
//     from src/screen.js (own windows and sensitive titles) and REFUSES on
//     any match. It is a title check, not a pixel check: it cannot see
//     inside a window.
//   - indicator() is the visibility contract: an active session is always
//     announced, and a paused one is shown as paused.
//   - No retention: no pixels, buffers or image references are accepted or
//     stored anywhere in this API. Each frame lives only in the engine's
//     hand and is dropped after its local answer.
//   - LOCAL_ONLY is a named constant: an observation answer must resolve
//     through the local vision route, and nothing here can flip it.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionScreenObservation = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const { isOwnWindow, sensitiveWindow } = require('./screen');
  const MIN_INTERVAL_MS = 5000;
  const MAX_INTERVAL_MS = 600000;
  const MAX_EXCLUSIONS = 50;
  const MAX_EXCLUSION_LEN = 120;
  const MAX_TITLE_LEN = 200;
  const LOCAL_ONLY = true;

  function cleanExclusions(raw) {
    if (!Array.isArray(raw)) return null;
    if (raw.length > MAX_EXCLUSIONS) return null;
    const out = [];
    for (const e of raw) {
      if (typeof e !== 'string') return null;
      const v = e.trim().toLowerCase();
      if (!v || v.length > MAX_EXCLUSION_LEN) return null;
      out.push(v);
    }
    return out;
  }

  function createObservationSession({ now, intervalMs, exclusions } = {}) {
    const t = typeof now === 'function' ? now : () => 0;
    if (intervalMs !== undefined && !(Number.isInteger(intervalMs) && intervalMs >= MIN_INTERVAL_MS && intervalMs <= MAX_INTERVAL_MS)) {
      return { ok: false, reason: 'bad_interval' };
    }
    const interval = intervalMs === undefined ? 30000 : intervalMs;
    const excl = exclusions === undefined ? [] : cleanExclusions(exclusions);
    if (excl === null) return { ok: false, reason: 'bad_exclusions' };

    let phase = 'idle';
    let startedAt = null;
    let endedAt = null;
    let lastTick = null;

    function state() {
      return Object.freeze({
        phase,
        capturing: phase === 'capturing',
        startedAt,
        lastTickedAt: lastTick,
        intervalMs: interval,
        exclusionCount: excl.length,
      });
    }
    function isActive() { return phase === 'capturing' || phase === 'paused'; }

    function start() {
      if (isActive()) return { ok: false, reason: 'already_active' };
      phase = 'capturing';
      startedAt = t(); endedAt = null; lastTick = t();
      return { ok: true, state: state() };
    }
    function pause() {
      if (phase !== 'capturing') return { ok: false, reason: 'not_capturing' };
      phase = 'paused';
      return { ok: true, state: state() };
    }
    function resume() {
      if (phase !== 'paused') return { ok: false, reason: 'not_paused' };
      phase = 'capturing';
      lastTick = t(); // a resumed session owes a full interval, not an instant tick
      return { ok: true, state: state() };
    }
    function stop() {
      if (!isActive()) return { ok: false, reason: 'not_active' };
      endedAt = t(); phase = 'done';
      return { ok: true, state: state() };
    }
    function cancel() {
      if (!isActive()) return { ok: false, reason: 'not_active' };
      endedAt = t(); phase = 'cancelled';
      return { ok: true, state: state() };
    }
    function dueTick() {
      return phase === 'capturing' && t() - lastTick >= interval;
    }
    function markTicked() {
      if (phase !== 'capturing') return { ok: false, reason: 'not_capturing' };
      lastTick = t();
      return { ok: true, state: state() };
    }

    // - {ok:true} when a capture of this window would be allowed, else
    //   {ok:false, reason} naming the rule that refuses. Requires an active
    //   session: with no session, nothing is ever admitted.
    function admits(title) {
      if (!isActive()) return { ok: false, reason: 'not_active' };
      if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LEN) return { ok: false, reason: 'bad_title' };
      if (isOwnWindow(title)) return { ok: false, reason: 'own_window' };
      if (sensitiveWindow([title])) return { ok: false, reason: 'sensitive' };
      const lower = title.toLowerCase();
      for (const e of excl) {
        if (lower.includes(e)) return { ok: false, reason: 'excluded' };
      }
      return { ok: true };
    }

    function indicator() {
      if (phase === 'capturing') return Object.freeze({ visible: true, label: 'Screen is being observed' });
      if (phase === 'paused') return Object.freeze({ visible: true, label: 'Screen observation paused' });
      return Object.freeze({ visible: false, label: null });
    }

    return Object.freeze({ start, pause, resume, stop, cancel, dueTick, markTicked, admits, indicator, state, isActive });
  }

  return { createObservationSession, MIN_INTERVAL_MS, MAX_INTERVAL_MS, MAX_EXCLUSIONS, MAX_EXCLUSION_LEN, LOCAL_ONLY };
});
