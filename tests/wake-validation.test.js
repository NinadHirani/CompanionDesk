'use strict';

// M6 wake-validation slice (28 Nov 2026, owner-directed offline-safe
// scope): a pure evaluation harness for wake-activation DECISIONS over a
// frame-score stream. Nothing here touches a microphone, a model, the
// wake settings, training or provenance, and nothing activates the wake
// lane: the module takes an array of {score, isWake} frames and reports
// what a threshold policy would have decided. Synthetic streams come
// from a deterministic LCG so every run is reproducible. Physical mic
// validation stays excluded and remains the owner's.

const test = require('node:test');
const assert = require('node:assert');
const { createWakeValidation, syntheticStream } = require('../src/wake-validation.js');

test('a clean synthetic stream yields one activation per burst with no misses', () => {
  const v = createWakeValidation({ threshold: 0.6, minConsecutive: 3, refractoryFrames: 20 });
  const frames = syntheticStream(42, { frames: 1000, bursts: 5, burstLen: 8, noiseMax: 0.3, wakeMin: 0.9 });
  const report = v.validate(frames);
  assert.equal(report.activations.length, 5, 'one activation per burst');
  assert.equal(report.falseAccepts, 0);
  assert.equal(report.missedWakeFrames, 0);
  assert.ok(report.activations.every((a) => a.endFrame > a.startFrame));
});

test('a threshold above the noise floor but below the wake band passes the noise test', () => {
  const v = createWakeValidation({ threshold: 0.5, minConsecutive: 3, refractoryFrames: 5 });
  const frames = syntheticStream(7, { frames: 500, bursts: 0, noiseMax: 0.4, wakeMin: 0.9 });
  const report = v.validate(frames);
  assert.equal(report.activations.length, 0, 'noise below threshold never activates');
  assert.equal(report.falseAccepts, 0);
});

test('a too-low threshold produces false accepts the report must count', () => {
  const v = createWakeValidation({ threshold: 0.1, minConsecutive: 3, refractoryFrames: 5 });
  const frames = syntheticStream(7, { frames: 500, bursts: 0, noiseMax: 0.4, wakeMin: 0.9 });
  const report = v.validate(frames);
  assert.ok(report.activations.length > 0, 'noise crosses the too-low threshold');
  assert.equal(report.falseAccepts, report.activations.length, 'every activation without a wake frame is a false accept');
});

test('a too-high threshold misses the wake band and the report counts the misses', () => {
  const v = createWakeValidation({ threshold: 1, minConsecutive: 3, refractoryFrames: 5 });
  const frames = syntheticStream(3, { frames: 500, bursts: 4, burstLen: 8, noiseMax: 0.3, wakeMin: 0.9 });
  const report = v.validate(frames);
  assert.equal(report.activations.length, 0);
  assert.ok(report.missedWakeFrames > 0, 'burst frames below the too-high threshold are missed');
  assert.equal(frames.filter(function (f) { return f.isWake; }).length, report.missedWakeFrames, 'every wake frame is accounted for');
});

test('the same seed produces an identical report, byte for byte', () => {
  const framesA = syntheticStream(11, { frames: 400, bursts: 3, burstLen: 6, noiseMax: 0.3, wakeMin: 0.9 });
  const framesB = syntheticStream(11, { frames: 400, bursts: 3, burstLen: 6, noiseMax: 0.3, wakeMin: 0.9 });
  assert.deepEqual(framesA, framesB);
  const reportA = createWakeValidation().validate(framesA);
  const reportB = createWakeValidation().validate(framesB);
  assert.deepEqual(reportA, reportB);
});

test('malformed input refuses honestly instead of guessing', () => {
  const v = createWakeValidation();
  assert.throws(() => v.validate(null), /frames must be an array/);
  assert.throws(() => v.validate([{ score: 'high' }]), /frame 0/);
  assert.throws(() => v.validate([{ score: 0.9 }]), /frame 0/);
  assert.throws(() => createWakeValidation({ threshold: 'low' }), /threshold/);
  assert.throws(() => createWakeValidation({ minConsecutive: 0 }), /minConsecutive/);
});
