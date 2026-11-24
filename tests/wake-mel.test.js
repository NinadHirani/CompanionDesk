'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The listener's log-mel must match the training pipeline's numpy reference
// value for value; the fixture pins the two together. If this test fails the
// app would be listening for the phrase on different features than the model
// was trained on, so this is a hard gate. The fixture's samples and expected
// values are both stored, generated once by the numpy reference with a
// deterministic LCG noise stream, so the test checks pure DSP equivalence.
const wakeMel = require('../renderer/wake-mel.js');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'wake-mel-fixture.json'), 'utf8'));

test('wake-mel matches the training-pipeline log-mel fixture', () => {
  const samples = new Float32Array(fixture.samples);
  const out = wakeMel.logmel(samples);
  assert.strictEqual(out.length, fixture.frames * wakeMel.N_MELS);
  const expected = fixture.expected.flat();
  let maxDiff = 0;
  for (let i = 0; i < out.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(out[i] - expected[i]));
  }
  assert.ok(maxDiff < 1e-3, `max abs diff ${maxDiff}`);
});

test('streaming mel equals batch mel chunk for chunk', () => {
  const n = 9000;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / wakeMel.SAMPLE_RATE)
      + 0.01 * (((i * 2654435761 >>> 8) % 1000) / 1000 - 0.5);
  }
  const batch = wakeMel.logmel(samples);
  const st = wakeMel.createStreamingLogmel();
  const streamed = [];
  const sizes = [317, 160, 1000, 137, 640, 2000, 53, 800];
  let off = 0, k = 0;
  while (off < n) {
    const len = Math.min(sizes[k++ % sizes.length], n - off);
    const fr = st.push(samples.subarray(off, off + len));
    for (let i = 0; i < fr.length; i++) streamed.push(fr[i]);
    off += len;
  }
  assert.strictEqual(streamed.length, batch.length);
  for (let i = 0; i < batch.length; i++) assert.strictEqual(streamed[i], batch[i]);
});
