'use strict';

// Regression pin for the About view structure (m76): the wake session
// controls must be registered at module top level, NOT inside the
// settings-save click handler. When they sat inside the handler, the wake
// status line never loaded on open (desktop and web) and every Save click
// re-registered the four wake buttons, so one Start press fired one IPC
// call per prior save.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'about.js'), 'utf8');

test('about view: the settings-save handler closes before the wake session controls', () => {
  const saveClose = "msg.className = 'hint error'; }\n  });\n\n  // M6 slice 4:";
  assert.ok(src.includes(saveClose), 'the save handler closes right after its else branch');
});

test('about view: the wake controls block is not nested inside the save handler', () => {
  const nested = "if (F.wakeStatus) refreshWakeStatus();\n  });\n\n  // ---- provider status";
  assert.ok(!src.includes(nested), 'no stray handler close after the wake init call');
  const initCall = '  if (F.wakeStatus) refreshWakeStatus();\n\n  // ---- provider status';
  assert.ok(src.includes(initCall), 'the wake status loads at module init, not on Save');
});

// M8 customization: the companion float toggle. It must live in the Quick
// overlay card, be wired at module top level (the m76 lesson), save the
// settings key, revert on a refused save, and stay hidden on the web build
// where no companion window exists.
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

test('about view: the float toggle exists in the Quick overlay card', () => {
  assert.ok(html.includes('id="ov-always-top"'), 'the checkbox exists');
  const card = html.slice(html.indexOf('Quick overlay'), html.indexOf('ov-msg'));
  assert.ok(card.includes('ov-always-top'), 'the checkbox sits inside the Quick overlay card');
  assert.ok(card.includes('Keep the companion above other windows'), 'the label says what it does');
});

test('about view: the float toggle is wired at module level, saves the key, reverts on refusal, hides on web', () => {
  assert.ok(src.includes("getElementById('ov-always-top')"), 'about.js wires the checkbox');
  assert.ok(src.includes('companion_always_on_top: ovTop.checked'), 'the change saves the settings key');
  assert.ok(src.includes("bridgeMode === 'web'") && src.includes("ovTop.closest('label').hidden = true"), 'the web build hides the control');
  assert.ok(src.includes('ovTop.checked = !ovTop.checked'), 'a refused save reverts the checkbox instead of lying');
  assert.ok(src.includes('set.settings.companion_always_on_top !== false'), 'refresh() fills the checkbox from stored settings');
});
