/**
 * M6 wake-validation harness (28 Nov 2026, owner-directed offline-safe
 * scope). A PURE evaluation layer for wake-activation DECISIONS over a
 * frame-score stream: it takes already-scored frames ({score, isWake})
 * and reports what a threshold policy would have decided. Nothing here
 * touches a microphone, a model, the wake settings, training or
 * provenance, and nothing activates the wake lane; the physical mic
 * validation stays excluded and remains the owner's.
 *
 * Decision policy (deliberately simple and fully specified):
 *   - a frame is HOT when score >= threshold;
 *   - an activation starts when minConsecutive consecutive HOT frames
 *     are seen and ends at the first COLD frame;
 *   - after an activation ends, new activations are suppressed for
 *     refractoryFrames frames;
 *   - an activation containing no wake-labelled frame is a false
 *     accept; a wake-labelled frame with score < threshold is a miss.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.wakeValidation = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createWakeValidation(config) {
    const c = Object.assign({}, config || {});
    const threshold = c.threshold === undefined ? 0.6 : c.threshold;
    const minConsecutive = c.minConsecutive === undefined ? 3 : c.minConsecutive;
    const refractoryFrames = c.refractoryFrames === undefined ? 20 : c.refractoryFrames;
    if (typeof threshold !== 'number' || !(threshold >= 0) || !(threshold <= 1)) {
      throw new Error('threshold must be a number between 0 and 1');
    }
    if (!Number.isInteger(minConsecutive) || minConsecutive < 1) {
      throw new Error('minConsecutive must be a positive integer');
    }
    if (!Number.isInteger(refractoryFrames) || refractoryFrames < 0) {
      throw new Error('refractoryFrames must be a non-negative integer');
    }

    function validate(frames) {
      if (!Array.isArray(frames)) throw new Error('frames must be an array');
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (!f || typeof f.score !== 'number' || !(f.score >= 0) || !(f.score <= 1) || typeof f.isWake !== 'boolean') {
          throw new Error('frame ' + i + ' must be {score: 0..1, isWake: boolean}');
        }
      }
      const activations = [];
      let falseAccepts = 0;
      let missedWakeFrames = 0;
      let latencies = [];
      let i = 0;
      let refractoryUntil = -1;
      while (i < frames.length) {
        if (frames[i].score >= threshold) {
          let j = i;
          while (j < frames.length && frames[j].score >= threshold) j++;
          const run = j - i;
          if (run >= minConsecutive && i > refractoryUntil) {
            let sawWake = false;
            let firstWake = -1;
            for (let k = i; k < j; k++) {
              if (frames[k].isWake) {
                sawWake = true;
                if (firstWake === -1) firstWake = k;
              }
            }
            activations.push({ startFrame: i, endFrame: j - 1, wakeInside: sawWake });
            if (sawWake && firstWake >= i) latencies.push(firstWake - i);
            if (!sawWake) falseAccepts++;
            refractoryUntil = (j - 1) + refractoryFrames;
          }
          i = j;
        } else {
          if (frames[i].isWake) missedWakeFrames++;
          i++;
        }
      }
      const meanLatency = latencies.length
        ? latencies.reduce(function (a, b) { return a + b; }, 0) / latencies.length
        : 0;
      return {
        threshold: threshold,
        minConsecutive: minConsecutive,
        refractoryFrames: refractoryFrames,
        activations: activations,
        falseAccepts: falseAccepts,
        missedWakeFrames: missedWakeFrames,
        meanLatencyFrames: meanLatency,
      };
    }

    return { validate: validate };
  }

  /** Deterministic LCG stream: noise frames below noiseMax, burst frames
   * in the wake band. Bursts start deterministically at the chunk
   * boundaries floor(frames/bursts) apart, so the same seed always
   * produces the same stream. */
  function syntheticStream(seed, opts) {
    const o = Object.assign({ frames: 500, bursts: 3, burstLen: 8, noiseMax: 0.3, wakeMin: 0.9 }, opts || {});
    let s = (seed >>> 0) || 1;
    function next() {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    }
    const frames = [];
    const chunk = o.bursts > 0 ? Math.floor(o.frames / o.bursts) : 0;
    let burstLeft = 0;
    for (let i = 0; i < o.frames; i++) {
      const r = next();
      if (burstLeft === 0 && chunk > 0 && i % chunk === 0 && Math.floor(i / chunk) < o.bursts) {
        burstLeft = o.burstLen;
      }
      if (burstLeft > 0) {
        burstLeft--;
        frames.push({ score: o.wakeMin + r * (1 - o.wakeMin), isWake: true });
      } else {
        frames.push({ score: o.noiseMax * r, isWake: false });
      }
    }
    return frames;
  }

  return { createWakeValidation: createWakeValidation, syntheticStream: syntheticStream };
});
