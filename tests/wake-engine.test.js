'use strict';

// M6 slice 4 tests: the wake engine's gate chain, fully injected. No
// filesystem, no settings store, no listener; the gates themselves are the
// test surface. Everything must fail closed and every reason must be
// specific enough for the About card to show it.
const test = require('node:test');
const assert = require('node:assert');
const { createWakeEngine } = require('../src/wake-engine');

function engine(overrides = {}) {
  return createWakeEngine({
    getSettings: () => ({ assistant_name: 'Nova', wake_enabled: true, wake_threshold: 0.5 }),
    modelPathFor: (id) => (id === 'hey-nova' ? '/models/wake/hey-nova.onnx' : null),
    listModelIds: () => ['hey-nova'],
    engineReady: () => true,
    now: () => 0,
    ...overrides,
  });
}

test('status reports every gate by name, with the resolved phrase', () => {
  const st = engine().status();
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.phrase, 'Hey Nova');
  assert.strictEqual(st.modelId, 'hey-nova');
  assert.strictEqual(st.modelReady, true);
  assert.strictEqual(st.modelReason, null);
  assert.strictEqual(st.nameError, null);
  assert.strictEqual(st.running, 'off');
});

test('a missing companion name is reported, never silently defaulted', () => {
  const st = engine({ getSettings: () => ({ wake_enabled: true }) }).status();
  assert.strictEqual(st.phrase, null);
  assert.strictEqual(st.nameError, 'no_companion_name');
  assert.strictEqual(st.modelReady, false);
  assert.strictEqual(st.modelReason, 'no_companion_name');
});

test('a runtime piece missing blocks start with wake_engine_missing', () => {
  const e = engine({ engineReady: () => 'wake_engine_missing' });
  assert.strictEqual(e.status().modelReason, 'wake_engine_missing');
  const r = e.start({ userInitiated: true });
  assert.strictEqual(r.reason, 'wake_engine_missing');
});

test('nothing is on disk yet: wake_model_missing, and start refuses', () => {
  const e = engine({ modelPathFor: () => null, listModelIds: () => [] });
  assert.strictEqual(e.status().modelReason, 'wake_model_missing');
  assert.strictEqual(e.start({ userInitiated: true }).reason, 'wake_model_missing');
});

test('a model exists for a DIFFERENT name: phrase_mismatch, not a silent reuse', () => {
  const e = engine({ modelPathFor: () => null, listModelIds: () => ['hey-nova'] });
  const st = createWakeEngine({
    getSettings: () => ({ assistant_name: 'Jarvis', wake_enabled: true }),
    modelPathFor: () => null,
    listModelIds: () => ['hey-nova'],
    engineReady: () => true,
    now: () => 0,
  }).status();
  assert.strictEqual(st.modelReason, 'phrase_mismatch');
  assert.strictEqual(st.modelReady, false);
  // the same-name case stays wake_model_missing: the only trained id IS
  // the current one, so nothing mismatches
  assert.strictEqual(e.status().modelReason, 'wake_model_missing');
  assert.strictEqual(e.start({ userInitiated: true }).ok, false);
});

test('start requires an explicit user action even with every gate open', () => {
  const e = engine();
  const r = e.start({});
  assert.strictEqual(r.reason, 'user_action_required');
  assert.strictEqual(e.status().running, 'off');
});

test('a valid explicit start opens the session and the score path works', () => {
  const e = engine();
  assert.strictEqual(e.start({ userInitiated: true }).ok, true);
  assert.strictEqual(e.status().running, 'listening');
  assert.strictEqual(e.status().micOpen, true);
  const low = e.reportScore(0.2);
  assert.strictEqual(low.detected, false);
  const hit = e.reportScore(0.95);
  assert.strictEqual(hit.detected, true);
  assert.strictEqual(e.status().running, 'suspended');
  assert.strictEqual(e.status().micOpen, false);
});

test('queryDone then tick resumes listening only after the cooldown', () => {
  const clock = { n: 0 };
  const e = engine({ now: () => clock.n });
  e.start({ userInitiated: true });
  clock.n = 100;
  e.reportScore(0.9);
  e.queryDone();
  assert.strictEqual(e.status().running, 'cooldown');
  clock.n = 1500;
  assert.strictEqual(e.tick().reason, 'cooldown_active');
  clock.n = 2101;
  assert.strictEqual(e.tick().ok, true);
  assert.strictEqual(e.status().running, 'listening');
});

test('stop is revocation from any phase', () => {
  const e = engine();
  e.start({ userInitiated: true });
  assert.strictEqual(e.stop().ok, true);
  assert.strictEqual(e.status().running, 'off');
  assert.strictEqual(e.status().micOpen, false);
});

test('a disabled setting blocks start with wake_disabled before anything else', () => {
  const e = engine({ getSettings: () => ({ assistant_name: 'Nova', wake_enabled: false }) });
  assert.strictEqual(e.start({ userInitiated: true }).reason, 'wake_disabled');
});
