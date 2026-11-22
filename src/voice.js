'use strict';

// Voice service: validates a recording, gates out silence, trims it, and hands
// it to whisper. The recording is 16 kHz mono Int16 PCM sent by the overlay.

const { hasSpeech, trimSilence } = require('./vad');
const whisper = require('./whisper');

const SAMPLE_RATE = 16000;
const MAX_SECONDS = 30;
const MAX_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS;
const MIN_BYTES = SAMPLE_RATE * 2 * 0.3;

function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

function status({ find = whisper.findWhisper, modelsDir } = {}) {
  const w = find({ modelsDir });
  return w.available ? { ok: true, available: true } : { ok: true, available: false, reason: w.reason };
}

// payload: { pcm: bytes }. deps lets tests substitute the finder and transcriber.
async function transcribe(payload, { modelsDir, find = whisper.findWhisper, run = whisper.transcribe, language = 'en' } = {}) {
  const buf = payload ? toBuffer(payload.pcm) : null;
  if (!buf || buf.length % 2 !== 0) return { ok: false, error: 'bad_request' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'too_long' };
  if (buf.length < MIN_BYTES) return { ok: false, error: 'no_speech' };

  const w = find({ modelsDir });
  if (!w.available) return { ok: false, error: 'voice_unavailable', reason: w.reason };

  const samples = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  if (!hasSpeech(samples, SAMPLE_RATE)) return { ok: false, error: 'no_speech' };
  const trimmed = trimSilence(samples, SAMPLE_RATE);

  try {
    const text = await run({ pcm: Buffer.from(trimmed.buffer, trimmed.byteOffset, trimmed.byteLength), bin: w.bin, model: w.model, language });
    return text ? { ok: true, text } : { ok: false, error: 'no_speech' };
  } catch {
    return { ok: false, error: 'transcribe_failed' };
  }
}

module.exports = { status, transcribe, SAMPLE_RATE, MAX_BYTES };
