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
