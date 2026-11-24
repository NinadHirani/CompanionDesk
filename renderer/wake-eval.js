'use strict';

// Pure evaluation policy for the wake listener (M6 slice 5): collects mel
// frames into the exact window the trained model expects, and says WHEN an
// evaluation is due and WHAT to feed the models. No Electron, no audio, no
// ONNX: the listener page drives it, tests run it headless. The window and
// cadence constants match the training pipeline (196-frame mel window, one
// embedding per 8 frames, 16-step head window) and must never drift.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionWakeEval = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MEL_WINDOW = 196; // mel frames per evaluation window (~1.96 s)
  const OUT_STEPS = 16;   // embeddings consumed by the head (1.28 s)
  const EMBED_STRIDE = 8; // one embedding per 8 mel frames (80 ms)
  const EVAL_EVERY = 8;   // re-score after every 8 new frames (80 ms)

  function createWakeEvaluator() {
    let ring = [];           // latest frames, each Float32Array(32) or number[]
    let ringFrames = 0;
    let evalsSinceScore = 0;

    function pushFrames(mel) {
      // mel: Float32Array of whole frames (32 values each), newest last.
      const newFrames = mel.length / 32;
      if (!Number.isInteger(newFrames) || newFrames < 1) return { due: false };
      for (let f = 0; f < newFrames; f++) ring.push(mel.slice(f * 32, (f + 1) * 32));
      ringFrames += newFrames;
      while (ringFrames > MEL_WINDOW) { ring.shift(); ringFrames--; }
      evalsSinceScore += newFrames;
      if (ringFrames < MEL_WINDOW || evalsSinceScore < EVAL_EVERY) return { due: false };
      evalsSinceScore = 0;
      // Assemble the model input: [MEL_WINDOW, 32], oldest frame first,
      // row-major, exactly the layout the converted embedding expects.
      const input = new Float32Array(MEL_WINDOW * 32);
      let o = 0;
      for (let i = 0; i < MEL_WINDOW; i++) {
        const fr = ring[i];
        for (let m = 0; m < 32; m++) input[o++] = fr[m];
      }
      return { due: true, input };
    }

    function reset() {
      ring = []; ringFrames = 0; evalsSinceScore = 0;
    }

    return { pushFrames, reset };
  }

  return { createWakeEvaluator, MEL_WINDOW, OUT_STEPS, EMBED_STRIDE, EVAL_EVERY };
});
