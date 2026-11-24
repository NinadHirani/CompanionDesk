'use strict';

// M6 slice 4: wake-word engine policy. Pure and Electron-free: every
// environment fact arrives as an injected getter, so the gate chain is
// testable headless. main.js owns the real wiring (settings, model files,
// the listener page and the overlay query flow) and calls into this.
//
// Boundary summary (see src/wake-word.js and docs/WAKE_WORD.md):
//   - Nothing autostarts: a start is refused unless userInitiated came
//     from a direct user control action, and the OS microphone permission
//     is requested only on that first explicit start.
//   - The model gate is exact: a trained model must exist for the phrase
//     built from the CURRENT companion name. A name change invalidates
//     the model (phrase_mismatch) until it is retrained; nothing is
//     silently re-used, substituted or downloaded.
//   - The listener contract is one-way audio-free: the engine sends no
//     audio anywhere, receives only bounded scores, and detection is
//     local-only by construction. No network route exists in this path.
//   - One listening session at a time; stop() is revocation and closes
//     the microphone immediately; the cooldown after a fired query is
//     caller-enforced (no timers of its own).
const ww = require('./wake-word');

function createWakeEngine(deps = {}) {
  const {
    getSettings = () => ({}),
    // modelPathFor(modelId) -> absolute path string when the trained model
    // file for that exact phrase exists on disk, else null.
    modelPathFor = () => null,
    // engineReady() -> true when the local runtime pieces are present
    // (listener page + onnxruntime), else a string reason. Checked so a
    // start can never open a microphone with nothing to run.
    engineReady = () => 'wake_engine_missing',
    // listModelIds() -> the model ids that currently have a trained file
    // on disk, e.g. ['hey-nova']. Used only to distinguish "nothing is
    // trained yet" (wake_model_missing) from "a model exists but not for
    // the current companion name" (phrase_mismatch): renaming the
    // companion invalidates the phrase, and the honest reason is shown.
    listModelIds = () => [],
    now = () => 0,
  } = deps;

  let session = ww.createWakeSession({ now });

  function phrase() {
    return ww.resolveWakePhrase({ assistantName: getSettings().assistant_name });
  }

  function modelState() {
    const engine = engineReady();
    if (engine !== true) return { ready: false, reason: engine };
    const p = phrase();
    if (!p.ok) return { ready: false, reason: p.reason };
    const file = modelPathFor(p.modelId);
    if (!file) {
      const others = listModelIds().filter((id) => id !== p.modelId);
      return { ready: false, reason: others.length ? 'phrase_mismatch' : 'wake_model_missing' };
    }
    return { ready: true, path: file };
  }

  // The full status the About card renders. Every gate is reported with
  // its own name so the user sees exactly what is missing, never a bare
  // "unavailable".
  function status() {
    const settings = getSettings();
    const p = phrase();
    const m = modelState();
    const st = session.state();
    return {
      ok: true,
      enabled: settings.wake_enabled === true,
      threshold: st.threshold,
      phrase: p.ok ? p.phrase : null,
      modelId: p.ok ? p.modelId : null,
      nameError: p.ok ? null : p.reason,
      modelReady: m.ready,
      modelReason: m.ready ? null : m.reason,
      running: st.phase,
      listening: st.listening,
      micOpen: st.micOpen,
      lastScore: st.lastScore,
      lastDetectionAt: st.lastDetectionAt,
      failure: st.failure,
    };
  }

  function start({ userInitiated } = {}) {
    const settings = getSettings();
    const p = phrase();
    const m = modelState();
    const r = session.start({ userInitiated }, {
      enabled: settings.wake_enabled === true,
      phraseOk: p.ok,
      modelReady: m.ready,
      modelReason: m.ready ? undefined : m.reason,
    });
    return r.ok ? { ok: true, state: r.state } : { ok: false, reason: r.reason };
  }

  function stop() { return session.stop(); }
  function fail(reason) { return session.fail(reason); }
  function pause() { return session.pause(); }
  function resume() { return session.resume(); }

  // The listener reports one bounded score per evaluation window. A hit
  // suspends listening and asks main to run the query flow; main must
  // call queryDone() when that flow fully ends.
  function reportScore(score) {
    const r = session.reportScore(score);
    return r;
  }

  function queryDone() { return session.queryDone(); }
  function tick() {
    if (session.dueResume()) return session.resumeFromCooldown();
    return { ok: false, reason: 'cooldown_active' };
  }

  return {
    status, start, stop, fail, pause, resume, reportScore, queryDone, tick,
    phrase, modelState, isListening: () => session.isListening(),
  };
}

module.exports = { createWakeEngine, COOLDOWN_MS: ww.COOLDOWN_MS };
