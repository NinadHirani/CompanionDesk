'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  parseSavedBounds, restoreBounds, captureBounds, MIN_WIDTH, MIN_HEIGHT,
} = require('../src/companion-window-state');

const WA = { x: 0, y: 0, width: 1440, height: 900 };
const good = { x: 10, y: 20, width: 560, height: 420 };

test('a well-formed saved bounds round-trips through JSON', () => {
  assert.deepEqual(parseSavedBounds(JSON.stringify(good)), good);
  assert.deepEqual(parseSavedBounds(good), good);
});

test('malformed saved bounds are refused, never coerced', () => {
  const bads = [
    null, undefined, 42, true, 'not json', '{', '[]', [],
    {},
    { x: 1, y: 2, width: 3 },
    { ...good, extra: 1 },
    { ...good, x: 1.5 },
    { ...good, x: '10' },
    { ...good, x: NaN },
    { ...good, x: Infinity },
    { ...good, width: MIN_WIDTH - 1 },
    { ...good, height: MIN_HEIGHT - 1 },
    { ...good, width: 99999 },
    { ...good, y: 200000 },
    { ...good, width: 560.5 },
  ];
  for (const bad of bads) assert.equal(parseSavedBounds(bad), null, JSON.stringify(bad));
});

test('a 200-char cap stops an absurd blob from being parsed', () => {
  const padded = JSON.stringify(good) + ' '.repeat(200);
  assert.equal(parseSavedBounds(padded), null);
});

test('restore keeps an on-screen window where the user left it', () => {
  assert.deepEqual(restoreBounds(JSON.stringify(good), [WA]), good);
  assert.deepEqual(restoreBounds(good, [WA]), good);
});

test('a partially off-screen window is clamped fully inside its work area', () => {
  assert.deepEqual(
    restoreBounds({ x: -200, y: 800, width: 560, height: 420 }, [WA]),
    { x: 0, y: 480, width: 560, height: 420 },
  );
});

test('a window bigger than the work area shrinks to fit, never below the minimum', () => {
  assert.deepEqual(
    restoreBounds({ x: 0, y: 0, width: 4000, height: 4000 }, [WA]),
    { x: 0, y: 0, width: 1440, height: 900 },
  );
  assert.deepEqual(
    restoreBounds({ x: 0, y: 0, width: 4000, height: 4000 }, [{ x: 0, y: 0, width: 200, height: 100 }]),
    { x: 0, y: 0, width: 200, height: 100 },
  );
});

test('a window left on an unplugged monitor comes back on the nearest display', () => {
  const a = { x: 0, y: 0, width: 1920, height: 1080 };
  const b = { x: 1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(
    restoreBounds({ x: 5000, y: 100, width: 560, height: 420 }, [a, b]),
    { x: 3280, y: 100, width: 560, height: 420 },
  );
});

test('the display with the largest overlap wins for a straddling rect', () => {
  const a = { x: 0, y: 0, width: 1000, height: 800 };
  const b = { x: 1000, y: 0, width: 1000, height: 800 };
  assert.deepEqual(
    restoreBounds({ x: 900, y: 0, width: 560, height: 420 }, [a, b]),
    { x: 1000, y: 0, width: 560, height: 420 },
  );
});

test('restore fails closed without displays, without a rect, or with unusable displays', () => {
  assert.equal(restoreBounds(good, []), null);
  assert.equal(restoreBounds(good, null), null);
  assert.equal(restoreBounds(null, [WA]), null);
  assert.equal(restoreBounds('{}', [WA]), null);
  assert.equal(restoreBounds(good, [{ x: 0, y: 0, width: 0, height: 0 }]), null);
});

test('captureBounds sanitizes a live placement for saving', () => {
  assert.deepEqual(
    captureBounds({ x: 12.4, y: -3, width: 560.9, height: 420 }),
    { x: 12, y: -3, width: 561, height: 420 },
  );
  assert.equal(captureBounds({ x: 0, y: 0, width: 10, height: 10 }), null);
  assert.equal(captureBounds(null), null);
  assert.equal(captureBounds({}), null);
  assert.equal(captureBounds({ x: '12', y: 0, width: 560, height: 420 }), null);
});

test('a captured placement restores identically on the same display', () => {
  const saved = captureBounds({ x: 12.4, y: 100, width: 560.9, height: 420 });
  assert.deepEqual(restoreBounds(JSON.stringify(saved), [WA]), saved);
});
