'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createObservationSession, MIN_INTERVAL_MS, MAX_INTERVAL_MS, MAX_EXCLUSIONS, LOCAL_ONLY } = require('../src/screen-observation');

function clock() {
  let t = 1000000;
  return { tick: (n) => { t += n; }, now: () => t };
}

test('observation: starts only by an explicit action, one session at a time', () => {
  const c = clock();
  const s = createObservationSession({ now: c.now });
  assert.equal(s.state().phase, 'idle');
  assert.equal(s.start().ok, true);
  assert.equal(s.start().reason, 'already_active');
  s.stop();
  assert.equal(s.start().ok, true, 'a new session after a finished one');
  assert.equal(s.state().phase, 'capturing');
});

test('observation: pause and resume move the phase both ways', () => {
  const c = clock();
  const s = createObservationSession({ now: c.now });
  assert.equal(s.pause().reason, 'not_capturing');
  s.start();
  assert.equal(s.pause().ok, true);
  assert.equal(s.state().phase, 'paused');
  assert.equal(s.resume().ok, true);
  assert.equal(s.state().phase, 'capturing');
  assert.equal(s.pause().ok, true);
  assert.equal(s.resume().ok, true);
});

test('observation: stop and cancel end the session, nowhere else', () => {
  const c = clock();
  const s = createObservationSession({ now: c.now });
  assert.equal(s.stop().reason, 'not_active');
  s.start();
  assert.equal(s.stop().ok, true);
  assert.equal(s.state().phase, 'done');
  const s2 = createObservationSession({ now: c.now });
  s2.start();
  assert.equal(s2.cancel().ok, true);
  assert.equal(s2.state().phase, 'cancelled');
});

test('observation: the interval is bounded and configurable per session', () => {
  const c = clock();
  assert.equal(createObservationSession({ now: c.now, intervalMs: 4999 }).reason, 'bad_interval');
  assert.equal(createObservationSession({ now: c.now, intervalMs: 600001 }).reason, 'bad_interval');
  assert.equal(createObservationSession({ now: c.now, intervalMs: '30000' }).reason, 'bad_interval');
  assert.equal(MIN_INTERVAL_MS, 5000);
  assert.equal(MAX_INTERVAL_MS, 600000);
  const s = createObservationSession({ now: c.now, intervalMs: 10000 });
  s.start();
  assert.equal(s.state().intervalMs, 10000);
  assert.equal(s.dueTick(), false);
  c.tick(9999);
  assert.equal(s.dueTick(), false);
  c.tick(1);
  assert.equal(s.dueTick(), true);
  assert.equal(s.markTicked().ok, true);
  assert.equal(s.dueTick(), false, 'the window resets only when the caller acknowledges');
});

test('observation: the default interval is 30 s and no timer of its own exists', () => {
  const c = clock();
  const s = createObservationSession({ now: c.now });
  s.start();
  assert.equal(s.state().intervalMs, 30000);
  assert.equal(s.dueTick(), false, 'reports only; the caller acts');
  c.tick(30000);
  assert.equal(s.dueTick(), true);
});

test('observation: admitted windows pass; own, sensitive and excluded titles refuse', () => {
  const c = clock();
  const s = createObservationSession({ now: c.now, exclusions: ['banking', 'term marks'] });
  assert.equal(s.admits('Notes.txt - Editor').reason, 'not_active', 'nothing is admitted without a session');
  s.start();
  assert.deepEqual(s.admits('Lecture slides - Slides'), { ok: true });
  assert.equal(s.admits('CompanionDesk').reason, 'own_window');
  assert.equal(s.admits('1Password').reason, 'sensitive');
  assert.equal(s.admits('Sign in - Google Accounts').reason, 'sensitive');
  assert.equal(s.admits('ACME Banking - Chrome').reason, 'excluded');
  assert.equal(s.admits('My Term Marks Sheet').reason, 'excluded');
  assert.equal(s.admits('').reason, 'bad_title');
  assert.equal(s.admits('x'.repeat(201)).reason, 'bad_title');
});

test('observation: exclusion matching is case-insensitive substring, capped list', () => {
  const c = clock();
  assert.equal(createObservationSession({ now: c.now, exclusions: 'not-a-list' }).reason, 'bad_exclusions');
  assert.equal(createObservationSession({ now: c.now, exclusions: [42] }).reason, 'bad_exclusions');
  assert.equal(createObservationSession({ now: c.now, exclusions: [''] }).reason, 'bad_exclusions');
  assert.equal(createObservationSession({ now: c.now, exclusions: ['x'.repeat(121)] }).reason, 'bad_exclusions');
  assert.equal(createObservationSession({ now: c.now, exclusions: Array.from({ length: 51 }, () => 'a') }).reason, 'bad_exclusions');
  const big = createObservationSession({ now: c.now, exclusions: Array.from({ length: MAX_EXCLUSIONS }, (_, i) => 'app ' + i) });
  assert.equal(big.ok !== false || big.start !== undefined, true);
  const s = createObservationSession({ now: c.now, exclusions: ['SPOTIFY'] });
  s.start();
  assert.equal(s.admits('Spotify - Music').reason, 'excluded');
  assert.equal(s.admits('Notepad').ok, true);
});

test('observation: the indicator is always visible while capturing, paused shown as paused', () => {
  const c = clock();
  const s = createObservationSession({ now: c.now });
  assert.deepEqual(s.indicator(), { visible: false, label: null });
  s.start();
  assert.equal(s.indicator().visible, true);
  assert.equal(s.indicator().label, 'Screen is being observed');
  s.pause();
  assert.equal(s.indicator().visible, true);
  assert.equal(s.indicator().label, 'Screen observation paused');
  s.resume();
  s.stop();
  assert.equal(s.indicator().visible, false);
});

test('observation: resumed sessions owe a full interval, not an instant tick', () => {
  const c = clock();
  const s = createObservationSession({ now: c.now, intervalMs: 10000 });
  s.start();
  c.tick(10000);
  assert.equal(s.dueTick(), true);
  s.pause();
  assert.equal(s.dueTick(), false, 'nothing ticks while paused');
  c.tick(60000);
  assert.equal(s.dueTick(), false);
  s.resume();
  assert.equal(s.dueTick(), false, 'resume restarts the window');
  c.tick(9999);
  assert.equal(s.dueTick(), false);
  c.tick(1);
  assert.equal(s.dueTick(), true);
});

test('observation: the module holds no pixels and the boundary constants are pinned', () => {
  assert.equal(LOCAL_ONLY, true);
  const c = clock();
  const s = createObservationSession({ now: c.now });
  s.start();
  const st = s.state();
  assert.equal(Object.isFrozen(st), true);
  assert.deepEqual(Object.keys(st).sort(), ['capturing', 'exclusionCount', 'intervalMs', 'lastTickedAt', 'phase', 'startedAt']);
  assert.equal(MAX_EXCLUSIONS, 50);
  // start() takes no argument: no pixels can ever be attached to a session
  assert.equal(s.start('raw-bytes').reason, 'already_active');
});
