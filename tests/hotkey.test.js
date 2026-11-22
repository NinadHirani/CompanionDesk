'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalize, DEFAULT_HOTKEY } = require('../src/hotkey');
const { overlayBounds } = require('../src/overlay-layout');

test('the default hotkey is itself valid and canonical', () => {
  assert.deepEqual(normalize(DEFAULT_HOTKEY), { ok: true, value: DEFAULT_HOTKEY });
});

test('valid shortcuts are canonicalised: case, aliases, modifier order', () => {
  const cases = [
    ['cmdorctrl+shift+space', 'CommandOrControl+Shift+Space'],
    ['Shift+Ctrl+k', 'Control+Shift+K'],
    ['option+j', 'Alt+J'],
    ['ctrl + alt + f12', 'Control+Alt+F12'],
    ['Super+/', 'Super+/'],
    ['Command+Shift+1', 'Command+Shift+1'],
  ];
  for (const [input, want] of cases) assert.deepEqual(normalize(input), { ok: true, value: want }, input);
});

test('a global shortcut needs a real modifier', () => {
  assert.equal(normalize('Shift+A').error, 'needs_modifier');
  assert.equal(normalize('A').error, 'invalid_hotkey');
  assert.equal(normalize('Space').error, 'invalid_hotkey');
});

test('common editing and window shortcuts are refused', () => {
  for (const s of ['CommandOrControl+C', 'cmdorctrl+v', 'CommandOrControl+Q', 'CommandOrControl+W', 'Alt+F4']) {
    assert.equal(normalize(s).error, 'reserved_hotkey', s);
  }
  // With another modifier added it is a different shortcut and is allowed.
  assert.equal(normalize('CommandOrControl+Shift+C').ok, true);
});

test('malformed input is refused, never passed to the OS', () => {
  for (const bad of ['', '   ', '+', 'Ctrl+', '+K', 'Ctrl++K', 'Ctrl+Ctrl+K', 'Hyper+K', 'Ctrl+KK', 'Ctrl+Esc', 'Ctrl+F25', 'Ctrl+Shift+Alt+Super+Command+K', null, undefined, 5, {}, 'x'.repeat(100)]) {
    assert.equal(normalize(bad).ok, false, String(bad));
  }
});

test('overlay placement: centered near the top, always inside the work area', () => {
  const b = overlayBounds({ x: 0, y: 25, width: 1440, height: 875 });
  assert.deepEqual(b, { x: 440, y: 148, width: 560, height: 420 });

  // A second monitor to the right keeps its own offset.
  assert.equal(overlayBounds({ x: 1440, y: 0, width: 1920, height: 1080 }).x, 1440 + (1920 - 560) / 2);

  // A tiny work area shrinks the window instead of overflowing.
  const small = overlayBounds({ x: 0, y: 0, width: 400, height: 300 });
  assert.ok(small.x >= 0 && small.y >= 0 && small.x + small.width <= 400 && small.y + small.height <= 300, JSON.stringify(small));
});
