'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWakeEvaluator, MEL_WINDOW, EVAL_EVERY } = require('../renderer/wake-eval.js');

test('evaluator fires only when the window is full and the cadence is met', () => {
  const ev = createWakeEvaluator();
  const frame = new Float32Array(32).fill(0.5);
  // 195 frames: window not full yet.
  let r;
  for (let i = 0; i < MEL_WINDOW - 1; i++) r = ev.pushFrames(frame);
  assert.strictEqual(r.due, false);
  // The 196th frame fills the window: due immediately.
  r = ev.pushFrames(frame);
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.input.length, MEL_WINDOW * 32);
  // Fewer than EVAL_EVERY new frames: not due again yet.
  for (let i = 0; i < EVAL_EVERY - 1; i++) r = ev.pushFrames(frame);
  assert.strictEqual(r.due, false);
  // One more frame makes 8 since the last evaluation.
  r = ev.pushFrames(frame);
  assert.strictEqual(r.due, true);
});

test('evaluator window is the newest 196 frames, oldest first', () => {
  const ev = createWakeEvaluator();
  const dues = [];
  for (let i = 0; i < MEL_WINDOW + 8; i++) {
    const f = new Float32Array(32);
    f[0] = i;
    const r = ev.pushFrames(f);
    if (r.due) dues.push({ at: i, input: r.input });
  }
  // First due when the 196th frame arrives: window is frames 0..195.
  assert.strictEqual(dues.length, 2);
  assert.strictEqual(dues[0].at, MEL_WINDOW - 1);
  assert.strictEqual(dues[0].input[0], 0);
  assert.strictEqual(dues[0].input[(MEL_WINDOW - 1) * 32], MEL_WINDOW - 1);
  // Second due after EVAL_EVERY more frames: window has slid to 8..203.
  assert.strictEqual(dues[1].at, MEL_WINDOW - 1 + EVAL_EVERY);
  assert.strictEqual(dues[1].input[0], EVAL_EVERY);
  assert.strictEqual(dues[1].input[(MEL_WINDOW - 1) * 32], MEL_WINDOW + 7);
  // Reset clears the ring; the next evaluation needs a full window again.
  ev.reset();
  let r;
  for (let i = 0; i < MEL_WINDOW - 1; i++) r = ev.pushFrames(new Float32Array(32));
  assert.strictEqual(r.due, false);
});
