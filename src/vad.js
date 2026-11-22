'use strict';

// A simple energy gate: decides whether a recording contains speech at all, so
// silence never reaches the transcriber, and trims dead air to make it faster.
// Pure maths on Int16 samples; no model.

const FRAME_MS = 30;
const MIN_SPEECH_MS = 300;

function rmsOfFrame(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) { const v = samples[i] / 32768; sum += v * v; }
  return Math.sqrt(sum / Math.max(1, to - from));
}

// -> { voiced: boolean[] per frame, frameSize, voicedMs }
function analyze(samples, sampleRate = 16000, { threshold = 0.012 } = {}) {
  const frameSize = Math.round((sampleRate * FRAME_MS) / 1000);
  const voiced = [];
  for (let i = 0; i + frameSize <= samples.length; i += frameSize) {
    voiced.push(rmsOfFrame(samples, i, i + frameSize) > threshold);
  }
  return { voiced, frameSize, voicedMs: voiced.filter(Boolean).length * FRAME_MS };
}

function hasSpeech(samples, sampleRate = 16000, opts) {
  return analyze(samples, sampleRate, opts).voicedMs >= MIN_SPEECH_MS;
}

// Keep the spoken part plus a little padding either side.
function trimSilence(samples, sampleRate = 16000, { padMs = 200, threshold } = {}) {
  const { voiced, frameSize } = analyze(samples, sampleRate, { threshold });
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  if (first === -1) return samples.slice(0, 0);
  const pad = Math.round((sampleRate * padMs) / 1000);
  const start = Math.max(0, first * frameSize - pad);
  const end = Math.min(samples.length, (last + 1) * frameSize + pad);
  return samples.slice(start, end);
}

module.exports = { analyze, hasSpeech, trimSilence, FRAME_MS, MIN_SPEECH_MS };
