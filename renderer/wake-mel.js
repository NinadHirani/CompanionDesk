'use strict';

// Streaming log-mel feature front end for the wake word listener (slice 5).
// Dual-mode (plain script in the page, require() in tests), like pcm.js.
//
// This is the canonical DSP the trained wake model expects. It is pinned,
// value for value, to the numpy reference in scripts/wake/train_wake_model.py
// (verified 24 Nov 2026 against Google's speech_embedding module's internal
// log-mel tensor, max abs diff < 0.001; see docs/WAKE_PROVENANCE.md):
//   16 kHz audio, periodic hann window of 400 samples, hop 160, FFT length
//   512, MAGNITUDE spectrum, mel filterbank built in the htk mel domain
//   (1127*log10(1+f/700)) with triangular weights over bin frequencies, no
//   slaney normalization, fmin 60 Hz, fmax 3800 Hz, natural log of the mel
//   clipped at 1e-10. One frame per 10 ms.
//
// No network, no dependencies, no allocation-heavy math in the hot path
// beyond the per-frame FFT buffer. The page that uses this must not retain
// audio: the caller keeps ownership of the samples and the result.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionWakeMel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SAMPLE_RATE = 16000;
  const WIN = 400;          // window length in samples
  const HOP = 160;          // 10 ms
  const FFT_N = 512;        // fft length (257 rfft bins)
  const N_MELS = 32;
  const MEL_FMIN = 60.0;
  const MEL_FMAX = 3800.0;
  const MEL_FLOOR = 1e-10;

  // Periodic hann: 0.5 - 0.5*cos(2*pi*n/N).
  const WINDOW = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);

  // tf.signal.linear_to_mel_weight_matrix-style filterbank.
  function hzToMel(f) { return 1127.0 * Math.log10(1.0 + f / 700.0); }
  function melToHz(m) { return 700.0 * (Math.pow(10, m / 1127.0) - 1.0); }

  const melEdges = [];
  for (let i = 0; i < N_MELS + 2; i++) {
    melEdges.push(melToHz(hzToMel(MEL_FMIN) + (hzToMel(MEL_FMAX) - hzToMel(MEL_FMIN)) * (i / (N_MELS + 1))));
  }
  const NBINS = FFT_N / 2 + 1; // 257
  const FILTERBANK = new Float64Array(N_MELS * NBINS);
  for (let m = 0; m < N_MELS; m++) {
    const lo = hzToMel(melEdges[m]), ce = hzToMel(melEdges[m + 1]), hi = hzToMel(melEdges[m + 2]);
    for (let b = 0; b < NBINS; b++) {
      const fMel = hzToMel((b * SAMPLE_RATE) / FFT_N);
      const lower = (fMel - lo) / (ce - lo);
      const upper = (hi - fMel) / (hi - ce);
      const w = Math.max(0.0, Math.min(lower, upper));
      FILTERBANK[m * NBINS + b] = w;
    }
  }

  // Iterative radix-2 in-place complex FFT (n a power of two).
  const FFT_RE = new Float64Array(FFT_N);
  const FFT_IM = new Float64Array(FFT_N);
  const BITREV = new Uint32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) {
    let r = 0, x = i;
    for (let b = 0; b < 9; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    BITREV[i] = r;
  }
  function fft512() {
    for (let i = 0; i < FFT_N; i++) {
      const j = BITREV[i];
      if (j > i) {
        let t = FFT_RE[i]; FFT_RE[i] = FFT_RE[j]; FFT_RE[j] = t;
        t = FFT_IM[i]; FFT_IM[i] = FFT_IM[j]; FFT_IM[j] = t;
      }
    }
    for (let len = 2; len <= FFT_N; len <<= 1) {
      const step = (2 * Math.PI) / len;
      for (let i = 0; i < FFT_N; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const ang = step * k;
          const wr = Math.cos(ang), wi = -Math.sin(ang);
          const ur = FFT_RE[i + k], ui = FFT_IM[i + k];
          const vr = FFT_RE[i + k + len / 2] * wr - FFT_IM[i + k + len / 2] * wi;
          const vi = FFT_RE[i + k + len / 2] * wi + FFT_IM[i + k + len / 2] * wr;
          FFT_RE[i + k] = ur + vr; FFT_IM[i + k] = ui + vi;
          FFT_RE[i + k + len / 2] = ur - vr; FFT_IM[i + k + len / 2] = ui - vi;
        }
      }
    }
  }

  // Float32Array samples (16 kHz, mono) -> Float32Array [frames * 32],
  // row-major (frame 0's 32 bins, then frame 1's, ...). Frames are
  // non-overlapping-edge windows taken center=False, exactly as training.
  function logmel(samples) {
    const n = samples.length;
    const frames = n < WIN ? 1 : 1 + Math.floor((n - WIN) / HOP);
    const out = new Float32Array(frames * N_MELS);
    const frame = new Float64Array(WIN);
    for (let f = 0; f < frames; f++) {
      const off = f * HOP;
      let energy = 0;
      for (let i = 0; i < WIN; i++) {
        const s = off + i < n ? samples[off + i] : 0;
        const w = s * WINDOW[i];
        frame[i] = w;
        energy += w * w;
      }
      if (energy < 1e-16) {
        for (let m = 0; m < N_MELS; m++) out[f * N_MELS + m] = Math.log(MEL_FLOOR);
        continue;
      }
      for (let i = 0; i < WIN; i++) { FFT_RE[i] = frame[i]; FFT_IM[i] = 0; }
      for (let i = WIN; i < FFT_N; i++) { FFT_RE[i] = 0; FFT_IM[i] = 0; }
      fft512();
      for (let m = 0; m < N_MELS; m++) {
        let sum = 0;
        const base = m * NBINS;
        for (let b = 0; b < NBINS; b++) {
          const re = FFT_RE[b], im = FFT_IM[b];
          const mag = Math.sqrt(re * re + im * im);
          sum += FILTERBANK[base + b] * mag;
        }
        out[f * N_MELS + m] = Math.log(Math.max(sum, MEL_FLOOR));
      }
    }
    return out;
  }

  // Streaming front end: push raw samples as they arrive, get the new
  // log-mel frames (Float32Array, newest frame last, same row-major layout
  // as logmel). Produces EXACTLY the same frames as calling logmel() on the
  // concatenation of everything pushed so far, so the listener's features
  // are the training features by construction. The ring of recent frames is
  // owned by the caller via snapshot(); no audio is retained beyond the
  // 400-sample tail needed for the next boundary frame.
  function createStreamingLogmel() {
    let pending = new Float32Array(0);
    let pendingStart = 0; // absolute sample index of pending[0]; invariant: pendingStart === frames * HOP
    let frames = 0;
    const frameBuf = new Float64Array(WIN);
    function emitFrame(frame, out, f) {
      let energy = 0;
      for (let i = 0; i < WIN; i++) energy += frame[i] * frame[i];
      if (energy < 1e-16) {
        for (let m = 0; m < N_MELS; m++) out[f * N_MELS + m] = Math.log(MEL_FLOOR);
        return;
      }
      for (let i = 0; i < FFT_N; i++) { FFT_RE[i] = 0; FFT_IM[i] = 0; }
      for (let i = 0; i < WIN; i++) FFT_RE[i] = frame[i];
      fft512();
      for (let m = 0; m < N_MELS; m++) {
        let sum = 0;
        const base = m * NBINS;
        for (let b = 0; b < NBINS; b++) {
          const re = FFT_RE[b], im = FFT_IM[b];
          sum += FILTERBANK[base + b] * Math.sqrt(re * re + im * im);
        }
        out[f * N_MELS + m] = Math.log(Math.max(sum, MEL_FLOOR));
      }
    }
    function push(samples) {
      const joined = new Float32Array(pending.length + samples.length);
      joined.set(pending, 0); joined.set(samples, pending.length);
      pending = joined;
      const totalAbs = pendingStart + joined.length;
      let count = 0;
      while ((frames + count) * HOP + WIN <= totalAbs) count++;
      const out = new Float32Array(count * N_MELS);
      for (let j = 0; j < count; j++) {
        const abs = (frames + j) * HOP;
        for (let i = 0; i < WIN; i++) {
          frameBuf[i] = joined[abs + i - pendingStart] * WINDOW[i];
        }
        emitFrame(frameBuf, out, j);
      }
      const drop = count * HOP;
      if (drop > 0) pending = joined.slice(drop);
      pendingStart += drop;
      frames += count;
      return out;
    }
    function framesSoFar() { return frames; }
    return { push, framesSoFar };
  }

  return { logmel, createStreamingLogmel, SAMPLE_RATE, WIN, HOP, FFT_N, N_MELS };
});
