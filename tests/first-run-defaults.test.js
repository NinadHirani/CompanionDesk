'use strict';

// First-run acceptance (release groundwork, 25 Nov 2026): on a fresh
// install the standing privacy defaults hold end to end. Nothing here
// enables anything; it pins what a fresh install must look like so a
// future slice cannot silently widen a default. Uses only pure modules;
// no Electron, no network, no device.

const test = require('node:test');
const assert = require('node:assert');

const { DEFAULTS, normalizeSettings } = require('../src/settings');
const store = require('../src/memory-store');
const { createIntegrationRegistry } = require('../src/integrations');
const da = require('../src/device-access');
const SM = require('../src/screen-mode');
const { createWakeSession } = require('../src/wake-word');

test('a fresh install starts from exactly the frozen defaults', () => {
  assert.deepEqual(normalizeSettings({}), DEFAULTS);
});

test('nothing reaches the cloud, records, speaks, or listens on a fresh install', () => {
  assert.equal(DEFAULTS.cloud_enabled, false, 'cloud fallback off');
  assert.equal(DEFAULTS.cloud_personal, false, 'personal context never leaves the device');
  assert.equal(DEFAULTS.voice_enabled, false, 'push-to-talk off until enabled');
  assert.equal(DEFAULTS.voice_output_enabled, false, 'spoken answers off until enabled');
  assert.equal(DEFAULTS.wake_enabled, false, 'wake word off; no listening');
  assert.equal(DEFAULTS.screen_observation_enabled, false, 'no screen observation');
  assert.equal(DEFAULTS.screen_mode, 'manual', 'screen mode is the manual look');
  assert.equal(DEFAULTS.screen_background_consent, false, 'no background consent on file');
  assert.equal(DEFAULTS.proactive_enabled, false, 'no proactive delivery');
  assert.equal(DEFAULTS.proactive_scope_reminder, false, 'no reminder scope');
  assert.equal(DEFAULTS.proactive_scope_deadline, false, 'no deadline scope');
  assert.equal(DEFAULTS.onboarding_done, false, 'onboarding has not run');
  assert.equal(DEFAULTS.proactive_quiet_enabled, true, 'quiet hours fail safe ON');
});

test('sensitive memory stays session-only even with explicit consent', () => {
  const s = store.createStore();
  s.addMemory('Facts', 'passport scans live in the vault', { sensitive: true });
  const res = s.persistSensitive('m1');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'sensitive_storage_blocked');
  assert.equal(s.toMarkdown().includes('passport scans'), false, 'never leaves the session view');
});

test('the wake machine refuses while its gate is off, even on an explicit press', () => {
  const s = createWakeSession({ now: () => 0 });
  assert.deepEqual(s.start({}, { enabled: false }), { ok: false, reason: 'user_action_required' });
  assert.deepEqual(s.start({ userInitiated: true }, { enabled: false }), { ok: false, reason: 'wake_disabled' });
});

test('no device or integration grant exists on a fresh install', () => {
  assert.equal(da.UNRESTRICTED_DEVICE_ACCESS, false);
  const centre = da.createDeviceAccessCentre({ clock: () => 0, platform: 'darwin' });
  assert.equal(centre.authorize('appA', 'files_read', { scope: 'downloads' }).allowed, false,
    'nothing is granted by default');
  assert.deepEqual(createIntegrationRegistry({ clock: () => 0 }).list(), [],
    'the integration registry ships empty');
});

test('screen capture can never start on a fresh install', () => {
  const p = SM.createScreenModePolicy({ clock: () => 0, platform: 'darwin' });
  assert.equal(p.state().mode, 'manual');
  assert.equal(p.state().activeKind, null);
  assert.equal(p.isActive(), false);
  assert.equal(SM.DEFAULT_MODE, 'manual');
  assert.equal(p.startObservation('user_action').reason, 'mode_manual',
    'the manual look never captures, even on an explicit action');
});
