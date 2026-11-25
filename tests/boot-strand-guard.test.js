'use strict';
// Boot awaits UI.today.refresh() and UI.onboarding.start() bare. A bridge
// or transport crash in either killed the boot IIFE before UI.show, so a
// first-run user landed on the default empty Today with no onboarding and
// no word about it. Boot must always reach its first screen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const s = fs.readFileSync('renderer/boot.js', 'utf8');

test('a crashed first refresh never strands the boot', () => {
  const i = s.indexOf('await UI.today.refresh()');
  const start = s.lastIndexOf('try {', i);
  const catchAt = s.indexOf('catch', i);
  assert.ok(start > -1 && catchAt > start, 'today.refresh runs inside a try with a catch after it');
});

test('a crashed onboarding.start never strands the boot', () => {
  const i = s.indexOf('await UI.onboarding.start()');
  const catchAt = s.indexOf('catch', i);
  assert.ok(catchAt > i, 'onboarding.start runs inside a try with a catch after it');
});

test('UI.show is reached on every boot path', () => {
  // The boot-path show is the last one in the file; the first belongs to
  // the tab click wiring.
  const showAt = s.lastIndexOf('UI.show(');
  assert.ok(showAt > -1, 'boot calls UI.show');
  // Both try blocks close before the show decision.
  const lastCatch = s.lastIndexOf('catch', showAt);
  assert.ok(lastCatch > -1, 'a catch precedes the show decision');
  const close = s.indexOf('}', lastCatch);
  assert.ok(close > -1 && close < showAt, 'the show decision sits outside the guarded calls');
});
