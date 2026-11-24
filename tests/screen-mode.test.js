'use strict';

const test = require('node:test');
const assert = require('node:assert');
const SM = require('../src/screen-mode');

const policy = (over = {}) => SM.createScreenModePolicy({ clock: () => 1000, platform: 'darwin', ...over });

test('the default is manual and nothing is active or consented', () => {
  const p = policy();
  const s = p.state();
  assert.equal(s.mode, 'manual');
  assert.equal(s.activeKind, null);
  assert.equal(p.isActive(), false);
  assert.deepEqual(SM.MODES, ['manual', 'session', 'background']);
  assert.equal(SM.DEFAULT_MODE, 'manual');
});

test('capture never autostarts: any non-user-action source is refused, user action or not', () => {
  assert.equal(policy({ mode: 'background' }).startObservation('startup').reason, 'capture_never_autostarts');
  assert.equal(policy({ mode: 'background' }).startObservation('timer').reason, 'capture_never_autostarts');
  assert.equal(policy({ mode: 'background' }).startObservation('automated').reason, 'capture_never_autostarts');
  assert.equal(policy({ mode: 'background' }).startObservation().reason, 'capture_never_autostarts');
  assert.equal(policy({ mode: 'session' }).startObservation('user_action').ok, true);
});

test('manual mode can never start an observation, even on an explicit user action', () => {
  assert.equal(policy({ mode: 'manual' }).startObservation('user_action').reason, 'mode_manual');
  assert.equal(policy({ mode: 'manual' }).indicator().visible, false);
});

test('selection validation: mode names, and background is desktop-only', () => {
  assert.equal(SM.validateSelection({ mode: 'nonsense', platform: 'darwin' }).reason, 'bad_mode');
  assert.equal(SM.validateSelection({ mode: 'background', platform: 'android' }).reason, 'background_desktop_only');
  assert.equal(SM.validateSelection({ mode: 'background', platform: 'ios' }).reason, 'background_desktop_only');
  assert.equal(SM.validateSelection({ mode: 'background', platform: 'darwin', backgroundConsent: true }).ok, true);
  assert.equal(SM.validateSelection({ mode: 'background', platform: 'win32', backgroundConsent: true }).ok, true);
  assert.equal(SM.validateSelection({ mode: 'background', platform: 'linux', backgroundConsent: true }).ok, true);
  assert.equal(SM.validateSelection({ mode: 'session', platform: 'android' }).ok, true, 'session mode itself is selectable anywhere; only C is desktop-only');
});

test('background on a mobile platform is refused again at start, even with consent stored', () => {
  const p = policy({ mode: 'background', platform: 'android', backgroundConsent: true });
  assert.equal(p.startObservation('user_action').reason, 'background_desktop_only');
  assert.equal(p.isActive(), false);
});

test('background needs its own explicit consent; consent never implies activity', () => {
  const no = policy({ mode: 'background', backgroundConsent: false });
  assert.equal(no.startObservation('user_action').reason, 'background_consent_required');
  const yes = policy({ mode: 'background', backgroundConsent: true });
  assert.equal(yes.state().activeKind, null, 'consent recorded but nothing runs until an explicit start');
  assert.equal(yes.startObservation('user_action').ok, true);
  assert.equal(yes.state().activeKind, 'background');
});

test('one observation at a time; stop and pause are always one call away', () => {
  const p = policy({ mode: 'session' });
  p.startObservation('user_action');
  assert.equal(p.startObservation('user_action').reason, 'already_active');
  assert.equal(p.pause().ok, true);
  assert.equal(p.indicator().label, 'Screen observation paused');
  assert.equal(p.resume().ok, true);
  assert.equal(p.stop().ok, true);
  assert.equal(p.isActive(), false);
  assert.equal(p.stop().reason, 'not_active');
  assert.equal(p.pause().reason, 'not_capturing');
});

test('background cadence is conservative: 30 s floor and at least one exclusion', () => {
  const p = policy({ mode: 'background', backgroundConsent: true });
  assert.equal(p.backgroundConfig({ intervalMs: 5000, exclusions: ['bank'] }).reason, 'bad_interval');
  assert.equal(p.backgroundConfig({ intervalMs: 29999, exclusions: ['bank'] }).reason, 'bad_interval');
  assert.equal(p.backgroundConfig({ intervalMs: 30000 }).reason, 'exclusions_required');
  const ok = p.backgroundConfig({ intervalMs: 60000, exclusions: ['bank', 'wallet'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.intervalMs, 60000);
  assert.deepEqual(ok.config.exclusions, ['bank', 'wallet']);
  assert.equal(p.backgroundConfig({ intervalMs: 600001, exclusions: ['bank'] }).reason, 'bad_interval');
  assert.equal(SM.BACKGROUND_MIN_INTERVAL_MS, 30000);
  assert.equal(SM.SESSION_MIN_INTERVAL_MS, 5000, 'the session floor stays at the observation module floor');
});

test('the indicator contract: persistent while background runs, visible for sessions, gone when stopped', () => {
  const b = policy({ mode: 'background', backgroundConsent: true });
  b.startObservation('user_action');
  const on = b.indicator();
  assert.equal(on.visible, true);
  assert.equal(on.persistent, true, 'background assist announces itself for as long as it runs');
  assert.equal(on.label, 'Screen assist is on');
  b.stop();
  assert.equal(b.indicator().visible, false);
  const s = policy({ mode: 'session' });
  s.startObservation('user_action');
  assert.equal(s.indicator().persistent, false);
  assert.equal(s.indicator().label, 'Screen is being observed');
});

test('a screen permission is requested only after an explicit user action, never automatically', () => {
  const p = policy({ mode: 'session' });
  assert.equal(p.requestPermission({}).reason, 'permission_requires_user_action');
  assert.equal(p.requestPermission({ userInitiated: false }).reason, 'permission_requires_user_action');
  assert.equal(p.requestPermission({ userInitiated: true }).ok, true);
  assert.equal(policy({ mode: 'manual' }).requestPermission({ userInitiated: true }).reason, 'mode_manual');
});

test('local-only and no-retention are constants nothing here can flip', () => {
  assert.equal(SM.LOCAL_ONLY, true);
  assert.equal(SM.RETAIN_BY_DEFAULT, false);
});

test('elapsed time is reported and frozen at pause', () => {
  let now = 1000;
  const p = SM.createScreenModePolicy({ clock: () => now, platform: 'darwin', mode: 'session' });
  p.startObservation('user_action');
  now = 4000;
  assert.equal(p.elapsedMs(), 3000);
  p.pause();
  now = 9000;
  assert.equal(p.elapsedMs(), 3000, 'a paused observation is not accruing time');
});
